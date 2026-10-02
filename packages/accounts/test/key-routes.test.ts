import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, recordStore, routes, route, chooseAccount, resolveSelection, KeyRouteError, computer, portable, type AccountMetadata, type Api, type Model, type Context } from '../src/index.ts';
import { Accounts as Portable } from '../src/portable.ts';
import { keys, withKeys } from '../src/keys.ts';
import type { Record as CredentialRecord } from '../src/stores.ts';
import type { Keystore } from '@byokit/secrets';
import streamFixture from '../../../fixtures/conformance/pi-streams.json' with { type: 'json' };

const canary = 'B2-exact-secret-canary-987654321';
function secrets(): Keystore {
  const data = new Map<string, string>();
  return { get: async (id) => data.get(id) ?? null, set: async (id, value) => { data.set(id, value); }, delete: async (id) => data.delete(id) };
}
function harness(Kit: typeof Accounts | typeof Portable = Accounts) {
  let data: CredentialRecord = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  const keys = new Map<string, Keystore>();
  const keyStore = (member: string | number) => {
    const id = String(member);
    if (!keys.has(id)) keys.set(id, secrets());
    return keys.get(id)!;
  };
  const opts = { store: () => store, keyStore };
  return { a: Kit === Portable ? new Portable(opts, withKeys(portable)) : new Kit(opts), opts, store, keyStore, data: () => data };
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
  for (const billing of ['api', 'free', 'local', 'unknown'] as const) {
    assert.equal(chooseAccount([{ ...api, billing }], room, Date.now()), undefined);
    assert.ok(!resolveSelection([{ ...api, billing, provider: 'custom' }], { account: api.id }, { account: 'default' }, room, Date.now()).ok, `custom/endpoint ${billing} default refused`);
    if (billing !== 'api') assert.ok(!resolveSelection([{ ...api, billing }], { account: api.id }, { account: 'default' }, room, Date.now()).ok, `${billing} is not an explicit saved API default`);
  }
  assert.ok(!resolveSelection([api], {}, { account: 'default' }, room, Date.now()).ok, 'no automatic API discovery/fallback without an explicit saved default');
});

test('both pinned compatibility families stream on Node and portable, selected account only, with usage, callbacks and typed pass-through', async () => {
  for (const Kit of [Accounts, Portable]) for (const [routeId, api, events, named] of [
    ['groq:key', 'openai-completions', openaiEvents, false],
    ['kimi-code:plan_key', 'anthropic-messages', anthropicEvents, true],
  ] as const) {
    const h = harness(Kit);
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

test('saved key auth cannot be shadowed by model or options headers, but non-auth headers pass through', async () => {
  for (const Kit of [Accounts, Portable]) for (const [id, api, events, named] of [['groq:key', 'openai-completions', openaiEvents, false], ['kimi-code:plan_key', 'anthropic-messages', anthropicEvents, true]] as const) {
    const h = harness(Kit);
    const added = await h.a.add('member', id, { key: canary });
    const shadow = { AUTHORIZATION: 'Bearer not-selected', 'X-Api-Key': 'not-selected', 'Api-Key': 'not-selected', 'X-Goog-Api-Key': 'not-selected' };
    let selected = false; let nonAuth = false; let shadowed = false;
    await h.a.respondKey('member', { account: added.id, model: { ...model(route(id).upstream.id, api), headers: shadow }, context,
      options: { headers: { ...shadow, 'x-app': 'explicit' }, fetch: async (_input, init) => {
        const headers = new Headers(init?.headers);
        selected = headers.get('authorization')?.includes(canary) === true || headers.get('x-api-key') === canary;
        nonAuth = headers.get('x-app') === 'explicit';
        headers.forEach((value) => { if (value.includes('not-selected')) shadowed = true; });
        return sse([...events], named);
      } } });
    assert.equal(selected, true);
    assert.equal(nonAuth, true);
    assert.equal(shadowed, false);
  }
});

test('prebuilt clients are explicitly refused before selected-account secrets; native typed factories retain them', async () => {
  for (const [Kit, platform] of [[Accounts, computer], [Portable, withKeys(portable)]] as const) {
    const h = harness(Kit);
    const { id } = await h.a.add('member', 'kimi-code:plan_key', { key: canary });
    let clients = 0; let sends = 0; let opens = 0;
    const client = { beta: { messages: { create: () => { clients++; return { asResponse: async () => sse(anthropicEvents, true) }; } } } } as any;
    const guarded = new Kit({ ...h.opts, keyStore: () => { opens++; throw new Error(canary); } }, platform);
    await assert.rejects(guarded.respondKey('member', { account: id, model: model('kimi-coding', 'anthropic-messages'), context,
      options: { client, fetch: async () => { sends++; return sse(anthropicEvents, true); } } }), { code: 'auth_override' });
    assert.deepEqual([clients, sends, opens], [0, 0, 0]);
    // Explicit native use owns its authentication: the stock option/hook API is not downgraded by the guard.
    const runtime = await platform.keys!();
    const native = runtime.createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
    const chosen = model('native-fixture', 'anthropic-messages');
    native.setProvider(runtime.createProvider({ id: chosen.provider, models: [chosen], api: await runtime.api(chosen.api),
      auth: { apiKey: { name: 'native', resolve: async () => ({ auth: { apiKey: 'explicit-native-key' } }) } } }));
    let payloads = 0; let responses = 0;
    const answer = await native.complete(chosen, context, { client, temperature: 0.4,
      onPayload: () => { payloads++; }, onResponse: () => { responses++; } });
    assert.equal(answer.stopReason, 'stop');
    assert.deepEqual([clients, payloads, responses], [1, 1, 1]);
  }
});

test('Cloudflare gateway uses pinned header-only auth and explicit endpoint ids, not downstream keys', async () => {
  const h = harness();
  const { id } = await h.a.add('member', 'cloudflare:key:cloudflare-ai-gateway', { key: canary });
  let scoped = false;
  const answer = await h.a.respondKey('member', { account: id,
    model: { ...model('cloudflare-ai-gateway', 'openai-completions'), baseUrl: 'https://fixture.invalid/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/v1' }, context,
    options: { env: { CLOUDFLARE_ACCOUNT_ID: 'account', CLOUDFLARE_GATEWAY_ID: 'gateway' }, headers: { 'CF-AIG-Authorization': 'Bearer not-selected' },
      fetch: async (input, init) => {
        assert.equal(String(input), 'https://fixture.invalid/account/gateway/v1/chat/completions');
        const headers = new Headers(init?.headers);
        scoped = headers.get('cf-aig-authorization') === `Bearer ${canary}` && !headers.has('authorization') && !headers.has('x-api-key');
        return sse(openaiEvents);
      } } });
  assert.equal(answer.stopReason, 'stop');
  assert.equal(scoped, true);
});

test('Google uses global fetch, not the Accounts default; explicit custom fetch keeps pinned refusal (Vertex too)', async () => {
  const original = globalThis.fetch;
  try {
    for (const [Kit, id, api] of [[Accounts, 'google-ai-studio:key', 'google-generative-ai'], [Portable, 'google-ai-studio:key', 'google-generative-ai'], [Accounts, 'google-vertex:key', 'google-vertex']] as const) {
      const h = harness(Kit);
      let globals = 0; let defaults = 0; let explicit = 0;
      globalThis.fetch = async () => {
        globals++;
        return new Response(streamFixture.families.google.events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      };
      const a = new Kit({ ...h.opts, fetch: async () => { defaults++; throw new Error('default fetch must not be passed to Google'); } }, Kit === Portable ? withKeys(portable) : computer);
      const added = await a.add('member', id, { key: canary });
      const query = { account: added.id, model: model(route(id).upstream.id, api), context: streamFixture.context as Context };
      const answer = await a.respondKey('member', query);
      assert.equal(answer.stopReason, 'toolUse');
      assert.deepEqual([answer.usage.input, answer.usage.output, answer.usage.totalTokens], [3, 2, 5]);
      assert.equal(globals, 1);
      assert.equal(defaults, 0);
      await assert.rejects(a.respondKey('member', { ...query, options: { fetch: async () => { explicit++; throw new Error(canary); } } }), { code: 'request' });
      assert.equal(explicit, 0, 'upstream refuses explicit custom fetch before transport');
      assert.equal(globals, 1);
    }
  } finally { globalThis.fetch = original; }
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
  const a = new Portable({ keyStore: () => { reads++; throw new Error(canary); } }, withKeys(portable));
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

test('the main portable entry has no key runtime: key requests need @byokit/accounts/keys, refused before secrets', async () => {
  assert.equal(portable.keys, undefined);
  let reads = 0;
  const bare = new Portable({ keyStore: () => { reads++; throw new Error(canary); } });
  await assert.rejects(bare.respondKey('member', { account: 'groq:key', model: model('groq', 'openai-completions'), context }), { code: 'needs_keys' });
  assert.equal(reads, 0);
  // Storage and discovery need no runtime; only answering does.
  const h = harness();
  const plain = new Portable(h.opts);
  const { id } = await plain.add('member', 'groq:key', { key: canary });
  assert.ok((await plain.list('member')).some((a) => a.id === id));
  const withRuntime = withKeys(portable);
  assert.equal(withRuntime.engine, portable.engine);
  assert.equal(withRuntime.keys, keys);
  assert.deepEqual((await keys()).supported, (await computer.keys!()).supported.filter((api) => api !== 'google-vertex'));
});
