// Asking ChatGPT from a phone or browser (portable.ts): the shared fixtures (sse.json, limit-responses.json), then a
// signed-in member's question end to end against the stand-in OpenAI, streamed and not, and the failures an app acts on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, ResponseError, isFunctionCall, limitResponse, offered, PROVIDERS, memoryStore, sseReader, type ResponseStreamEvent } from '../src/portable.ts';
import { mockOpenAI } from '../src/testing/index.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/conformance/${name}`, import.meta.url), 'utf8'));
const openai = await mockOpenAI();
after(() => openai.close());

test('shared and TypeScript SSE cases: streaming, completion, and errors', () => {
  for (const c of [...fixture('sse.json').cases, ...fixture('sse-typescript.json').cases]) for (const pieces of [[c.stream], [...c.stream]]) {
    const deltas: string[] = [];
    const r = sseReader((d) => deltas.push(d));
    const run = () => { for (const p of pieces) r.push(p); return r.end(); };
    if (c.error) {
      assert.throws(run, (e: any) => e instanceof ResponseError && e.message === c.error.message && e.kind === c.error.kind);
    } else {
      assert.equal(run(), c.text);
      assert.equal(deltas.join(''), c.deltas ?? c.text, 'onText saw every piece');
    }
  }
});

test('shared and TypeScript HTTP errors preserve their kind and message', () => {
  const shared = fixture('limit-responses.json');
  const cases = new Map<string, { status: number; body: string; kind: string; until?: number; message: string }>(shared.cases.map((c: any) => [c.body, c]));
  for (const c of fixture('limit-responses-typescript.json').cases) cases.set(c.body, c);
  for (const c of cases.values()) assert.deepEqual(limitResponse(c.status, c.body, shared.now), { kind: c.kind, until: c.until, message: c.message }, c.body);
});

async function signedIn(opts: { fetch?: typeof fetch } = {}) {
  const a = new Accounts<any, number>({ store: () => memoryStore(), authBase: openai.base, apiBase: openai.base, ...opts });
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt')!.state, 'done');
  return a;
}

test('respond: the answer streams in pieces with the member\'s own sign-in', async () => {
  const a = await signedIn();
  const pieces: string[] = [];
  assert.equal(await a.respond(1, { instructions: 'Be brief.', input: 'hello there', onText: (d) => pieces.push(d) }), 'You said: hello there');
  assert.ok(pieces.length > 1, 'more than one piece arrived');
  const asked = JSON.parse(openai.state.requests.findLast((r) => r.path === '/codex/responses')!.body);
  assert.equal(asked.model, 'gpt-6-sol');
  assert.equal(asked.instructions, 'Be brief.');
});

test("respond with a fetch that can't stream (React Native's own): the whole answer at once", async () => {
  const noStream = (async (url: any, init: any) => {
    const res = await fetch(url, init);
    const text = await res.text();
    return { ok: res.ok, status: res.status, body: undefined, text: async () => text } as unknown as Response;
  }) as typeof fetch;
  const a = await signedIn({ fetch: noStream });
  const pieces: string[] = [];
  assert.equal(await a.respond(1, { instructions: '', input: 'hi', onText: (d) => pieces.push(d) }), 'You said: hi');
  assert.equal(pieces.join(''), 'You said: hi');
});

test('respond preserves newlines in streamed and whole answers', async () => {
  const a = await signedIn();
  const pieces: string[] = [];
  const answer = 'You said: first\nsecond';
  assert.equal(await a.respond(1, { instructions: '', input: 'first\nsecond', onText: (d) => pieces.push(d) }), answer);
  assert.equal(pieces.join(''), answer);
});

test('respond distinguishes an undated rate limit from a plan exclusion', async () => {
  for (const [body, kind, state] of [
    ['slow down', 'rate_limit', 'resting'],
    [JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), 'rate_limit', 'resting'],
    [JSON.stringify({ error: { type: 'usage_not_included' } }), 'not_included', 'not_included'],
  ]) {
    const a = await signedIn();
    openai.state.fail = { status: body === 'slow down' ? 429 : 400, body };
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e.kind === kind);
    assert.equal((await a.status(1, 'chatgpt')).state, state);
    if (kind === 'rate_limit') assert.ok(a.restingUntil(1, 'chatgpt') > Date.now());
  }
});

test('respond acts on coded failures in both SSE event forms', async () => {
  for (const [event, kind, state] of [
    [{ type: 'error', code: 'rate_limit_exceeded', message: 'Slow down' }, 'rate_limit', 'resting'],
    [{ type: 'response.failed', response: { error: { code: 'usage_not_included', message: 'Not included' } } }, 'not_included', 'not_included'],
  ] as const) {
    const a = await signedIn({ fetch: (async () => new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch });
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e.kind === kind);
    assert.equal((await a.status(1, 'chatgpt')).state, state);
  }
});

test('respond preserves a failed refresh as a network failure, not sign-out', async () => {
  openai.state.expiresIn = 0;
  const a = await signedIn();
  openai.state.expiresIn = 864_000;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === `${openai.base}/oauth/token` ? Promise.reject(new Error('fetch failed')) : original(input, init)) as typeof fetch;
  try {
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'network');
    assert.equal((await a.status(1, 'chatgpt')).state, 'ready');
  } finally { globalThis.fetch = original; }
});

test('respond treats a refused refresh as signed out and needs another sign-in', async () => {
  openai.state.expiresIn = 0;
  const a = await signedIn();
  openai.state.expiresIn = 864_000;
  openai.state.live.clear();
  await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'signed_out');
  assert.equal((await a.status(1, 'chatgpt')).state, 'needs_again');
  assert.equal(await a.plan(1), null);
});

test('respond reports a passing 401 as the overload it acts on', async () => {
  const a = await signedIn();
  openai.state.fail = { status: 401, body: JSON.stringify({ error: { message: 'Provided authentication token is expired.' } }) };
  await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'overloaded' && e.until > Date.now());
  assert.equal((await a.status(1, 'chatgpt')).state, 'resting');
});

test('respond failures: a usage limit rests the account; signed out says so in plain words', async () => {
  const a = await signedIn();
  openai.state.fail = { status: 429, body: JSON.stringify({ error: { code: 'usage_limit_reached', plan_type: 'PLUS', resets_at: Math.floor(Date.now() / 1000) + 3600 } }) };
  await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e.kind === 'rate_limit' && /usage limit \(plus plan\)\. Try again in ~60 min\./.test(e.message));
  assert.ok(a.restingUntil(1, 'chatgpt') > Date.now(), 'resting until the limit resets');
  assert.equal((await a.status(1, 'chatgpt')).state, 'resting');
  await a.logout(1, 'chatgpt');
  await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e.kind === 'signed_out' && e.message === "ChatGPT isn't signed in yet.");
});

test('respond with tools: a function call streams as typed events, then a tool-result turn answers', async () => {
  const a = await signedIn();
  const events: ResponseStreamEvent[] = [];
  const pieces: string[] = [];
  const tools = [{ type: 'function' as const, name: 'get_time', description: 'The time.', parameters: { type: 'object', properties: { zone: { type: 'string' } } } }];
  const result = await a.respond(1, {
    instructions: 'Be brief.', input: 'what time is it', tools,
    onText: (d) => pieces.push(d), onEvent: (e) => events.push(e),
  });
  assert.equal(result.text, '', 'a tool turn carries no words');
  assert.deepEqual(pieces, []);
  assert.equal(result.output.length, 1);
  const call = result.output[0];
  assert.ok(isFunctionCall(call), 'the output item is the call');
  assert.equal(call.name, 'get_time');
  assert.equal(call.call_id, 'call_1');
  assert.deepEqual(JSON.parse(call.arguments), { input: 'what time is it' });
  const landed = events.filter((e) => e.type === 'function_call');
  assert.equal(landed.length, 1, 'one tool-call event');
  assert.deepEqual(landed[0], { type: 'function_call', name: 'get_time', arguments: call.arguments, callId: 'call_1' });
  assert.equal(events.filter((e) => e.type === 'output_item').length, 1, 'one output-item event, not one per completion copy');
  assert.equal(events.filter((e) => e.type === 'function_call_delta').map((e) => e.type === 'function_call_delta' ? e.delta : '').join(''), call.arguments);
  const asked = JSON.parse(openai.state.requests.findLast((r) => r.path === '/codex/responses')!.body);
  assert.deepEqual(asked.tools, tools);
  assert.deepEqual(asked.reasoning, { effort: 'none' });
  // The tool-result turn: the call with its answer, back as words.
  assert.equal(await a.respond(1, {
    instructions: 'Be brief.',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'what time is it' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_time', arguments: call.arguments },
      { type: 'function_call_output', call_id: 'call_1', output: 'noon' },
    ],
  }), 'You did: noon');
});

test('respond with an image turn: the picture rides along, the words echo back', async () => {
  const a = await signedIn();
  const input = [{ role: 'user' as const, content: [{ type: 'input_text' as const, text: 'what is this' }, { type: 'input_image' as const, image_url: 'data:image/png;base64,iVBOR' }] }];
  assert.equal(await a.respond(1, { instructions: '', input }), 'You said: what is this');
  const asked = JSON.parse(openai.state.requests.findLast((r) => r.path === '/codex/responses')!.body);
  assert.deepEqual(asked.input, input);
});

test('respond with a json_object format: the format reaches the request body', async () => {
  const a = await signedIn();
  await a.respond(1, { instructions: 'Return JSON.', input: 'hi', text: { verbosity: 'low' as const, format: { type: 'json_object' } } });
  const asked = JSON.parse(openai.state.requests.findLast((r) => r.path === '/codex/responses')!.body);
  assert.deepEqual(asked.text, { verbosity: 'low', format: { type: 'json_object' } });
});

test('respond sends the byokit originator unless the app sets its own', async () => {
  const stream = () => new Response(
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hi' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
  const stub = () => {
    const seen: Record<string, string>[] = [];
    const stubFetch = (async (_url: any, init: any) => { seen.push({ ...init.headers }); return stream(); }) as typeof fetch;
    return { fetch: stubFetch, seen };
  };
  const signInWith = async (opts: { fetch: typeof fetch; originator?: string }) => {
    const accounts = new Accounts<any, number>({ store: () => memoryStore(), authBase: openai.base, apiBase: openai.base, ...opts });
    const v = (await accounts.login(1, 'chatgpt'))!;
    openai.approve(v.code!);
    await accounts.finished(1, 'chatgpt');
    return accounts;
  };
  const plain = stub();
  assert.equal(await (await signInWith({ fetch: plain.fetch })).respond(1, { instructions: '', input: 'hi' }), 'hi');
  assert.equal(plain.seen[0].originator, 'byokit');
  const named = stub();
  assert.equal(await (await signInWith({ fetch: named.fetch })).respond(1, { instructions: '', input: 'hi', originator: 'ownvoice' }), 'hi');
  assert.equal(named.seen[0].originator, 'ownvoice');
  const configured = stub();
  assert.equal(await (await signInWith({ fetch: configured.fetch, originator: 'ownvoice' })).respond(1, { instructions: '', input: 'hi' }), 'hi');
  assert.equal(configured.seen[0].originator, 'ownvoice');
});

test('respond with a schema: the format passes through and the answer parses', async () => {
  const a = await signedIn();
  const schema = { type: 'object', properties: { echo: { type: 'string' } }, required: ['echo'], additionalProperties: false };
  const format = { type: 'json_schema' as const, name: 'echo', schema, strict: true };
  assert.deepEqual(JSON.parse(await a.respond(1, { instructions: '', input: 'hi', text: { verbosity: 'low' as const, format } })), { echo: 'You said: hi' });
  const asked = JSON.parse(openai.state.requests.findLast((r) => r.path === '/codex/responses')!.body);
  assert.deepEqual(asked.text, { verbosity: 'low', format });
});

test('respond with the image_generation built-in: passed through, answered as text', async () => {
  const a = await signedIn();
  const events: ResponseStreamEvent[] = [];
  const result = await a.respond(1, { instructions: '', input: 'a cat', tools: [{ type: 'image_generation' }], onEvent: (e) => events.push(e) });
  assert.equal(result.text, 'You said: a cat');
  assert.deepEqual(result.output, []);
  const asked = JSON.parse(openai.state.requests.findLast((r) => r.path === '/codex/responses')!.body);
  assert.deepEqual(asked.tools, [{ type: 'image_generation' }]);
});

test('tool pass-through changes no billing and offers no new route', () => {
  assert.deepEqual(offered().map((p) => p.key), ['chatgpt']);
  assert.equal(PROVIDERS.chatgpt.billing, 'subscription');
  assert.equal(PROVIDERS.chatgpt.terms, 'grey');
  assert.ok(!offered().some((p) => p.billing === 'api'), 'API rows stay opt-in');
});
