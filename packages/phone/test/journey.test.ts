// The phone-only journey as an app runs it: the person signs in to their own account on the phone (device code against
// the stand-in OpenAI, or their own per-use key on a loopback OpenAI-compatible stand-in), chats with an agent that uses
// the app's tools, the phone kills the app mid-tool, and the reopened chat finishes on Try again without running the
// cut-off tool twice. No account, no network beyond loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Accounts, memoryStore, portable, type Api, type Model } from '@byokit/accounts';
import { withKeys } from '@byokit/accounts/keys';
import { mockOpenAI } from '@byokit/accounts/testing';
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };
import { memoryLog, PhoneError, PhoneSession, WORDS, type PhoneTool } from '../src/index.ts';

async function signedIn(t: { after(fn: () => unknown): void }) {
  const openai = await mockOpenAI();
  t.after(() => openai.close());
  const accounts = new Accounts({ authBase: openai.base, apiBase: openai.base, store: () => memoryStore() }, portable);
  const shown = (await accounts.login('Umer', 'chatgpt'))!;
  openai.approve(shown.code!);
  await accounts.finished('Umer', 'chatgpt');
  return { openai, accounts, asked: () => openai.state.requests.filter((r) => r.path === '/codex/responses') };
}

/** A tool whose run the test holds open, as a slow write on the phone would be. */
function heldTool(replaySafe: boolean) {
  const runs: string[] = [];
  let started!: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const tool: PhoneTool = {
    name: 'save_note', description: 'Save a note on this phone.', replaySafe,
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    run: (args, call) => {
      runs.push(call.callId);
      if (runs.length > 1) return Promise.resolve('Saved again.');
      started();
      return new Promise((_, no) => call.signal?.addEventListener('abort', () => no(call.signal!.reason)));
    },
  };
  return { tool, runs, running };
}

test('a ChatGPT plan answers on the phone, labelled as the plan, with the app tool and a retried tap sent once', async (t) => {
  const { accounts, asked } = await signedIn(t);
  const ran: unknown[] = [];
  const tool: PhoneTool = { name: 'save_note', description: 'Save a note on this phone.',
    parameters: { type: 'object', properties: { input: { type: 'string' } } },
    run: async (args) => { ran.push(args); return 'note saved'; } };
  const session = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt', instructions: 'You run on a phone.', tools: [tool], log: memoryLog() });

  assert.deepEqual(await session.account(), { id: 'chatgpt', name: 'ChatGPT', billing: 'subscription', words: 'Uses your ChatGPT plan.', signedIn: true });
  assert.equal(session.status, 'idle');
  const streamed: string[] = [];
  const turn = await session.send('remember the milk', { requestId: 'r1', onText: (a) => streamed.push(a) });
  assert.equal(turn.state, 'done');
  assert.equal(turn.answer, 'You did: note saved');
  assert.deepEqual(ran, [{ input: 'remember the milk' }]);
  assert.deepEqual(turn.tools, [{ callId: 'call_1', name: 'save_note', state: 'done' }]);
  assert.equal(streamed.at(-1), 'You did: note saved');
  assert.equal(asked().length, 2, 'one call for the tool, one for the answer');

  const again = await session.send('remember the milk', { requestId: 'r1' });
  assert.equal(again.state, 'done');
  assert.equal(asked().length, 2, 'the same request id is never sent twice');

  const next = await session.send('and eggs', { requestId: 'r2' });
  const input = JSON.parse(asked().at(-2)!.body).input;
  assert.deepEqual(input.slice(0, 2), [{ role: 'user', content: [{ type: 'input_text', text: 'remember the milk' }] }, { role: 'assistant', content: 'You did: note saved' }],
    'earlier turns go along as their words');
  assert.equal(next.state, 'done');
});

test('killed mid-tool, the reopened chat waits for Try again and never reruns a tool that is not replay safe', async (t) => {
  const { accounts, asked } = await signedIn(t);
  const log = memoryLog();
  const held = heldTool(false);
  const o = { accounts, member: 'Umer', account: 'chatgpt', instructions: 'You run on a phone.', tools: [held.tool], log };
  const first = await PhoneSession.open(o);
  const kill = new AbortController();
  const sent = first.send('remember the milk', { requestId: 'r1', signal: kill.signal });
  await held.running;
  assert.equal(first.status, 'working');
  kill.abort(new Error('app killed'));
  await assert.rejects(sent, /app killed/);

  const reopened = await PhoneSession.open(o);
  const [cut] = reopened.turns;
  assert.equal(cut.state, 'interrupted');
  assert.equal(cut.words, WORDS['phone.interrupted']);
  assert.deepEqual(cut.tools, [{ callId: 'call_1', name: 'save_note', state: 'interrupted' }]);
  assert.equal(reopened.status, 'blocked');
  assert.equal(asked().length, 1);

  const finished = await reopened.resume('r1');
  assert.equal(finished.state, 'done');
  assert.deepEqual(held.runs, ['call_1'], 'the cut-off tool ran once, never again');
  assert.match(finished.answer, /^You did: The app closed while this tool was running\. It may or may not have acted/);
  assert.equal(reopened.status, 'idle');
  assert.equal(asked().length, 2, 'Try again asks only for the rest of the turn');
});

test('a replay-safe tool cut off mid-run runs again on Try again, under the same call id', async (t) => {
  const { accounts } = await signedIn(t);
  const log = memoryLog();
  const held = heldTool(true);
  const o = { accounts, member: 'Umer', account: 'chatgpt', instructions: 'You run on a phone.', tools: [held.tool], log };
  const kill = new AbortController();
  const sent = (await PhoneSession.open(o)).send('remember the milk', { requestId: 'r1', signal: kill.signal });
  await held.running;
  kill.abort(new Error('app killed'));
  await assert.rejects(sent);
  const line = (await log.read()).pop()!;
  await log.append(line.slice(0, 9)); // the phone died while writing a line: it is skipped on open

  const finished = await (await PhoneSession.open(o)).resume('r1');
  assert.deepEqual(held.runs, ['call_1', 'call_1']);
  assert.equal(finished.answer, 'You did: Saved again.');
});

test('a limit ends the turn with its words and never moves to another account', async (t) => {
  const { openai, accounts, asked } = await signedIn(t);
  const session = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt', instructions: 'Be brief.', log: memoryLog() });
  openai.state.fail = { status: 429, body: JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached', resets_in_seconds: 600 } }) };
  const turn = await session.send('plan my day', { requestId: 'r1' });
  assert.equal(turn.state, 'failed');
  assert.equal(turn.code, 'rate-limited');
  assert.equal(turn.words, 'This account has reached its limit for now. Try again later.');
  assert.equal(asked().length, 1, 'no second account was asked');
  assert.equal(session.status, 'idle');

  const later = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt.someone-else', instructions: 'Be brief.', log: memoryLog() });
  assert.equal((await later.account()).signedIn, false);
  assert.equal((await later.send('hello')).code, 'signed-out');
  assert.equal(asked().length, 1);
});

test('one turn at a time, and every sentence is plain', async (t) => {
  const { accounts } = await signedIn(t);
  const held = heldTool(false);
  const session = await PhoneSession.open({ accounts, member: 'Umer', account: 'chatgpt', instructions: 'Be brief.', tools: [held.tool], log: memoryLog() });
  const stop = new AbortController();
  const sent = session.send('one', { signal: stop.signal });
  await assert.rejects(session.send('two'), (e) => e instanceof PhoneError && e.code === 'busy', 'busy before its first line is kept');
  await held.running;
  await assert.rejects(session.send('two'), (e) => e instanceof PhoneError && e.code === 'busy');
  stop.abort(new Error('stopped'));
  await assert.rejects(sent);
  const pattern = new RegExp(plain.pattern, 'i');
  for (const [key, sentence] of Object.entries(WORDS)) assert.doesNotMatch(sentence.replace(/\{\w+\}/g, 'X'), pattern, key);
});

/** An OpenAI-compatible provider on loopback: a tool call first, then the answer once the tool's result comes back. */
async function keyProvider() {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    const answered = bodies.at(-1).messages.some((m: any) => m.role === 'tool');
    const events = answered
      ? [{ id: 'k', choices: [{ index: 0, delta: { role: 'assistant', content: 'Saved it.' }, finish_reason: null }] },
        { id: 'k', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 } }]
      : [{ id: 'k', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_k', type: 'function', function: { name: 'save_note', arguments: '{"input":"milk"}' } }] }, finish_reason: null }] },
        { id: 'k', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { base, bodies, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

test('a per-use key answers on the phone labelled as billed per use, with the same tool loop', async (t) => {
  const fake = await keyProvider();
  t.after(() => fake.close());
  const kept = new Map<string, string>();
  const accounts = new Accounts({ store: () => memoryStore(), keyStore: () => ({ get: async (id) => kept.get(id) ?? null,
    set: async (id, v) => { kept.set(id, v); }, delete: async (id) => kept.delete(id) }) }, withKeys(portable));
  const { id } = await accounts.add('Umer', 'openrouter:key', { key: 'sk-or-fixture-not-real' });
  const model: Model<Api> = { id: 'fixture/model', name: 'Fixture', api: 'openai-completions', provider: 'openrouter', baseUrl: fake.base,
    reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 256, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
  const ran: unknown[] = [];
  const session = await PhoneSession.open({ accounts, member: 'Umer', account: id, model, instructions: 'You run on a phone.', log: memoryLog(),
    tools: [{ name: 'save_note', description: 'Save a note.', parameters: { type: 'object', properties: { input: { type: 'string' } } },
      run: async (args) => { ran.push(args); return 'saved'; } }] });

  const account = await session.account();
  assert.equal(account.billing, 'api');
  assert.equal(account.words, 'Charged per use to your OpenRouter account, not a plan.');
  const turn = await session.send('remember milk');
  assert.equal(turn.state, 'done', turn.words ?? '');
  assert.equal(turn.answer, 'Saved it.');
  assert.deepEqual(ran, [{ input: 'milk' }]);
  assert.equal(fake.bodies.length, 2);
  assert.deepEqual(fake.bodies[1].messages.at(-1), { role: 'tool', content: 'saved', tool_call_id: 'call_k' });
  await assert.rejects(PhoneSession.open({ accounts, member: 'Umer', account: id, instructions: 'x', log: memoryLog() }).then((s) => s.send('hi')), TypeError);
});
