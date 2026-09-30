// O8 acceptance (5.8) over the O7 fake gateway: ordered streaming, member boundary refusal, optional bridge
// registration, abort, a resting wait error, and no listener or registration leak across 100 runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { createRuns } from '../src/runs.ts';
import type { GatewayTransport, Member, RunEvent } from '../src/types.ts';

/** createRuns wired to a fresh fake: a recording bridge double and a live-listener counter around the transport. */
function harness() {
  const fake = fakeGateway();
  const t = fake.factory({ port: 0, token: 't', identityPath: '', bridgeSock: '' });
  const registered: string[] = [];
  const unregistered: string[] = [];
  const subsets: (readonly string[] | undefined)[] = [];
  let live = 0;
  const onEvent: GatewayTransport['onEvent'] = (fn) => {
    live++;
    const off = t.onEvent(fn);
    return () => {
      live--;
      off();
    };
  };
  const ensure = async (member: Member) => {
    const list = await t.request('agents.list') as { agents: { id: string }[] };
    if (!(list.agents ?? []).some((agent) => agent.id === member)) await t.request('agents.create', { name: member });
    return { agentId: member };
  };
  const runs = createRuns({
    request: t.request,
    onEvent,
    ensure,
    bridge: { register: (r, tools) => { registered.push(r.sessionKey); subsets.push(tools); return () => { unregistered.push(r.sessionKey); }; } },
    tools: new Set(['report', 'lookup']),
  });
  return { fake, runs, registered, unregistered, subsets, listeners: () => live };
}

test('a run streams its events in order and ends ok', async () => {
  const h = harness();
  const events: RunEvent[] = [];
  const end = await h.runs.run(
    { member: 'm1', sessionKey: 'agent:m1:main', message: 'please [tool note {"x":1}] now' },
    (e) => events.push(e),
  );
  const text = 'fake: please [tool note {"x":1}] now';
  // The run's usage rides the `agent` final frame; the fake reports no plan window for the provider.
  assert.deepEqual(end, { ok: true, text, usage: { input: 30, output: 36, total: 66 } });
  assert.deepEqual(events, [
    { type: 'tool', name: 'note', phase: 'start', id: 'call-1', input: { x: 1 } },
    { type: 'tool', name: 'note', phase: 'end', id: 'call-1', output: { content: [{ type: 'text', text: 'note ran' }] }, error: false },
    { type: 'text', text },
    { type: 'text', text }, // the final cumulative text event
  ]);
  const call = h.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.equal(call.agentId, 'm1');
  assert.equal(call.sessionKey, 'agent:m1:main');
  assert.equal(call.message, 'please [tool note {"x":1}] now');
  assert.ok(typeof call.idempotencyKey === 'string' && call.idempotencyKey.length > 0);
});

test("a member cannot run in another member's session, refused before any request", async () => {
  const h = harness();
  await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m2:other:1', message: 'hello' }), /m2/);
  await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'chat:m1:main', message: 'hello' }));
  assert.deepEqual(h.fake.calls, []);
});

test('register:false skips the bridge; a default run registers and unregisters once', async () => {
  const h = harness();
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:unreg', message: 'hello', register: false });
  assert.deepEqual(h.registered, []);
  assert.deepEqual(h.unregistered, []);
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:reg', message: 'hello' });
  assert.deepEqual(h.registered, ['agent:m1:reg']);
  assert.deepEqual(h.unregistered, ['agent:m1:reg']);
});

test('aborting mid-run ends the run aborted', async () => {
  const h = harness();
  const key = 'agent:m1:abort';
  const pending = h.runs.run({ member: 'm1', sessionKey: key, message: 'hello' }, (e) => {
    if (e.type === 'text') void h.runs.abort(key);
  });
  assert.deepEqual(await pending, { ok: false, aborted: true });
  assert.deepEqual(h.unregistered, [key]);
});

test('a usage-limit wait error rests with an until about five minutes out', async () => {
  const h = harness();
  h.fake.failNext('agent.wait', 'usage limit, try again in 5 min');
  const before = Date.now();
  const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:rest', message: 'hello' });
  assert.ok(!end.ok && 'kind' in end, JSON.stringify(end));
  assert.equal(end.message, 'usage limit, try again in 5 min');
  assert.equal(end.kind, 'resting');
  assert.ok(end.until !== undefined && Math.abs(end.until - (before + 300_000)) < 5_000, `until ${end.until}`);
});

test('steer and abort address the session key', async () => {
  const h = harness();
  await h.runs.steer('agent:m1:s', 'go faster');
  await h.runs.abort('agent:m1:s');
  assert.deepEqual(
    h.fake.calls.filter((c) => c.method === 'sessions.steer' || c.method === 'chat.abort'),
    [
      { method: 'sessions.steer', params: { sessionKey: 'agent:m1:s', message: 'go faster' } },
      { method: 'chat.abort', params: { sessionKey: 'agent:m1:s' } },
    ],
  );
});

test('a hundred concurrent runs leave no listener or registration behind', async () => {
  const h = harness();
  const ends = await Promise.all(Array.from({ length: 100 }, (_, i) =>
    h.runs.run({ member: 'm1', sessionKey: `agent:m1:leak:${i}`, message: `run ${i}` })));
  for (const end of ends) assert.ok(end.ok, JSON.stringify(end));
  assert.equal(h.listeners(), 0);
  assert.equal(h.registered.length, 100);
  assert.equal(h.unregistered.length, 100);
  assert.deepEqual([...h.unregistered].sort(), [...h.registered].sort());
});

test('a picked account reaches the agent request as its per-run provider and model', async () => {
  const h = harness();
  h.fake.handle('models.authStatus', () => ({ providers: [{ provider: 'openai', status: 'ok' }, { provider: 'xai', status: 'static' }] }));
  const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:pick', message: 'hello', model: 'xai/grok-4' });
  assert.ok(end.ok, JSON.stringify(end));
  assert.deepEqual(h.fake.calls.find((c) => c.method === 'models.authStatus')?.params, { agentId: 'm1' });
  const call = h.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.equal(call.provider, 'xai');
  assert.equal(call.model, 'grok-4');
  // A model id may itself hold slashes (routers): only the first names the provider.
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:pick2', message: 'hello', model: 'openai/org/model-x' });
  const second = h.fake.calls.filter((c) => c.method === 'agent')[1]?.params as Record<string, unknown>;
  assert.deepEqual([second.provider, second.model], ['openai', 'org/model-x']);
});

test('omitting the account sends exactly the old request and checks no sign-in', async () => {
  const h = harness();
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:plain', message: 'hello', system: 'be brief', thinking: 'low' });
  // Only the plan-window read after the run asks for auth status; nothing checks a sign-in before it.
  const agentAt = h.fake.calls.findIndex((c) => c.method === 'agent');
  assert.equal(h.fake.calls.slice(0, agentAt).some((c) => c.method === 'models.authStatus'), false);
  const call = h.fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.deepEqual(Object.keys(call).sort(), ['agentId', 'extraSystemPrompt', 'idempotencyKey', 'message', 'sessionKey', 'thinking']);
});

test('an account not signed in, or signed out, ends signed-out before the engine is called', async () => {
  const h = harness();
  h.fake.handle('models.authStatus', () => ({ providers: [{ provider: 'openai', status: 'expired' }, 'xai'] }));
  for (const model of ['openai/gpt-5.1', 'minimax/m2']) {
    const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:out', message: 'hello', model });
    assert.deepEqual(end, { ok: false, kind: 'signed-out', message: `${model.split('/')[0]} is not signed in for m1` });
  }
  assert.equal(h.fake.calls.some((c) => c.method === 'agent'), false);
  assert.deepEqual(h.unregistered, ['agent:m1:out', 'agent:m1:out']);
  // A bare provider string (older status shape) counts as signed in, and ids compare lowercased like the engine's.
  assert.ok((await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:in', message: 'hello', model: 'XAI/grok-4' })).ok);
  assert.equal((h.fake.calls.find((c) => c.method === 'agent')?.params as { provider: string }).provider, 'xai');
  // The row's status is its worst profile's: one stale sign-in beside a good one still counts, all stale does not.
  h.fake.handle('models.authStatus', () => ({ providers: [
    { provider: 'openai', status: 'expired', profiles: [{ status: 'expired' }, { status: 'ok' }] },
    { provider: 'xai', status: 'expired', profiles: [{ status: 'expired' }, { status: 'missing' }] },
  ] }));
  assert.ok((await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:two', message: 'hello', model: 'openai/gpt-5.1' })).ok);
  const stale = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:two', message: 'hello', model: 'xai/grok-4' });
  assert.ok(!stale.ok && 'kind' in stale && stale.kind === 'signed-out', JSON.stringify(stale));
});

test('an unprepared auth status is built once with refresh, and stays a typed failure if it cannot be', async () => {
  const h = harness();
  const seen: unknown[] = [];
  let prepared = false;
  h.fake.handle('models.authStatus', (p) => {
    seen.push(p);
    return prepared || p.refresh ? { providers: [{ provider: 'openai', status: 'ok' }] }
      : { providers: [], unavailable: { code: 'PREPARED_MODEL_AUTH_UNAVAILABLE', message: 'Model authentication status is unavailable.' } };
  });
  assert.ok((await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:prep', message: 'hi', model: 'openai/gpt-5.1' })).ok);
  // Then once more after the run, for the plan window (never a refresh).
  assert.deepEqual(seen, [{ agentId: 'm1' }, { agentId: 'm1', refresh: true }, { agentId: 'm1' }]);
  h.fake.handle('models.authStatus', () => ({ providers: [], unavailable: { message: 'Model authentication status is unavailable.' } }));
  const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:prep2', message: 'hi', model: 'openai/gpt-5.1' });
  assert.deepEqual(end, { ok: false, kind: 'other', message: 'Model authentication status is unavailable.' });
});

test('a malformed account or an @profile pin is refused before any request', async () => {
  const h = harness();
  for (const model of ['gpt-5.1', '/gpt-5.1', 'openai/', 'openai/gpt-5.1@openai:me@example.com', 'openai/gpt 5'])
    await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m1:bad', message: 'hello', model }), /provider\/model/);
  assert.deepEqual(h.fake.calls, []);
});

test('a run names only kit tools: an unknown one is refused before any request, the subset reaches the bridge', async () => {
  const h = harness();
  await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m1:t', message: 'hi', tools: ['report', 'shell'] }),
    /"shell" is not one of this kit's tools/);
  assert.deepEqual(h.fake.calls, []);
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:t', message: 'hi', tools: ['lookup'] });
  await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:all', message: 'hi' });
  assert.deepEqual(h.subsets, [['lookup'], undefined]);
});

/** createRuns over a hand-driven transport: the `agent` request plays `play` then settles with `final`. */
function scripted(o: { final?: unknown; auth?: unknown; play?: (emit: (stream: string, data: unknown) => void) => void }) {
  const listeners = new Set<(e: { event: string; payload?: unknown }) => void>();
  const calls: string[] = [];
  const request: GatewayTransport['request'] = async (method, _params, opts) => {
    calls.push(method);
    if (method === 'agent') {
      opts?.onAccepted?.({ runId: 'r1', status: 'accepted' });
      o.play?.((stream, data) => { for (const fn of listeners) fn({ event: 'agent', payload: { runId: 'r1', stream, data } }); });
      return o.final ?? { runId: 'r1', status: 'ok' };
    }
    if (method === 'agent.wait') return { status: 'ok', terminalReply: { text: 'done' } };
    if (method === 'models.authStatus') return o.auth ?? { providers: [] };
    throw new Error(`unexpected ${method}`);
  };
  const runs = createRuns({ request, onEvent: (fn) => (listeners.add(fn), () => { listeners.delete(fn); }),
    ensure: async (member) => ({ agentId: member }), bridge: { register: () => () => {} }, tools: new Set() });
  return { runs, calls };
}
const finalWith = (agentMeta: unknown) => ({ runId: 'r1', status: 'ok', summary: 'completed', result: { payloads: [], meta: { agentMeta } } });

test('usage is the engine\'s run total, renamed and copied field by field; none reported is none', async () => {
  const spec = { member: 'm1', sessionKey: 'agent:m1:u', message: 'hi' };
  const full = scripted({ final: finalWith({ provider: 'openai', usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1,
    reasoningTokens: 3, total: 21, bogus: 9 }, costUsd: 0.0125 }) });
  assert.deepEqual(await full.runs.run(spec), { ok: true, text: 'done',
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, total: 21, costUsd: 0.0125 } });
  const partial = scripted({ final: finalWith({ usage: { output: 7, input: -1, total: 'x' } }) });
  assert.deepEqual(await partial.runs.run(spec), { ok: true, text: 'done', usage: { output: 7 } });
  // No usage in the frame, or no final frame at all (the ack only): no usage, and no provider means no window read.
  for (const final of [finalWith({ provider: 'openai' }), { runId: 'r1', status: 'accepted' }]) {
    const none = scripted({ final });
    assert.deepEqual(await none.runs.run(spec), { ok: true, text: 'done' });
  }
});

test('the plan window is the engine\'s own row for the run\'s provider, and never made up', async () => {
  const spec = { member: 'm1', sessionKey: 'agent:m1:p', message: 'hi' };
  const row = { provider: 'openai', status: 'ok', usage: { providerId: 'openai', plan: 'plus', windows: [
    { label: '5h', usedPercent: 42, resetAt: 1_790_000_000_000 }, { label: 'Week', usedPercent: 7 }, { label: 'bad' }] } };
  const shown = scripted({ final: finalWith({ provider: 'OpenAI' }), auth: { providers: [{ provider: 'xai', usage: row.usage }, row] } });
  assert.deepEqual(await shown.runs.run(spec), { ok: true, text: 'done', planWindow: { provider: 'openai', plan: 'plus',
    windows: [{ label: '5h', usedPercent: 42, resetAt: 1_790_000_000_000 }, { label: 'Week', usedPercent: 7 }] } });
  assert.deepEqual(shown.calls, ['agent', 'agent.wait', 'models.authStatus']);
  // A row without usage, with no windows, for another provider, or an unavailable status: no window.
  for (const auth of [{ providers: [{ provider: 'openai', status: 'ok' }] },
    { providers: [{ provider: 'openai', usage: { windows: [] } }] }, { providers: [{ ...row, provider: 'xai' }] },
    { providers: [], unavailable: { message: 'x' } }]) {
    const none = scripted({ final: finalWith({ provider: 'openai' }), auth });
    assert.deepEqual(await none.runs.run(spec), { ok: true, text: 'done' });
  }
});

test('tool progress phases stay inside the pair; start carries the input, end the output and error', async () => {
  const events: RunEvent[] = [];
  const s = scripted({ play: (emit) => {
    emit('tool', { phase: 'start', name: 'exec', toolCallId: 't1', args: { command: 'ls' } });
    emit('tool', { phase: 'update', name: 'exec', toolCallId: 't1', partialResult: 'a' });
    emit('tool', { phase: 'input_delta', name: 'exec', toolCallId: 't1', diff: { added: 1, removed: 0 } });
    emit('tool', { phase: 'review', name: 'exec', toolCallId: 't1', approvalReviewOutcome: 'approved' });
    emit('tool', { phase: 'result', name: 'exec', toolCallId: 't1', isError: true, result: 'denied', meta: 'ls' });
    emit('tool', { phase: 'start', name: 'old' }); // an older shape: no id, no args
    emit('tool', { phase: 'end', name: 'old' });
  } });
  await s.runs.run({ member: 'm1', sessionKey: 'agent:m1:tp', message: 'hi' }, (e) => events.push(e));
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [
    { type: 'tool', name: 'exec', phase: 'start', id: 't1', input: { command: 'ls' } },
    { type: 'tool', name: 'exec', phase: 'end', id: 't1', output: 'denied', error: true },
    { type: 'tool', name: 'old', phase: 'start' },
    { type: 'tool', name: 'old', phase: 'end' },
  ]);
});

test('Claude native and Anthropic API runs preserve provider/model and tool events; profiles stay strict', async () => {
  const h = harness();
  h.fake.handle('models.authStatus', () => ({ providers: [{ provider: 'anthropic', status: 'static' }] }));
  h.fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', credentials: true }] }));
  for (const provider of ['claude-cli', 'anthropic']) {
    const events: RunEvent[] = [];
    const end = await h.runs.run({ member: 'm1', sessionKey: `agent:m1:${provider}`, message: '[tool note {"x":1}]',
      model: `${provider}/claude-sonnet-5` }, (event) => events.push(event));
    assert.ok(end.ok, JSON.stringify(end));
    const call = h.fake.calls.filter((c) => c.method === 'agent').at(-1)!.params as Record<string, unknown>;
    assert.equal(call.provider, provider);
    assert.equal(call.model, 'claude-sonnet-5');
    assert.deepEqual(events.filter((event) => event.type === 'tool').map((event) => event.phase), ['start', 'end']);
    const before = h.fake.calls.length;
    await assert.rejects(h.runs.run({ member: 'm1', sessionKey: 'agent:m1:pin', message: 'hi',
      model: `${provider}/claude-sonnet-5@profile` }));
    assert.equal(h.fake.calls.length, before);
  }
  h.fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', credentials: false }] }));
  const end = await h.runs.run({ member: 'm1', sessionKey: 'agent:m1:out', message: 'hi', model: 'claude-cli/claude-sonnet-5' });
  assert.ok(!end.ok && 'kind' in end && end.kind === 'signed-out');
});
