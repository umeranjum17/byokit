// Asking ChatGPT from a phone or browser (portable.ts): the shared fixtures (sse.json, limit-responses.json), then a
// signed-in member's question end to end against the stand-in OpenAI, streamed and not, and the failures an app acts on.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, ResponseError, limitResponse, memoryStore, sseReader } from '../src/portable.ts';
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
