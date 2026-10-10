// Asking ChatGPT from a phone or browser (portable.ts): the shared fixtures (sse.json, limit-responses.json), then a
// signed-in member's question end to end against the stand-in OpenAI, streamed and not, and the failures an app acts on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Accounts, IncompleteError, ResponseError, isFunctionCall, limitResponse, offered, PROVIDERS, memoryStore, respond, sseReader, type EndingStore, type ResponseStreamEvent } from '../src/portable.ts';
import { mockOpenAI } from '../src/testing/index.ts';
import { fileStore } from '../src/node-stores.ts';
import { scratchDir } from '../../test-support.ts';
import { sealing } from './sealing.ts';

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
      assert.deepEqual(r.result().usage, c.usage);
    }
  }
});

test('shared and TypeScript HTTP errors preserve their kind and message', () => {
  const shared = fixture('limit-responses.json');
  const cases = new Map<string, { status: number; body: string; kind: string; until?: number; message: string }>(shared.cases.map((c: any) => [c.body, c]));
  for (const c of fixture('limit-responses-typescript.json').cases) cases.set(c.body, c);
  for (const c of cases.values()) assert.deepEqual(limitResponse(c.status, c.body, shared.now), { kind: c.kind, until: c.until, message: c.message }, c.body);
});

test('respond exposes only status and Retry-After metadata for callers retrying HTTP failures', async () => {
  for (const c of fixture('limit-responses-typescript.json').retry) {
    await assert.rejects(respond({ instructions: '', input: 'Umer', access: 'synthetic-token', accountId: 'synthetic-account',
      model: 'test-model', fetch: async () => new Response('', { status: c.status,
        headers: { 'Retry-After': c.retryAfter, 'x-private': 'synthetic private credential' } }) }), (e: unknown) => {
      assert.ok(e instanceof ResponseError);
      assert.equal(e.status, c.status);
      assert.equal(e.retryAfter, c.retryAfter);
      assert.ok(!JSON.stringify(e).includes('synthetic private credential'));
      assert.ok(!JSON.stringify(e).includes('synthetic-token'));
      return true;
    });
  }
});

async function signedIn(opts: { fetch?: typeof fetch; store?: () => EndingStore } = {}) {
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

test('respond reports recorded incomplete answers through events and errors, streamed or buffered, with or without tools', async () => {
  for (const c of fixture('incomplete-typescript.json').cases) {
    for (const mode of ['stream', 'buffered', 'json'] as const) for (const tools of [undefined, []]) {
      const stubFetch = (async () => {
        if (mode === 'json') return new Response(JSON.stringify(c.response), { headers: { 'content-type': 'application/json' } });
        if (mode === 'buffered') return { ok: true, status: 200, text: async () => c.stream } as Response;
        const bytes = new TextEncoder().encode(c.stream);
        return new Response(new ReadableStream({
          start(controller) {
            // Split every byte, including JSON fields and event boundaries.
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
            controller.close();
          },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch;
      const a = await signedIn({ fetch: stubFetch });
      const events: ResponseStreamEvent[] = [];
      const pieces: string[] = [];
      const ask = { instructions: '', input: 'hi', onEvent: (e: ResponseStreamEvent) => events.push(e), onText: (d: string) => pieces.push(d) };
      const answer = tools ? a.respond(1, { ...ask, tools }) : a.respond(1, ask);
      await assert.rejects(answer, (e: unknown) => {
        assert.ok(e instanceof IncompleteError);
        assert.ok(e instanceof ResponseError);
        assert.equal(e.kind, null);
        assert.equal(e.reason, c.reason);
        assert.equal(e.result.text, c.text);
        assert.deepEqual(e.result.output, c.response.output);
        assert.deepEqual(events.filter((event) => event.type === 'incomplete'), [{ type: 'incomplete', reason: c.reason }]);
        return true;
      });
      assert.equal(pieces.join(''), c.text);
      assert.equal((await a.status(1, 'chatgpt')).state, 'ready');
      assert.equal(a.restingUntil(1, 'chatgpt'), 0);
    }
    const r = sseReader();
    for (const byte of c.stream) r.push(byte);
    for (const finish of [() => r.end(), () => r.result()]) assert.throws(finish, (e: unknown) => e instanceof IncompleteError && e.reason === c.reason && e.result.text === c.text);
  }
  const a = await signedIn({ fetch: (async () => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Complete' }] }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  assert.equal(await a.respond(1, { instructions: '', input: 'hi' }), 'Complete');
  const failed = await signedIn({ fetch: (async () => new Response(JSON.stringify({ status: 'failed', error: { message: 'Request failed' }, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial' }] }] }), { headers: { 'content-type': 'application/json' } })) as typeof fetch });
  await assert.rejects(failed.respond(1, { instructions: '', input: 'hi' }), (e: unknown) => e instanceof ResponseError && e.message === 'Request failed');
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

test('a refresh lost to the network keeps the sign-in in the real fileStore and retries the same grant once it is back', async () => {
  openai.state.expiresIn = 0;
  const path = join(scratchDir('transient-refresh'), 'people', '1', 'auth.json');
  const a = await signedIn({ store: () => fileStore(path, sealing) });
  openai.state.expiresIn = 864_000;
  const stored = () => JSON.parse(sealing.decryptString(readFileSync(path)))['openai-codex'];
  const before = stored().refresh;
  const original = globalThis.fetch;
  const sent: string[] = [];
  let down = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${openai.base}/oauth/token`) {
      sent.push(new URLSearchParams(String(init?.body)).get('refresh_token')!);
      if (down) return Promise.reject(new Error('fetch failed'));
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'network');
    assert.equal((await a.status(1, 'chatgpt')).state, 'ready', 'a lost answer is not a sign-out');
    assert.equal(stored().refresh, before, 'the grant is kept');
    down = false;
    assert.ok(await a.respond(1, { instructions: '', input: 'hi' }), 'answered with the refreshed sign-in');
    assert.deepEqual(sent, [before, before], 'the kept grant was retried, not a new sign-in');
    assert.notEqual(stored().refresh, before);
    assert.deepEqual(stored().byokitRefresh, { generation: 1, state: 'ready' });
  } finally { globalThis.fetch = original; }
});

test('a passing 401 at refresh keeps the sign-in in the real fileStore, after a due refresh or a refused request; only invalid_grant signs out', async () => {
  openai.state.expiresIn = 0;
  const path = join(scratchDir('passing-401-refresh'), 'people', '1', 'auth.json');
  const a = await signedIn({ store: () => fileStore(path, sealing) });
  const stored = () => JSON.parse(sealing.decryptString(readFileSync(path)))['openai-codex'];
  const original = globalThis.fetch;
  const sent: string[] = [];
  let passing = true;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === `${openai.base}/oauth/token`) {
      sent.push(new URLSearchParams(String(init?.body)).get('refresh_token')!);
      if (passing) return Promise.resolve(new Response('{"error":{"message":"Unauthorized"}}', { status: 401 }));
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    // access(): the due refresh meets a 401 that names no revoked grant.
    const first = stored().refresh;
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'network');
    assert.equal((await a.status(1, 'chatgpt')).state, 'ready', 'a passing 401 is not a sign-out');
    assert.equal(stored().refresh, first, 'the grant is kept');
    passing = false;
    openai.state.expiresIn = 864_000;
    assert.ok(await a.respond(1, { instructions: '', input: 'hi' }), 'answered once the provider is back');
    assert.deepEqual(sent, [first, first], 'the kept grant was retried, not a new sign-in');
    // recheck(): a refused request forces a refresh, which meets the same passing 401.
    const second = stored().refresh;
    passing = true;
    openai.state.fail = { status: 401, body: JSON.stringify({ error: { message: 'Provided authentication token is expired.' } }) };
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'overloaded');
    assert.equal(stored().refresh, second, 'the grant is kept after the recheck');
    assert.deepEqual(stored().byokitRefresh, { generation: 1, state: 'ready' });
    passing = false;
    assert.equal(await a.recheck(1, 'chatgpt'), true, 'the kept grant still refreshes');
    assert.deepEqual(sent.slice(2), [second, second]);
    // Proven revocation: the provider names the grant revoked (OpenAI's refresh_token_reused); only then is the sign-in deleted.
    openai.state.refuse = true;
    openai.state.fail = { status: 401, body: JSON.stringify({ error: { message: 'Provided authentication token is expired.' } }) };
    await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e instanceof ResponseError && e.kind === 'signed_out');
    assert.equal(stored(), undefined, 'a revoked sign-in is deleted');
    assert.notEqual((await a.status(1, 'chatgpt')).state, 'ready');
  } finally { globalThis.fetch = original; Object.assign(openai.state, { refuse: false, expiresIn: 864_000, fail: undefined }); }
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

test('ChatGPT subscription respond passes true/false parallel tool calls and omits the provider default', async () => {
  const bodies: unknown[] = [];
  const stubFetch = (async (_url: any, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Done' }] }] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const a = await signedIn({ fetch: stubFetch });
  const tools = [{ type: 'function' as const, name: 'tap', parameters: { type: 'object', properties: {} } }];
  for (const parallelToolCalls of [true, false, undefined]) {
    const ask = { instructions: 'Act in order.', input: 'tap', tools, tool_choice: 'auto' as const,
      ...(parallelToolCalls === undefined ? {} : { parallelToolCalls }) };
    const expected = {
      model: PROVIDERS.chatgpt.models.strong, store: false, stream: true, instructions: ask.instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'tap' }] }], tools, tool_choice: 'auto',
      ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
      text: { verbosity: 'low' }, reasoning: { effort: 'none' },
    };
    // Both public entries share the same builder, including phones and browsers.
    assert.equal((await a.respond(1, ask)).text, 'Done');
    assert.deepEqual(bodies.at(-1), expected);
    assert.equal((await respond({ ...ask, access: 'synthetic-token', accountId: 'synthetic-account', model: PROVIDERS.chatgpt.models.strong, fetch: stubFetch })).text, 'Done');
    assert.deepEqual(bodies.at(-1), expected);
  }
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
  assert.deepEqual(offered().map((p) => p.key), ['chatgpt', 'grok', 'copilot', 'claude', 'kimi', 'meta', 'google-gemini-cli', 'google-antigravity']);
  assert.equal(PROVIDERS.chatgpt.billing, 'subscription');
  assert.ok(!offered().some((p) => p.billing === 'api'), 'API rows stay opt-in');
});


test('respond result:true retains reported usage on streaming, buffered and JSON transports', async () => {
  const usage = { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } };
  const response = { status: 'completed', usage, output: [{ type: 'message', content: [{ type: 'output_text', text: 'Umer' }] }] };
  const stream = `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`;
  for (const mode of ['stream', 'buffered', 'json'] as const) {
    const fetch = (async () => mode === 'json' ? Response.json(response) : mode === 'stream'
      ? new Response(stream) : { ok: true, text: async () => stream } as Response) as typeof globalThis.fetch;
    const a = await signedIn({ fetch });
    const result = await a.respond(1, { instructions: '', input: 'Umer', result: true });
    assert.equal(result.text, 'Umer');
    assert.deepEqual(result.usage, usage);
    assert.deepEqual((await a.respond(1, { instructions: '', input: 'Umer', tools: [] })).usage, usage);
    assert.equal(await a.respond(1, { instructions: '', input: 'Umer' }), 'Umer');
    const incomplete = sseReader();
    incomplete.push(`data: ${JSON.stringify({ type: 'response.incomplete', response: { ...response, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })}\n\n`);
    assert.throws(() => incomplete.result(), (e: unknown) => {
      assert.ok(e instanceof IncompleteError);
      assert.deepEqual(e.result.usage, usage);
      return true;
    });
  }
});
