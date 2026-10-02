import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, recordStore, routes, route, chooseAccount, resolveSelection, KeyRouteError, type AccountMetadata, type Api, type Model, type Context } from '../src/index.ts';
import { Accounts as Portable } from '../src/portable.ts';
import type { Record as CredentialRecord } from '../src/stores.ts';
import type { Keystore } from '@byokit/secrets';

const canary = 'B2-exact-secret-canary-987654321';
function secrets(): Keystore {
  const data = new Map<string, string>();
  return { get: async (id) => data.get(id) ?? null, set: async (id, value) => { data.set(id, value); }, delete: async (id) => data.delete(id) };
}
function harness() {
  let data: CredentialRecord = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  const keys = new Map<string, Keystore>();
  const keyStore = (member: string | number) => {
    const id = String(member);
    if (!keys.has(id)) keys.set(id, secrets());
    return keys.get(id)!;
  };
  const opts = { store: () => store, keyStore };
  return { a: new Accounts(opts), opts, store, keyStore, data: () => data };
}
const model = <T extends Api>(provider: string, api: T): Model<T> => ({ id: 'fixture-model', name: 'Fixture', provider, api,
  baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 });
const context: Context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] };
function sse(events: unknown[], named = false) {
  return new Response(events.map((event: any) => `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (named ? '' : 'data: [DONE]\n\n'), { headers: { 'content-type': 'text/event-stream' } });
}
const openaiEvents = [
  { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
  { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
];
const anthropicEvents = [
  { type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'fixture-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
];

test('shared key seam persists only a marker and non-secret route metadata; updates retain metadata', async () => {
  const h = harness();
  class Adapter extends Accounts {
    save(id: string, metadata: AccountMetadata) { return this.saveAccountKey('member', id, canary, metadata); }
  }
  const a = new Adapter(h.opts);
  const metadata = { route: 'openai:key', billing: 'api', baseUrl: 'https://app.example/v1' } as const;
  await a.save('one', metadata);
  await h.store.index((index) => { index.names.one = 'One'; });
  assert.deepEqual((await h.store.index()).accounts?.one, metadata);
  assert.deepEqual(await h.store.read('one'), { type: 'api_key' });
  assert.equal(await h.keyStore('member').get('accounts.one'), canary);
  assert.ok(!JSON.stringify(h.data()).includes(canary));
});

test('every pinned key route: explicit add, save, list, rename, restore, sign out and remove; exact canary stays private', async () => {
  const keyRoutes = routes().filter((r) => ['key', 'plan_key'].includes(r.via));
  for (const r of keyRoutes) {
    const h = harness();
    if (r.upstream.flow === 'absent') {
      await assert.rejects(h.a.add('member', r.id, { key: canary }), { code: 'no_upstream_flow' });
      continue;
    }
    const added = await h.a.add('member', r.id, { key: canary, via: r.via });
    assert.equal(await h.a.key('member', added.id), canary);
    const rows = await h.a.list('member');
    assert.equal(rows.length, 1, r.id);
    assert.deepEqual([rows[0].id, rows[0].provider, rows[0].route, rows[0].billing, rows[0].label], [added.id, r.provider, r.id, r.billing, r.label]);
    await h.a.rename('member', added.id, 'My account');
    await h.a.setDefaults('member', { account: added.id });
    await h.a.saveKey('member', added.id, canary, { billedPerUse: true });
    const restored = new Accounts(h.opts);
    assert.equal((await restored.list('member'))[0].name, 'My account');
    const status = await restored.status('member', added.id);
    assert.equal(status.state, 'ready');
    assert.ok(!JSON.stringify({ rows, status, data: h.data() }).includes(canary));
    assert.equal(await restored.signedIn('other-member', added.id), false, 'no other member key');
    await restored.logout('member', added.id);
    assert.equal(await restored.signedIn('member', added.id), false);
    assert.deepEqual(await restored.list('member'), []);
    await restored.remove('member', added.id);
    assert.equal((await restored.defaults('member')).account, undefined);
    assert.equal((await h.store.index()).accounts?.[added.id], undefined);
  }
});

test('source-pinned closure fixture names exactly 24 B2 tuples and every tuple has a callable key lifecycle', async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/account-keys-typescript.json', import.meta.url), 'utf8'));
  assert.equal(fixture.tuples.length, 24);
  assert.equal(new Set(fixture.tuples.map((r: any) => r.tuple)).size, 24);
  for (const row of fixture.tuples) {
    assert.ok(row.routes.length > 0, row.tuple);
    for (const id of row.routes) {
      assert.ok(['key', 'plan_key'].includes(route(id).via));
      const h = harness();
      const { id: account } = await h.a.add('member', id, { key: canary });
      assert.equal((await h.a.list('member'))[0].id, account);
      await h.a.logout('member', account);
    }
  }
});

test('Auto chooses a plan key, never an API/free/local/unknown key; Default cannot fall back to API billing', async () => {
  const h = harness();
  const plan = await h.a.add('member', 'kimi-code:plan_key', { key: canary });
  await h.a.add('member', 'groq:key', { key: canary });
  const rows = await h.a.list('member');
  const room = () => ({ left: 'unknown' as const });
  assert.equal(chooseAccount(rows, room, Date.now())?.account.id, plan.id);
  const api = rows.find((r) => r.billing === 'api')!;
  const result = resolveSelection(rows, { account: api.id, auto: true }, { account: 'default' }, room, Date.now());
  assert.ok(result.ok && result.account.id === api.id, 'an explicitly saved API default stays selected; no billing switch');
  assert.ok(!resolveSelection([{ ...api, state: 'signed_out' }], { account: api.id }, { account: 'default' }, room, Date.now()).ok, 'Default cannot fall back to an API key');
  assert.ok(resolveSelection(rows, {}, { account: api.id }, room, Date.now()).ok, 'explicit account still allowed');
  for (const billing of ['api', 'free', 'local', 'unknown'] as const) assert.equal(chooseAccount([{ ...api, billing }], room, Date.now()), undefined);
});

test('both pinned compatibility families stream selected account only, with usage, callbacks and typed pass-through', async () => {
  for (const [routeId, api, events, named] of [
    ['groq:key', 'openai-completions', openaiEvents, false],
    ['kimi-code:plan_key', 'anthropic-messages', anthropicEvents, true],
  ] as const) {
    const h = harness();
    const first = await h.a.add('member', routeId, { key: 'not-selected' });
    const selected = await h.a.add('member', routeId, { key: canary });
    let sends = 0;
    let text = '';
    const observed: unknown[] = [];
    const result = await h.a.respond('member', { account: selected.id, model: model(route(routeId).upstream.id, api), context,
      options: { temperature: 0.4, maxTokens: 50, apiKey: 'not-selected', maxRetries: 3,
        fetch: async (_input, init) => {
          sends++;
          const headers = new Headers(init?.headers);
          assert.ok(headers.get('authorization')?.includes(canary) || headers.get('x-api-key') === canary);
          headers.forEach((value) => assert.ok(!value.includes('not-selected')));
          const body = JSON.parse(String(init?.body));
          assert.equal(body.temperature, 0.4);
          return sse([...events], named);
        } }, onText: (delta) => { text += delta; }, onEvent: (event) => observed.push(event) });
    assert.equal(sends, 1);
    assert.equal(text, 'Hello');
    assert.equal(result.stopReason, 'stop');
    assert.deepEqual([result.usage.input, result.usage.output, result.usage.totalTokens], [3, 2, 5]);
    assert.equal(result.provider, route(routeId).upstream.id);
    assert.ok(!JSON.stringify({ result, observed }).includes(canary));
    assert.equal(await h.a.key('member', first.id), 'not-selected', 'no rotation or replacement');
    await assert.rejects(h.a.respondKey('other-member', { account: selected.id, model: model(route(routeId).upstream.id, api), context }), /signed in yet/);
  }
});

test('bearer paste headers and error canaries never borrow API auth; escaping is redacted from public events', async () => {
  const h = harness();
  const token = 'B2-quoted-"-token';
  const { id } = await h.a.add('member', 'anthropic:key:bearer', { key: token });
  const events = anthropicEvents.map((event) => event.type === 'content_block_delta' ? { ...event, delta: { type: 'text_delta', text: token } } : event);
  let text = '';
  const result = await h.a.respondKey('member', { account: id, model: model('anthropic', 'anthropic-messages'), context,
    options: { fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), `Bearer ${token}`);
      assert.equal(headers.get('x-api-key'), null);
      return sse(events, true);
    } }, onText: (delta) => { text += delta; } });
  assert.equal(text, '[redacted]');
  assert.ok(!JSON.stringify(result).includes(token));
});

test('cancelling a running stream terminates it without retry or account rotation', async () => {
  const h = harness();
  const { id } = await h.a.add('member', 'groq:key', { key: canary });
  const abort = new AbortController();
  let sends = 0;
  await assert.rejects(h.a.respondKey('member', { account: id, model: model('groq', 'openai-completions'), context,
    options: { signal: abort.signal, fetch: async (_input, init) => {
      sends++;
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(openaiEvents[0])}\n\n`));
        init?.signal?.addEventListener('abort', () => controller.error(new Error(canary)), { once: true });
      } }), { headers: { 'content-type': 'text/event-stream' } });
    } }, onText: () => abort.abort() }), { code: 'aborted' });
  assert.equal(sends, 1);
  assert.equal(await h.a.signedIn('member', id), true);
});

test('request errors are bounded and never retried; cancellation, wrong provider and unsupported platform precede credentials', async () => {
  const h = harness();
  const { id } = await h.a.add('member', 'groq:key', { key: canary });
  let sends = 0;
  for (const response of [() => new Response(canary, { status: 429 }), () => { throw new Error(canary); }]) {
    await assert.rejects(h.a.respondKey('member', { account: id, model: model('groq', 'openai-completions'), context,
      options: { fetch: async () => { sends++; return response(); } } }), (e: Error) => e instanceof KeyRouteError && !e.message.includes(canary));
  }
  assert.equal(sends, 2, 'one request per attempt, no SDK retry');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(h.a.respondKey('member', { account: id, model: model('groq', 'openai-completions'), context, options: { signal: abort.signal } }));
  let reads = 0;
  const a = new Portable({ keyStore: () => { reads++; throw new Error(canary); } });
  for (const id of ['aws-bedrock:key', 'google-vertex:key', 'azure:key', 'cloudflare:key:cloudflare-workers-ai']) {
    await assert.rejects(a.add('member', id, { key: canary }), { code: 'unsupported_platform' });
  }
  await assert.rejects(a.respondKey('member', { account: 'groq:key', model: model('other', 'openai-completions'), context }), { code: 'provider' });
  await assert.rejects(h.a.respondKey('member', { account: 'aws-bedrock:key', model: model('amazon-bedrock', 'bedrock-converse-stream'), context }), { code: 'needs_host' });
  assert.equal(reads, 0);
});

test('no plaintext fallback or key-store error leakage; failed metadata commit restores the previous secret', async () => {
  const bad = new Accounts({ keyStore: () => ({ get: async () => { throw new Error(canary); }, set: async () => { throw new Error(canary); }, delete: async () => { throw new Error(canary); } }) });
  for (const action of [() => bad.saveKey('member', 'groq:key', canary, { billedPerUse: true }), () => bad.status('member', 'groq:key'), () => bad.logout('member', 'groq:key')]) {
    await assert.rejects(action(), (e: Error) => !e.message.includes(canary));
  }
  await assert.rejects(new Accounts().add('member', 'groq:key', { key: canary }), /Saved keys/);
  const keys = secrets();
  await keys.set('accounts.groq:key', 'old-secret');
  const store = recordStore(async () => ({}), async () => { throw new Error(canary); });
  const a = new Accounts({ keyStore: () => keys, store: () => store });
  await assert.rejects(a.saveKey('member', 'groq:key', canary, { billedPerUse: true }), (e: Error) => !e.message.includes(canary));
  assert.equal(await keys.get('accounts.groq:key'), 'old-secret');
});
