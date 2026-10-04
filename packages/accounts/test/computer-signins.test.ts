import { test, after, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import type { AddressInfo } from 'node:net';
import type { Keystore } from '@byokit/secrets';
import fixture from '../../../fixtures/conformance/computer-signins-typescript.json' with { type: 'json' };
import { Accounts, computer, memoryStore, route, provider, billingWords, chooseAccount } from '../src/index.ts';
import { Accounts as Portable } from '../src/portable.ts';

const realFetch = globalThis.fetch;
const flush = async () => { for (let n = 0; n < 8; n++) await setImmediate(); };
const canaries = /device-secret-canary|access-secret-canary|refresh-secret-canary|api-key-secret-canary|setup-token-secret-canary/;
function keys() {
  const values = new Map<string, string>();
  const store: Keystore = {
    get: async (name) => values.get(name) ?? null,
    set: async (name, value) => { values.set(name, value); },
    delete: async (name) => values.delete(name),
  };
  return { values, store };
}
function offline(t: TestContext, respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const logs: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logs.push(args); });
  t.mock.method(globalThis, 'fetch', (input: RequestInfo | URL, init?: RequestInit) => respond(String(input instanceof Request ? input.url : input), init));
  t.after(() => assert.doesNotMatch(JSON.stringify(logs), canaries));
}

/** Only the fixture listener changes: SDK source and registered redirect URI stay intact. Never bind
 *  its fixed product ports, even when another app owns them. Each listener uses an OS-assigned port. */
// Anthropic caches the imported factory. Keep one factory for this isolated test process and
// switch only the current fixture context, rather than leaving an SDK cache with a stale mock.
let callbackContext: { listeners: Map<number, Server>; busyPort?: number };
const create = http.createServer;
const mockedCreate = mock.method(http, 'createServer', (...args: any[]) => {
  const context = callbackContext;
  assert.ok(context, 'a callback fixture must own every listener');
  const server = create(...args);
  const listen = server.listen.bind(server);
  server.listen = ((port: number, host: string, done: () => void) => {
    context.listeners.set(port, server);
    if (port === context.busyPort) {
      queueMicrotask(() => server.emit('error', Object.assign(new Error('fixture port unavailable'), { code: 'EADDRINUSE' })));
      return server;
    }
    return listen(0, '127.0.0.1', done);
  }) as typeof server.listen;
  return server;
});
syncBuiltinESMExports();
after(() => { mockedCreate.mock.restore(); syncBuiltinESMExports(); });
function callbacks(t: TestContext, busyPort?: number) {
  const listeners = new Map<number, Server>();
  callbackContext = { listeners, busyPort };
  t.after(() => { for (const server of listeners.values()) server.close(); });
  return {
    async back(registeredPort: number, path: string) {
      const server = listeners.get(registeredPort);
      assert.ok(server?.listening);
      const address = server.address() as AddressInfo;
      return realFetch(`http://127.0.0.1:${address.port}${path}`);
    },
    listeners,
  };
}

for (const device of fixture.devices) {
  test(`${device.key}: real pinned RFC 8628 driver waits, slows down, stores only credentials and refreshes`, { timeout: 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
    const polls: number[] = [];
    let mint = 0;
    offline(t, (url, init) => {
      const body = new URLSearchParams(String(init?.body));
      if (url === device.start) { assert.equal(body.get('client_id'), device.clientId); return Response.json(fixture.device); }
      if (url === device.poll && body.get('grant_type') === 'refresh_token') {
        assert.equal(body.get('refresh_token'), fixture.token.refresh_token);
        return Response.json({ ...fixture.token, refresh_token: `${fixture.token.refresh_token}-2` });
      }
      if (url === device.poll) {
        assert.equal(body.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code');
        assert.equal(body.get('device_code'), fixture.device.device_code);
        assert.equal(body.get('client_id'), device.clientId);
        polls.push(Date.now());
        if (polls.length < 3) return Response.json({ error: polls.length === 1 ? 'authorization_pending' : 'slow_down' }, { status: 400 });
        return Response.json(fixture.token);
      }
      if (url === 'https://api.meta.ai/muse-code/key') {
        assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${fixture.token.access_token}`);
        mint++;
        return Response.json({ api_key: fixture.apiKey });
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const store = memoryStore();
    const a = new Accounts({ offer: [device.key], store: (member) => member === 1 ? store : memoryStore() });
    t.after(() => a.stop());
    const shown = await a.login(1, device.key);
    assert.equal(shown?.via, 'code');
    assert.equal(shown?.code, fixture.device.user_code);
    assert.doesNotMatch(JSON.stringify(shown), canaries);
    assert.equal(await a.signedIn(1, device.key), false);
    await flush();
    assert.equal(polls.length, 0);
    for (const ms of [1000, 1000, 6000]) { t.mock.timers.tick(ms); await flush(); }
    await a.finished(1, device.key);
    assert.deepEqual(polls.map((time) => time - polls[0]), [0, 1000, 7000]);
    assert.equal(a.view(1, device.key)?.state, 'done');
    assert.equal(await a.signedIn(2, device.key), false);
    const credential = await store.read(device.provider);
    assert.equal(credential?.type, 'oauth');
    if (credential?.type === 'oauth') {
      assert.equal(credential.access, device.key === 'meta' ? fixture.apiKey : fixture.token.access_token);
      assert.equal(credential.refresh, device.key === 'meta' ? fixture.token.access_token : fixture.token.refresh_token);
    }
    assert.doesNotMatch(JSON.stringify([await a.list(1), await a.status(1, device.key), await store.index()]), canaries);
    // Pi's typed pass-through refresh uses the same stored credential, no second runtime.
    t.mock.timers.tick(device.key === 'meta' ? 86_400_001 : 3_600_001);
    await (await a.runtime(1)).getAuth(device.provider);
    if (device.key === 'meta') assert.equal(mint, 2);
    else {
      const refreshed = await store.read(device.provider);
      assert.equal(refreshed?.type === 'oauth' && refreshed.refresh, `${fixture.token.refresh_token}-2`);
    }
    await a.logout(1, device.key);
    assert.equal(await store.read(device.provider), undefined);
  });

  for (const error of ['access_denied', 'expired_token', 'cancel'] as const) {
    test(`${device.key}: ${error} never commits a partial device login`, { timeout: 10_000 }, async (t) => {
      t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1_800_000_000_000 });
      offline(t, (url) => {
        if (url === device.start) return Response.json(fixture.device);
        if (url === device.poll) return Response.json({ error }, { status: 400 });
        throw new Error(`Unexpected fixture request: ${url}`);
      });
      const store = memoryStore();
      const a = new Accounts({ offer: [device.key], store: () => store });
      t.after(() => a.stop());
      await a.login(1, device.key);
      await flush();
      if (error === 'cancel') a.cancel(1, device.key);
      else t.mock.timers.tick(1000);
      await flush();
      await a.finished(1, device.key);
      assert.equal(await a.signedIn(1, device.key), false);
      assert.deepEqual(await store.list(), []);
      assert.doesNotMatch(JSON.stringify(a.view(1, device.key)), canaries);
    });
  }
}

test('Claude explicit computer browser route: pinned callback/state/PKCE, plan namespace, listener cleanup', async (t) => {
  const callback = callbacks(t);
  let exchange: Record<string, string> | undefined;
  offline(t, (url, init) => {
    assert.equal(url, fixture.anthropic.token);
    exchange = JSON.parse(String(init?.body));
    return Response.json(fixture.token);
  });
  const store = memoryStore();
  const a = new Accounts({ offer: ['claude', 'anthropic'], store: () => store });
  t.after(() => a.stop());
  const added = await a.add(1, 'claude', { via: 'browser' });
  const shown = added.signIn!;
  const authorize = new URL(shown.url!);
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://localhost:53692/callback');
  const state = authorize.searchParams.get('state')!;
  assert.equal((await callback.back(53692, '/callback?code=good&state=forged')).status, 400);
  assert.equal(a.view(1, added.id)?.state, 'waiting');
  assert.equal((await callback.back(53692, `/callback?code=good&state=${state}`)).status, 200);
  await a.finished(1, added.id);
  assert.equal(a.view(1, added.id)?.state, 'done');
  assert.equal(exchange?.code_verifier, state);
  assert.equal(exchange?.state, state);
  assert.equal(exchange?.redirect_uri, 'http://localhost:53692/callback');
  assert.equal((await store.read('byokit-claude-plan'))?.type, 'oauth');
  assert.equal(await store.read('anthropic'), undefined, 'no subscription in the API namespace');
  assert.equal(callback.listeners.get(53692)?.listening, false);
  assert.doesNotMatch(JSON.stringify([await a.list(1), await store.index()]), canaries);
  assert.equal(route('anthropic:browser').readiness, 'ready');
});

test('Claude browser bind failure is busy, never displaces a listener or starts a different flow', async (t) => {
  const callback = callbacks(t, 53692);
  offline(t, () => { throw new Error('No provider exchange before callback readiness'); });
  const store = memoryStore();
  const a = new Accounts({ offer: ['claude'], store: () => store });
  t.after(() => a.stop());
  const shown = await a.login(1, 'claude', { via: 'browser' });
  assert.equal(shown?.state, 'failed');
  assert.equal(shown?.why, 'busy');
  assert.equal(callback.listeners.get(53692)?.listening, false);
  assert.deepEqual(await store.list(), []);
});

test('Claude browser cancellation forwards abort to the pending paste prompt and closes the pinned listener', async (t) => {
  const callback = callbacks(t);
  offline(t, () => { throw new Error('Cancelled sign-in must not exchange a token'); });
  const store = memoryStore();
  const a = new Accounts({ offer: ['claude'], store: () => store });
  t.after(() => a.stop());
  await a.login(1, 'claude', { via: 'browser' });
  const finished = a.finished(1, 'claude');
  a.cancel(1, 'claude');
  await finished;
  await flush();
  assert.equal(callback.listeners.get(53692)?.listening, false);
  assert.deepEqual(await store.list(), []);
});

test('setup-token sensitive persistence fixture uses only the shared secret seam, not a runtime sign-in claim', async () => {
  const secret = keys();
  const store = memoryStore();
  class SecretStep extends Accounts {
    save() { return this.saveAccountKey(1, 'claude.setup-token', fixture.setupToken, { route: 'anthropic:setup_token', billing: 'subscription' }); }
  }
  const a = new SecretStep({ offer: ['claude'], store: () => store, keyStore: () => secret.store });
  await a.save();
  assert.equal(secret.values.get('accounts.claude.setup-token'), fixture.setupToken);
  assert.deepEqual(await store.read('claude.setup-token'), { type: 'api_key' });
  assert.doesNotMatch(JSON.stringify([await a.list(1), await a.status(1, 'claude.setup-token'), await store.index()]), canaries);
  // The fixture qualifies a sensitive storage step only; the route's driver remains separately owned.
  assert.equal(await a.signedIn(1, 'claude.setup-token'), false);
});

for (const via of ['browser', 'paste'] as const) {
  test(`OpenRouter ${via}: pinned PKCE exchange saves only in keyStore, API-billed row stays explicit`, async (t) => {
    const callback = callbacks(t);
    const secret = keys();
    offline(t, (url, init) => {
      assert.equal(url, fixture.openrouter.token);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.code, 'good');
      assert.ok(body.code_verifier);
      assert.equal(body.code_challenge_method, 'S256');
      return Response.json({ key: fixture.apiKey });
    });
    const store = memoryStore();
    const a = new Accounts({ offer: ['openrouter'], store: () => store, keyStore: () => secret.store });
    t.after(() => a.stop());
    const { id, signIn } = await a.add(1, 'openrouter', { via, billedPerUse: true });
    assert.equal(signIn?.via, 'browser', 'paste still opens a provider page; public view stays compatible');
    const callbackUrl = new URL(new URL(signIn!.url!).searchParams.get('callback_url')!);
    if (via === 'paste') a.paste(1, id, `${callbackUrl}?code=good`);
    else assert.equal((await callback.back(0, `${callbackUrl.pathname}?code=good`)).status, 200);
    await a.finished(1, id);
    assert.equal(a.view(1, id)?.state, 'done');
    assert.equal(await a.key(1, id), fixture.apiKey);
    assert.equal(secret.values.get(`accounts.${id}`), fixture.apiKey);
    const rows = await a.list(1);
    assert.equal(rows[0].billing, 'api');
    assert.equal(chooseAccount(rows, () => ({ left: 'unknown' }), Date.now()), undefined);
    assert.doesNotMatch(JSON.stringify([rows, await store.index(), await store.read(id), a.view(1, id)]), canaries);
    await a.remove(1, id);
    assert.deepEqual([...secret.values], []);
    assert.deepEqual(await a.list(1), []);
  });
}

for (const reconnect of [false, true]) {
  test(`OpenRouter cancellation during secure persistence ${reconnect ? 'preserves the prior key' : 'leaves no key or account'}`, async (t) => {
    callbacks(t);
    offline(t, (url) => { assert.equal(url, fixture.openrouter.token); return Response.json({ key: fixture.apiKey }); });
    const secret = keys();
    const previous = 'prior-api-key-secret-canary';
    if (reconnect) secret.values.set('accounts.openrouter', previous);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const saving = new Promise<void>((resolve) => { entered = resolve; });
    const original = secret.store.set;
    secret.store.set = async (name, value) => { await original(name, value); if (value === fixture.apiKey) { entered(); await gate; } };
    const store = memoryStore();
    const a = new Accounts({ offer: ['openrouter'], store: () => store, keyStore: () => secret.store });
    t.after(() => { release(); a.stop(); });
    const id = reconnect ? 'openrouter' : (await a.add(1, 'openrouter', { via: 'paste', billedPerUse: true })).id;
    if (reconnect) await a.login(1, id, { via: 'paste', billedPerUse: true });
    const finished = a.finished(1, id);
    a.paste(1, id, 'good');
    await saving;
    a.cancel(1, id);
    release();
    await finished;
    assert.equal(secret.values.get(`accounts.${id}`), reconnect ? previous : undefined);
    assert.deepEqual(await store.list(), []);
    assert.doesNotMatch(JSON.stringify(await store.index()), canaries);
  });
}

for (const via of ['browser', 'code'] as const) {
  test(`Radius ${via}: published gateway flow, unknown billing, never default or Auto`, async (t) => {
    const callback = callbacks(t);
    offline(t, (url, init) => {
      const body = new URLSearchParams(String(init?.body));
      if (url === `${fixture.radius.gateway}/v1/oauth`) return Response.json({ authorizationEndpoint: 'https://fixture.example/authorize' });
      if (url === `${fixture.radius.gateway}/v1/oauth/device`) return Response.json(fixture.device);
      if (url === `${fixture.radius.gateway}/v1/oauth/token`) {
        assert.equal(body.get('client_id'), 'pi-gateway');
        assert.equal(body.get('grant_type'), via === 'code' ? 'urn:ietf:params:oauth:grant-type:device_code' : 'authorization_code');
        return Response.json(fixture.token);
      }
      throw new Error(`Unexpected fixture request: ${url}`);
    });
    const store = memoryStore();
    const a = new Accounts({ offer: ['radius'], store: () => store });
    t.after(() => a.stop());
    const shown = await a.login(1, 'radius', { via });
    if (via === 'browser') {
      const state = new URL(shown!.url!).searchParams.get('state')!;
      assert.equal((await callback.back(1456, '/oauth/callback?code=good&state=forged')).status, 400);
      assert.equal((await callback.back(1456, `/oauth/callback?code=good&state=${state}`)).status, 200);
    }
    await a.finished(1, 'radius');
    assert.equal(a.view(1, 'radius')?.state, 'done');
    const rows = await a.list(1);
    assert.equal(rows[0].billing, 'unknown');
    assert.equal(chooseAccount(rows, () => ({ left: 'unknown' }), Date.now()), undefined);
    assert.doesNotMatch(JSON.stringify([rows, await store.index(), await a.status(1, 'radius')]), canaries);
    assert.equal(billingWords(provider('radius')), 'Billing set by Radius');
    assert.ok(!new Accounts().providers.some((p) => p.key === 'radius'));
  });
}

test('Copilot Enterprise domain reaches every pinned auth endpoint and persisted credential', { timeout: 10_000 }, async (t) => {
  const domain = 'company.ghe.com';
  const requests: string[] = [];
  offline(t, (url) => {
    requests.push(url);
    if (url === `https://${domain}/login/device/code`) return Response.json(fixture.device);
    if (url === `https://${domain}/login/oauth/access_token`) return Response.json({ access_token: fixture.token.refresh_token });
    if (url === `https://api.${domain}/copilot_internal/v2/token`) return Response.json({ token: fixture.token.access_token, expires_at: Date.now() / 1000 + 3600 });
    if (url === `https://copilot-api.${domain}/models`) return Response.json({ data: [{ id: 'gpt-5.4', model_picker_enabled: true, policy: { state: 'enabled' } }] });
    throw new Error(`Unexpected fixture request: ${url}`);
  });
  const store = memoryStore();
  const a = new Accounts({ offer: ['copilot'], store: () => store });
  t.after(() => a.stop());
  await a.login(1, 'copilot', { enterpriseDomain: domain });
  await a.finished(1, 'copilot');
  assert.equal(a.view(1, 'copilot')?.state, 'done');
  const c = await store.read('github-copilot');
  assert.equal(c?.type === 'oauth' && c.enterpriseUrl, domain);
  assert.equal(requests.length, 4);
  assert.doesNotMatch(JSON.stringify([await a.list(1), await store.index(), await a.status(1, 'copilot')]), canaries);
});

test('readiness and explicit billing reject before any credentials, no portable runtime expansion', async () => {
  let reads = 0;
  const store = () => { reads++; throw new Error('credential access too early'); };
  const a = new Accounts({ offer: ['openrouter', 'copilot', 'qwen'], store });
  await assert.rejects(a.login(1, 'openrouter'), /billing per use/);
  await assert.rejects(a.login(1, 'openrouter', { billedPerUse: true }), { readiness: 'needs_host' });
  await assert.rejects(a.login(1, 'copilot', { enterpriseDomain: 'https://user:secret@company.ghe.com/path' }), /without a path or credentials/);
  await assert.rejects(a.login(1, 'qwen'), { readiness: 'no_upstream_flow' });
  const portable = new Portable({ offer: ['claude', 'radius', 'openrouter'], store, keyStore: () => keys().store });
  for (const [key, via] of [['claude', 'browser'], ['radius', 'code'], ['radius', 'browser'], ['openrouter', 'paste']] as const) {
    await assert.rejects(portable.add(1, key, { via, billedPerUse: true }), { readiness: 'unsupported_platform' });
  }
  assert.equal(computer.signsIn('radius'), true);
  assert.equal(reads, 0);
});
