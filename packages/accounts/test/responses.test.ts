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

test('sse.json: the streamed answer, whole or a character at a time, or the error it ended with', () => {
  for (const c of fixture('sse.json').cases) for (const pieces of [[c.stream], [...c.stream]]) {
    const deltas: string[] = [];
    const r = sseReader((d) => deltas.push(d));
    const run = () => { for (const p of pieces) r.push(p); return r.end(); };
    if (c.error) {
      assert.throws(run, (e: any) => e instanceof ResponseError && e.message === c.error.message && e.kind === c.error.kind);
    } else {
      assert.equal(run(), c.text);
      assert.equal(deltas.join(''), c.text, 'onText saw every piece');
    }
  }
});

test('limit-responses.json: an HTTP error as the kind, when to come back, and the words', () => {
  const f = fixture('limit-responses.json');
  for (const c of f.cases) assert.deepEqual(limitResponse(c.status, c.body, f.now), { kind: c.kind, until: c.until, message: c.message }, c.body);
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

test('respond failures: a usage limit rests the account; signed out says so in plain words', async () => {
  const a = await signedIn();
  openai.state.fail = { status: 429, body: JSON.stringify({ error: { code: 'usage_limit_reached', plan_type: 'PLUS', resets_at: Math.floor(Date.now() / 1000) + 3600 } }) };
  await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e.kind === 'rate_limit' && /usage limit \(plus plan\)\. Try again in ~60 min\./.test(e.message));
  assert.ok(a.restingUntil(1, 'chatgpt') > Date.now(), 'resting until the limit resets');
  assert.equal((await a.status(1, 'chatgpt')).state, 'resting');
  await a.logout(1, 'chatgpt');
  await assert.rejects(a.respond(1, { instructions: '', input: 'hi' }), (e: any) => e.kind === 'signed_out' && e.message === "ChatGPT isn't signed in yet.");
});
