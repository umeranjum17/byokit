// The phone and browser side (portable.ts): no Node import anywhere in it, the shared fixtures, and "Sign in with
// ChatGPT" end to end by device code against a stand-in OpenAI over real HTTP: refresh, sign-out racing a refresh,
// and the phone's secure storage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Accounts, credentialOf, devicePoll, deviceStart, memoryStore, portableEngine, recordStore, secureStore, signInChoices, RefreshRequiredError, type SecureStoreLike } from '../src/portable.ts';
import { mockDevice, mockOpenAI } from '../src/testing/index.ts';
import type { CredentialStore } from '@earendil-works/pi-ai';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/conformance/${name}`, import.meta.url), 'utf8'));
const openai = await mockOpenAI();
const device = await mockDevice();
const brief = await mockDevice({ expiresIn: 1 }); // tokens that die at once, so refresh has to happen
after(() => { openai.close(); device.close(); brief.close(); });
const kit = (store?: ReturnType<typeof memoryStore>, options: Record<string, unknown> = {}) =>
  new Accounts<any, number>({ app: 'Ownvoice', store: () => store ?? memoryStore(), authBase: openai.base, ...options });
/** The phone's sign-in against the provider stand-in, for any provider the catalogue gives device data. */
const phoneKit = (base: string, store?: ReturnType<typeof memoryStore>) => kit(store, { authBase: undefined, deviceBase: base });
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
}

test('portable entry bundles for a browser and can be imported', async () => {
  const result = await build({ entryPoints: [new URL('../src/portable.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(!Object.keys(result.metafile.inputs).some((path) => path.includes('node_modules/@earendil-works/pi-ai/')), 'all portable Pi runtime code is kit-owned artifact');
  // Key routes are opted into through @byokit/accounts/keys; the main graph carries no adapter or vendor SDK.
  assert.deepEqual(Object.keys(result.metafile.inputs).filter((path) => /\/src\/(pi\/|portable-keys)|node_modules\/(openai|@anthropic-ai|@google|@mistralai)\//.test(path)), []);
  const keyed = await build({ entryPoints: [new URL('../src/keys.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(Object.keys(keyed.metafile.inputs).some((path) => path.endsWith('src/portable-keys.ts')), 'the keys entry carries the runtime');
  assert.ok(!Object.keys(keyed.metafile.inputs).some((path) => path.startsWith('node:') || path.includes('node_modules/@earendil-works/pi-ai/')));
  assert.doesNotMatch(result.outputFiles[0].text, /\bimport\s*\(\s*[^'"`]/, 'no non-literal dynamic imports');
  const portable = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assert.equal(portable.routes({ platform: 'rn' }).length, 66);
  assert.equal(portable.route('openai:code', { platform: 'rn' }).readiness, 'ready');
  assert.ok(portable.offered({ platform: 'rn' }).every((r: { billing: string; readiness: string }) => r.billing === 'subscription' && r.readiness === 'ready'));
  const store = portable.memoryStore();
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'token', refresh: 'refresh', expires: Date.now() + 60_000 }));
  assert.equal((await store.read('openai-codex')).access, 'token');
});

test('portable key auth never constructs default discovery context (unresolved require is fatal in Metro)', () => {
  const source = readFileSync(new URL('../src/key-routes.ts', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/runtime\.createModels\(/g)].length, 1);
  assert.match(source, /runtime\.createModels\(\{ authContext \}\)/);
  assert.match(source, /const authContext = \{ env: async \(\) => undefined, fileExists: async \(\) => false \}/);
  // createProvider has no authContext constructor parameter at this pin; it uses the Models-supplied context.
  assert.doesNotMatch(readFileSync(new URL('../src/portable-keys.ts', import.meta.url), 'utf8'), /\bcreate(?:Models|Provider)\s*\(/);
});

test('the shared fixtures: device-code start and poll, token responses', () => {
  const dc = fixture('device-code.json');
  for (const c of dc.start) {
    if (c.error) assert.throws(() => deviceStart(c.status, c.body));
    else assert.deepEqual(deviceStart(c.status, c.body), c.result);
  }
  for (const c of dc.poll) {
    const p = devicePoll(c.status, c.body);
    assert.equal(p.status, c.result, c.body);
    if (p.status === 'complete') assert.deepEqual([p.authorizationCode, p.codeVerifier], [c.authorizationCode, c.codeVerifier]);
  }
  const tr = fixture('token-responses.json');
  for (const c of tr.cases) {
    if (c.error) assert.throws(() => credentialOf(c.response, tr.now));
    else assert.deepEqual(credentialOf(c.response, tr.now), c.credential);
  }
});

test('device and token errors never expose response bodies', async () => {
  const secret = 'secret-refresh-token';
  assert.throws(() => deviceStart(500, secret), (e: Error) => !e.message.includes(secret));
  assert.throws(() => deviceStart(200, JSON.stringify({ device_auth_id: secret })), (e: Error) => !e.message.includes(secret));
  for (const [status, body] of [[200, JSON.stringify({ authorization_code: secret })], [400, JSON.stringify({ error: { code: 'deviceauth_expired', token: secret } })], [500, secret]] as const) {
    const p = devicePoll(status, body);
    assert.equal(p.status, 'failed');
    if (p.status === 'failed') assert.ok(!p.message.includes(secret));
  }
  assert.equal(devicePoll(400, '{"error":{"code":"deviceauth_expired"}}').status, 'failed');
  assert.throws(() => credentialOf({ access_token: secret, refresh_token: secret }), (e: Error) => !e.message.includes(secret));
  const original = globalThis.fetch;
  const store = memoryStore();
  const engine = portableEngine(store);
  try {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/api/accounts/deviceauth/usercode')) return new Response(JSON.stringify({ device_auth_id: 'd', user_code: 'c', interval: 0 }));
      if (path.endsWith('/api/accounts/deviceauth/token')) return new Response(JSON.stringify({ authorization_code: 'a', code_verifier: 'v' }));
      return new Response(secret, { status: 401 });
    }) as typeof fetch;
    await assert.rejects(engine.login('openai-codex', 'oauth', { notify: () => {} } as any), (e: Error) => !e.message.includes(secret));
    await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 }));
    await assert.rejects(engine.getAuth('openai-codex'), (e: Error) => !e.message.includes(secret));
  } finally { globalThis.fetch = original; }
});

test('sign in with ChatGPT by device code: the code and page to show, approved there, kept, plan read', async () => {
  const a = kit();
  assert.deepEqual(a.providers.map((p) => p.key), ['chatgpt', 'grok', 'claude', 'kimi'], 'only what a phone or browser can sign in to, the device ones from catalogue data');
  const v = (await a.login(1, 'chatgpt'))!;
  assert.deepEqual([v.state, v.via, v.url], ['waiting', 'code', `${openai.base}/codex/device`]);
  assert.match(v.code!, /^MOCK-/);
  assert.ok(v.expiresAt! > Date.now());
  assert.equal((await a.status(1, 'chatgpt')).words, 'Signing in to ChatGPT…');
  // The person types the code on the provider's page.
  const typed = await fetch(`${openai.base}/codex/device`, { method: 'POST', body: new URLSearchParams({ user_code: v.code! }) });
  assert.match(await typed.text(), /Signed in/);
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt')!.state, 'done');
  assert.equal((await a.status(1, 'chatgpt')).words, 'ChatGPT is connected.');
  assert.deepEqual(await a.plan(1), { plan: 'plus', email: 'sara@example.com', work: false });
  assert.equal(await a.signedIn(2, 'chatgpt'), false, 'one person, one store');
});

test("a poll that can't get through (a backgrounded phone) waits for the next instead of failing", async () => {
  const a = kit();
  openai.state.dropPolls = 2;
  const v = (await a.login(1, 'chatgpt'))!;
  await until('both polls dropped', () => openai.state.dropPolls === 0);
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt')!.state, 'done');
});

test('any provider the catalogue gives device data signs in on the phone, with no provider of its own', async () => {
  // The picker offers what the catalogue says; nothing here names a provider in code.
  assert.deepEqual(signInChoices().map((p) => p.key), ['grok', 'kimi']);
  for (const key of ['grok', 'kimi']) {
    const a = phoneKit(device.base);
    const v = (await a.login(1, key))!;
    assert.deepEqual([v.state, v.via, v.url], ['waiting', 'code', `${device.base}/activate`], `${key}: the code and the page to open, no browser redirect`);
    assert.match(v.code!, /^FIXTURE-/);
    // The person approves the sign-in on their own phone, on the provider's page.
    assert.equal(device.approve(v.code!), true);
    await a.finished(1, key);
    assert.equal((await a.status(1, key)).state, 'ready', `${key}: signed in`);
    const [row] = await a.list(1);
    assert.deepEqual([row.provider, row.billing], [key, 'subscription']);
    // Signing out ends it here; nothing is sent anywhere the provider didn't document.
    await a.logout(1, key);
    assert.equal(await a.signedIn(1, key), false);
    a.stop();
  }
  // A provider that hands out a short-lived token is refreshed before the next run needs it, and a decline keeps nothing.
  const a = phoneKit(brief.base);
  const v = (await a.login(1, 'grok'))!;
  brief.approve(v.code!);
  await a.finished(1, 'grok');
  await a.keepFresh([1]);
  assert.equal((await a.status(1, 'grok')).state, 'ready', 'refreshed on the provider\'s own token endpoint');
  assert.ok(brief.state.requests.some((r) => r.body.includes('grant_type=refresh_token')));
  const declined = (await a.login(1, 'kimi'))!;
  brief.approve(declined.code!, true);
  await a.finished(1, 'kimi');
  assert.match(a.view(1, 'kimi')!.error!, /declined/i, 'one plain sentence about what the person did');
  assert.equal(await a.signedIn(1, 'kimi'), false);
  a.stop();
});

test('declined on the page, cancelled here, or refused at the exchange: one plain sentence, nothing kept', async () => {
  const a = kit();
  let v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!, true);
  await a.finished(1, 'chatgpt');
  assert.deepEqual([a.view(1, 'chatgpt')!.why, a.view(1, 'chatgpt')!.error], ['declined', 'The sign-in was declined on the ChatGPT page. Tap Sign in with ChatGPT to try again.']);
  v = (await a.login(1, 'chatgpt'))!;
  a.cancel(1, 'chatgpt');
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt'), null);
  openai.approve(v.code!);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await a.signedIn(1, 'chatgpt'), false, 'approving a cancelled code signs nobody in');
});

test('cancelling during a delayed credential write leaves nothing stored', async () => {
  const base = memoryStore();
  let entered!: () => void;
  let release!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow: CredentialStore = { ...base, modify: (id, fn) => base.modify(id, async (current) => {
    const next = await fn(current);
    if (next && !current) { entered(); await gate; }
    return next;
  }) };
  const a = new Accounts<any, number>({ store: () => slow, authBase: openai.base });
  const v = (await a.login(1, 'chatgpt'))!;
  const done = a.finished(1, 'chatgpt');
  openai.approve(v.code!);
  try {
    await writing;
    a.cancel(1, 'chatgpt');
    release();
    await done;
    assert.equal(await base.read('openai-codex'), undefined);
    assert.equal(a.view(1, 'chatgpt'), null);
  } finally { release(); }
});

test('refresh: ahead of expiry, rotating, one at a time; a refusal signs out once; recheck keeps a sign-in that refreshes', async () => {
  const store = memoryStore();
  const a = kit(store);
  const expired: number[] = [];
  a.onExpired = (m) => expired.push(m);
  openai.state.expiresIn = 1800; // half an hour: inside keepFresh's hour
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  const first = (await store.read('openai-codex')) as any;
  openai.state.expiresIn = 864_000;
  await Promise.all([a.keepFresh([1]), a.keepFresh([1])]);
  const second = (await store.read('openai-codex')) as any;
  assert.notEqual(second.refresh, first.refresh, 'refreshed');
  assert.equal(openai.state.requests.filter((r) => r.body.includes('grant_type=refresh_token')).length, 1, 'once, not twice');
  openai.state.expiresIn = 1800;
  await a.keepFresh([1]);
  assert.equal((await a.status(1, 'chatgpt')).state, 'ready', 'a shorter successful refresh stays signed in');
  assert.deepEqual(expired, []);
  assert.equal(await a.recheck(1, 'chatgpt'), true, 'a sign-in that still refreshes is kept');
  assert.equal(await a.signedIn(1, 'chatgpt'), true);
  openai.state.expiresIn = 1800;
  assert.equal(await a.recheck(1, 'chatgpt'), true);
  openai.state.refuse = true;
  await a.keepFresh([1]);
  await a.keepFresh([1]);
  assert.deepEqual(expired, [1], 'said once');
  assert.equal((await a.status(1, 'chatgpt')).state, 'needs_again');
  Object.assign(openai.state, { refuse: false, expiresIn: 864_000 });
});

test('refresh transaction fixtures: uncertain and terminal generations survive reconstruction without replay', async () => {
  const original = globalThis.fetch;
  const response = fixture('token-responses.json').cases[0].response;
  const old = { ...credentialOf(response), expires: 0, extension: 'preserved' };
  try {
    for (const row of fixture('refresh-typescript.json').cases) {
      let data: any = { 'openai-codex': old };
      let writes = 0;
      let sends = 0;
      const store = () => recordStore(async () => structuredClone(data), async (next) => {
        writes++;
        if (row.outcome === 'attempt-save-failure' || (row.outcome === 'commit-failure' && writes > 1)) throw new Error('synthetic storage failure');
        data = structuredClone(next);
      });
      globalThis.fetch = async () => {
        sends++;
        assert.deepEqual(data['openai-codex'].byokitRefresh, { generation: 0, state: 'attempted' }, 'attempt saved before send');
        if (row.outcome === 'lost-response') throw new Error('synthetic lost response with canary-secret');
        if (row.status) return new Response('canary-secret', { status: row.status });
        return new Response(JSON.stringify({ ...response, refresh_token: row.outcome === 'unchanged-grant' ? old.refresh : 'rotated-grant' }));
      };
      await assert.rejects(portableEngine(store()).getAuth('openai-codex'), (e: Error) => {
        assert.doesNotMatch(e.message, /canary-secret/);
        return row.outcome === 'attempt-save-failure' || e instanceof RefreshRequiredError;
      });
      // A new engine AND a new store identity over the same persisted record lose all process-local state.
      const restarted = portableEngine(store());
      if (row.state) {
        assert.equal(data['openai-codex'].byokitRefresh.state, row.state, row.outcome);
        assert.equal(await restarted.checkAuth('openai-codex'), undefined);
      }
      await assert.rejects(restarted.getAuth('openai-codex', { minOAuthValidityMs: 365 * 86_400_000 }));
      assert.equal(sends, row.sends, row.outcome);
      assert.equal(data['openai-codex'].refresh, old.refresh, 'old pair never handed out after an attempt');
    }
  } finally { globalThis.fetch = original; }
});

test('refresh holds the store lock across both commits, re-reads when queued, and fresh sign-in replaces quarantine', async () => {
  const original = globalThis.fetch;
  const response = fixture('token-responses.json').cases[0].response;
  const old = { ...credentialOf(response), expires: 0, extension: 'preserved' };
  const store = memoryStore();
  await store.modify('openai-codex', async () => old);
  let sends = 0;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const sending = new Promise<void>((r) => { entered = r; });
  try {
    globalThis.fetch = async () => {
      sends++;
      entered();
      await gate;
      return new Response(JSON.stringify({ ...response, refresh_token: 'rotated-grant' }));
    };
    const first = portableEngine(store).getAuth('openai-codex');
    await sending;
    const second = portableEngine(store).getAuth('openai-codex');
    const checking = portableEngine(store).checkAuth('openai-codex');
    release();
    const auth = await Promise.all([first, second]);
    assert.equal(sends, 1);
    assert.deepEqual(auth[0], auth[1]);
    assert.deepEqual(await checking, { source: 'OAuth', type: 'oauth' }, 'a status check waits for the active refresh');
    const committed: any = await store.read('openai-codex');
    assert.equal(committed.refresh, 'rotated-grant');
    assert.equal(committed.extension, 'preserved');
    assert.deepEqual(committed.byokitRefresh, { generation: 1, state: 'ready' });
    // A second generation can rotate, but never the old grant.
    globalThis.fetch = async (_url, init) => {
      sends++;
      assert.equal(new URLSearchParams(String(init?.body)).get('refresh_token'), 'rotated-grant');
      throw new Error('lost response');
    };
    await assert.rejects(portableEngine(store).getAuth('openai-codex', { minOAuthValidityMs: 365 * 86_400_000 }), RefreshRequiredError);
    assert.deepEqual((await store.read('openai-codex') as any).byokitRefresh, { generation: 1, state: 'uncertain' });
    await store.modify('openai-codex', async () => credentialOf(response));
    assert.ok(await portableEngine(store).getAuth('openai-codex'), 'fresh sign-in can be used');
    assert.equal(sends, 2);
    // A refresh queued behind a store mutation must use its fresh read.
    await store.modify('openai-codex', async () => old);
    const signin = store.modify('openai-codex', async () => credentialOf(response));
    const queued = portableEngine(store).getAuth('openai-codex');
    await signin;
    assert.ok(await queued);
    assert.equal(sends, 2, 'queued refresh saw the replacement sign-in, not the stale pair');
  } finally { release(); globalThis.fetch = original; }
});

test('secureStore: a process lost between refresh send and pair commit restarts into re-auth', async () => {
  const original = globalThis.fetch;
  const response = fixture('token-responses.json').cases[0].response;
  const kept = new Map<string, string>();
  let crash = false;
  const secure: SecureStoreLike = {
    getItemAsync: async (k) => kept.get(k) ?? null,
    setItemAsync: async (k, v) => { if (crash) throw new Error('synthetic process lost'); kept.set(k, v); },
    deleteItemAsync: async (k) => { kept.delete(k); },
  };
  const s = secureStore(secure, 'byokit.transaction');
  await s.modify('openai-codex', async () => ({ ...credentialOf(response), expires: 0 }));
  let sends = 0;
  try {
    globalThis.fetch = async () => {
      sends++;
      const marker: any = await secureStore(secure, 'byokit.transaction').read('openai-codex');
      assert.equal(marker.byokitRefresh.state, 'attempted');
      crash = true;
      return new Response(JSON.stringify({ ...response, refresh_token: 'rotated-grant' }));
    };
    await assert.rejects(portableEngine(s).getAuth('openai-codex'), RefreshRequiredError);
    crash = false;
    const restarted = portableEngine(secureStore(secure, 'byokit.transaction'));
    await assert.rejects(restarted.getAuth('openai-codex'), RefreshRequiredError);
    assert.equal(sends, 1, 'the possibly spent grant was not replayed after restart');
  } finally { globalThis.fetch = original; }
});

test('portable refresh refuses a custom store without a before-send transaction', async () => {
  const original = globalThis.fetch;
  const complete = memoryStore();
  await complete.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 }));
  const { refresh: _refresh, end: _end, ...bare } = complete;
  let sends = 0;
  try {
    globalThis.fetch = async () => { sends++; throw new Error('must not send'); };
    await assert.rejects(portableEngine(bare).getAuth('openai-codex'), /transactional credential store/);
    assert.equal(sends, 0);
  } finally { globalThis.fetch = original; }
});

test('signing out while a refresh is under way: the sign-out wins, nothing comes back', async () => {
  const store = memoryStore();
  const a = kit(store);
  openai.state.expiresIn = 60; // already inside the five-minute window
  const earlier = new Set(openai.state.live);
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  const rt = await a.runtime(1);
  const refreshing = rt.getAuth('openai-codex');
  await a.logout(1, 'chatgpt');
  await refreshing.catch(() => {});
  assert.equal(await store.read('openai-codex'), undefined);
  assert.deepEqual([...openai.state.live].filter((t) => !earlier.has(t)), [], 'the token a refresh rotated to was the one ended at OpenAI');
  assert.equal(await rt.getAuth('openai-codex'), undefined, 'no refresh after sign-out');
  assert.equal(await a.signedIn(1, 'chatgpt'), false);
  openai.state.expiresIn = 864_000;
});

test('a refresh queued during revoke cannot rotate the signed-out token', async () => {
  const store = memoryStore();
  const a = kit(store);
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  const rt = await a.runtime(1);
  const original = globalThis.fetch;
  let entered!: () => void;
  let release!: () => void;
  const revoking = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/oauth/revoke')) { entered(); return gate.then(() => original(input, init)); }
      return original(input, init);
    }) as typeof fetch;
    const signout = a.logout(1, 'chatgpt');
    await revoking;
    const refresh = rt.getAuth('openai-codex', { minOAuthValidityMs: 365 * 86_400_000 });
    release();
    await signout;
    assert.equal(await refresh, undefined);
    assert.equal(await store.read('openai-codex'), undefined);
  } finally { release(); globalThis.fetch = original; }
});

test('portable store accepts React Native-style AbortSignal without throwIfAborted and rejects an aborted write', async () => {
  let data: any = {};
  const store = recordStore(async () => data, async (next) => { data = next; });
  const signal = { aborted: false } as AbortSignal;
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }), { signal });
  assert.equal((await store.read('openai-codex'))?.type, 'oauth');
  await assert.rejects(store.modify('other', async () => {
    (signal as any).aborted = true;
    return { type: 'oauth', access: 'b', refresh: 'r', expires: 1 };
  }, { signal }));
  assert.equal(await store.read('other'), undefined);
});

test('secureStore passes the same options to every get, set and delete', async () => {
  const seen: unknown[] = [];
  const kept = new Map<string, string>();
  const options = { keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' };
  const secure: SecureStoreLike = {
    getItemAsync: async (k, o) => { seen.push(o); return kept.get(k) ?? null; },
    setItemAsync: async (k, v, o) => { seen.push(o); kept.set(k, v); },
    deleteItemAsync: async (k, o) => { seen.push(o); kept.delete(k); },
  };
  const s = secureStore(secure, 'byokit.9', options);
  await s.modify('openai-codex', async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 1 }));
  await s.read('openai-codex');
  await s.delete('openai-codex');
  assert.ok(seen.length > 0, 'every call recorded its options');
  for (const o of seen) assert.equal(o, options);
});

test('a locked-keychain read is unknown, not expiry: keepFresh fires no onExpired', async () => {
  const base = memoryStore();
  const a = kit(base);
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  assert.equal(await a.signedIn(1, 'chatgpt'), true);
  // The phone locks: every Keychain read fails, although the sign-in is still valid.
  const read = base.read;
  (base as { read: typeof read }).read = async () => { throw new Error('User interaction is not allowed'); };
  try {
    let fired = 0;
    a.onExpired = () => { fired++; };
    await a.keepFresh([1]);
    assert.equal(fired, 0, 'no onExpired for a locked keychain');
    assert.notEqual((await a.status(1, 'chatgpt')).state, 'needs_again');
  } finally {
    (base as { read: typeof read }).read = read;
  }
});

test('secureStore: chunked under the size expo-secure-store allows, and a crash mid-write keeps the old sign-ins', async () => {
  const kept = new Map<string, string>();
  let failAfter = Infinity;
  const secure: SecureStoreLike = {
    getItemAsync: async (k) => kept.get(k) ?? null,
    setItemAsync: async (k, v) => { assert.match(k, /^[\w.-]+$/); assert.ok(v.length <= 2048); if (failAfter-- <= 0) throw new Error('crash'); kept.set(k, v); },
    deleteItemAsync: async (k) => { kept.delete(k); },
  };
  const a = kit(secureStore(secure, 'byokit.1'));
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  assert.equal(await a.signedIn(1, 'chatgpt'), true);
  const s = secureStore(secure, 'byokit.1');
  const before = await s.read('openai-codex');
  assert.ok(JSON.stringify(before).length > 1800, 'a real sign-in spans pieces');
  failAfter = 1;
  await assert.rejects(s.modify('openai-codex', async () => ({ type: 'oauth', access: 'x'.repeat(4000), refresh: 'r', expires: 1 })));
  assert.deepEqual(await secureStore(secure, 'byokit.1').read('openai-codex'), before);
  failAfter = Infinity;
  await s.delete('openai-codex');
  assert.deepEqual([...kept.keys()], ['byokit.1'], 'old pieces cleaned up');
});

test('official token-sharing adapter checks consent on every use and keeps sessions per person', async () => {
  const { chatgptPlan, UnsupportedAccountError } = await import('../src/chatgpt-plan.ts');
  const scopes = ['resource.invoke', 'chatgpt.tokens.use.direct'];
  let session = { accessToken: 'person-one', scopes };
  const one = chatgptPlan({ session: async () => session });
  const two = chatgptPlan({ session: async () => ({ accessToken: 'person-two', scopes }) });
  const signal = new AbortController().signal;
  assert.equal(one.billing, 'subscription');
  assert.equal(await one.access(signal), 'person-one');
  assert.equal(await two.access(signal), 'person-two');
  session = { accessToken: 'rotated-one', scopes };
  assert.equal(await one.access(signal), 'rotated-one', 'host refresh is consulted every use');
  session = { accessToken: 'secret-that-must-not-appear', scopes: ['openid'] };
  await assert.rejects(one.access(signal), (e: Error) => e instanceof UnsupportedAccountError &&
    e.code === 'unsupported_account' && !e.message.includes(session.accessToken));
});
