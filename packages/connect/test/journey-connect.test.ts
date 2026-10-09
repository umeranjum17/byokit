// Consumer journeys for the published @byokit/connect surface, driven the way a host app uses it:
// `connect(target, options)` returns a handle, `signIn()` returns the URL the host opens and a `finish(callback)`
// the host routes the provider's answer to, `token()` is the credential trusted app code uses, and
// `mcp()`/`MailReader`/`MailSender`/`MailHistory` sit on top. Every import is a published entry — `@byokit/connect`,
// `@byokit/connect/node` and `@byokit/secrets/node` — with no src or internals. The security and correctness
// contracts the old unit/mock-heavy cases held survive as assertions inside a journey: PKCE/state and exact-callback
// binding, one-shot exchange and per-person isolation, the accepted/declined/expired/cancelled/superseded flows,
// transient refresh preservation and invalid_grant removal, single-flight rotation across handles, provider-snapshot
// immutability, credential redaction in every error, verified client details, discovery/DCR/resource binding, the
// typed MCP client, the loopback listener and the house Google client, Gmail read/search and owner-bound history that
// never exports bodies, one approval per send that never leaves without its `true`, and a portable entry that bundles
// for browsers and React Native with no Node code and only plain words a person reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };
import {
  connect, ConnectError, providers, MailReader, MailSender, MailError, MailHistory, HistoryError,
  CallToolResultSchema, ToolListChangedNotificationSchema,
  type Provider, type ConnectOptions,
} from '@byokit/connect';
import { connectLoopback, googleClientFile } from '@byokit/connect/node';
import { osKeyringSeal, type Keystore } from '@byokit/secrets/node';
import { scratchDir } from '../../test-support.ts';

const pattern = new RegExp(plain.pattern, 'i');
/** Every message a person can read is a plain sentence: no codes, paths, ids or jargon. */
const assertPlain = (text: string) => assert.ok(!pattern.test(text), `not a plain sentence: ${text}`);
function memory(): Keystore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); }, delete: async key => values.delete(key) };
}
function response(value: unknown, status = 200, headers?: HeadersInit) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); }
const app: Provider = { id: 'fake', name: 'App', oauth: { authorize: 'https://app.test/authorize', token: 'https://app.test/token' }, scopes: ['read'] };
/** A canned provider token endpoint: records every form, flips its answer and can go offline. */
function fake() {
  let count = 0, refreshes = 0;
  const forms: URLSearchParams[] = [];
  let tokenBody: unknown = { access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', expires_in: 3600, scope: 'read' };
  let status = 200;
  let fail = false;
  const fetcher: typeof fetch = async (_url, init) => {
    ++count;
    if (fail) throw new Error('network access-canary refresh-canary');
    const form = new URLSearchParams(init?.body as URLSearchParams); forms.push(form);
    if (form.get('grant_type') === 'refresh_token') ++refreshes;
    return response(tokenBody, status);
  };
  return { fetch: fetcher, forms, count: () => count, refreshes: () => refreshes, set: (body: unknown, code = 200) => { tokenBody = body; status = code; }, offline: () => { fail = true; } };
}
function options(http = fake(), store = memory()): ConnectOptions { return { store, person: 'Umer', client: { id: 'client' }, redirectUri: 'https://device.test/callback', fetch: http.fetch }; }
function callback(url: string, uri = 'https://device.test/callback', code = 'code-canary') { const u = new URL(uri); u.searchParams.set('state', new URL(url).searchParams.get('state')!); u.searchParams.set('code', code); return u; }
async function signed(opts: ConnectOptions, target: Provider | string = app) { const c = connect(target, opts); const flow = await c.signIn(); await flow.finish(callback(flow.url, opts.redirectUri)); return c; }
function error(code: string) { return (e: unknown) => e instanceof ConnectError && e.code === code && !/canary/.test(e.message); }
async function refusal(code: string, run: () => Promise<unknown>): Promise<ConnectError> {
  try { await run(); } catch (e) { assert.ok(e instanceof ConnectError && e.code === code, `expected ${code}, got ${String(e)}`); assertPlain(e.message); return e; }
  throw new Error(`expected ${code}, nothing was thrown`);
}

test('a host signs a person in with PKCE, keeps people apart, and rotates or revokes exactly one grant', async () => {
  const http = fake(), store = memory(), opts = options(http, store);
  const connection = connect({ ...app, extra: { state: 'bad', code_challenge_method: 'plain', prompt: 'consent' } }, opts);
  const flow = await connection.signIn(); const auth = new URL(flow.url);
  // Security parameters cannot be overridden, but provider extras survive.
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.searchParams.get('prompt'), 'consent');
  assert.notEqual(auth.searchParams.get('state'), 'bad');
  // The callback is bound to its exact redirect and a single, matching state; nothing reaches the provider early.
  for (const uri of ['https://other.test/callback', 'https://device.test/wrong']) await assert.rejects(flow.finish(callback(flow.url, uri)), error('callback'));
  const bad = callback(flow.url); bad.searchParams.set('state', 'bad'); await assert.rejects(flow.finish(bad), error('callback'));
  const duplicate = callback(flow.url); duplicate.searchParams.append('state', auth.searchParams.get('state')!); await assert.rejects(flow.finish(duplicate), error('callback'));
  assert.equal(http.count(), 0);
  await flow.finish(callback(flow.url));
  const form = http.forms[0]; assert.equal(form.get('redirect_uri'), opts.redirectUri); assert.equal(form.get('code'), 'code-canary');
  assert.match(form.get('code_verifier')!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'));
  await assert.rejects(flow.finish(callback(flow.url)), error('callback'));   // one-shot
  assert.equal(await connection.token(), 'access-canary');
  // People sharing one store never see each other's grant.
  assert.equal(await connect(app, { ...opts, person: 'person-2' }).connected(), false);
  await signed({ ...opts, person: 'person-2' });
  await connection.disconnect(); assert.equal(await connection.connected(), false);
  assert.equal(await connect(app, { ...opts, person: 'person-2' }).token(), 'access-canary');
  assert.equal(store.values.size, 1);

  // A handle snapshots its provider: retargeting the object or the handle cannot redirect the credential.
  const target: Provider = { ...app, oauth: { ...app.oauth! }, mcpUrl: 'https://resource.test/mcp', scopes: ['read'] };
  const snap = connect(target, options());
  target.oauth!.token = 'https://other.test/token'; target.mcpUrl = 'https://other.test/mcp';
  assert.equal(snap.provider.oauth!.token, app.oauth!.token);
  assert.equal(snap.provider.mcpUrl, 'https://resource.test/mcp');
  assert.throws(() => { Object.assign(snap.provider, { mcpUrl: 'https://other.test/mcp' }); }, TypeError);
  assert.throws(() => { Object.assign(snap.provider.oauth!, { token: 'https://other.test/token' }); }, TypeError);

  // Unspecified scopes leave the provider's own defaults intact: no empty `scope` is sent.
  const defaults = connect({ id: 'defaults', name: 'App', oauth: { ...app.oauth!, authorize: app.oauth!.authorize + '?scope=stale' }, extra: { scope: 'ignored' } }, options());
  const defaultsFlow = await defaults.signIn();
  assert.equal(new URL(defaultsFlow.url).searchParams.has('scope'), false);
  await defaultsFlow.finish(callback(defaultsFlow.url)); assert.equal(await defaults.connected(), true);

  // Long provider/person identities fit the real keystore contract and restore across handles.
  const longStore = memory();
  const longTarget = { ...app, id: 'long-provider-' + 'x'.repeat(300), mcpUrl: 'https://resource.test/' + 'path'.repeat(150) };
  const longOpts = { ...options(fake(), longStore), person: 'person-' + 'y'.repeat(300) };
  const long = await signed(longOpts, longTarget);
  assert.equal(await connect(longTarget, longOpts).token(), 'access-canary');
  await long.disconnect(); assert.equal(await long.connected(), false);
});

test('refresh rotates one grant single-flight across handles; transient failures keep it and only invalid_grant ends it', async () => {
  const http = fake(), opts = options(http); let now = 0; opts.now = () => now;
  const c = await signed(opts); now = 3_600_000;
  http.set({ access_token: 'new-canary', refresh_token: 'rotated-canary', token_type: 'Bearer', expires_in: 30 });
  // Twelve handles due at once share one refresh; the rotated refresh token is what the next round sends.
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => connect(app, opts).token())), Array(12).fill('new-canary'));
  assert.equal(http.refreshes(), 1); assert.equal(http.forms[1].get('refresh_token'), 'refresh-canary');
  http.set({ access_token: 'newest-canary', token_type: 'Bearer', expires_in: 3600 });
  assert.equal(await connect(app, opts).token(), 'newest-canary'); assert.equal(http.forms[2].get('refresh_token'), 'rotated-canary');
  assert.equal(await c.token('old-access'), 'newest-canary'); assert.equal(http.refreshes(), 2);
  await c.token('newest-canary'); assert.equal(http.refreshes(), 3);
  // A new backend over the same values restores the saved grant.
  const sameStore = opts.store; assert.equal(await connect(app, { ...opts, store: { get: k => sameStore.get(k), set: (k, v) => sameStore.set(k, v), delete: k => sameStore.delete(k) } }).token(), 'newest-canary');
  // Disconnect during a refresh neither resurrects a token nor leaves a pending grant.
  now += 3_600_000;
  let started!: () => void, release!: () => void;
  const begun = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  const delayed: typeof fetch = async () => { started(); await gate; return response({ access_token: 'late-canary', token_type: 'Bearer', expires_in: 3600 }); };
  const pending = connect(app, { ...opts, fetch: delayed }).token(); await begun;
  const disconnect = c.disconnect(); release(); await assert.rejects(pending, error('signin')); await disconnect;
  assert.equal(await c.connected(), false);

  // Transient failures preserve the sign-in; invalid_grant removes it; tokens never enter an error.
  const t = fake(), topts = options(t); let clock = 0; topts.now = () => clock;
  const transient = await signed(topts); clock = 3_600_000;
  t.set({ error: 'server_error', error_description: 'access-canary refresh-canary' }, 503);
  await assert.rejects(transient.token(), error('token')); assert.equal(await transient.connected(), true);
  t.set({ error: 'invalid_grant', error_description: 'refresh-canary' }, 400);
  await assert.rejects(transient.token(), error('signin')); assert.equal(await transient.connected(), false);
  // An unexpired token survives a network outage; an expired one is never returned.
  const other = fake(); clock = 0; const offline = await signed({ ...topts, fetch: other.fetch }); clock = 3_550_000; other.offline();
  assert.equal(await offline.token(), 'access-canary'); clock = 3_600_001;
  await assert.rejects(offline.token(), error('network')); assert.equal(await offline.connected(), true);

  // Refresh lifetime survives restart and rotation, and provider causes never repeat a credential.
  const http2 = fake(), store = memory(); let nowMs = 1000;
  const o = { ...options(http2, store), client: { id: 'client', secret: 'secret-canary' }, now: () => nowMs };
  http2.set({ access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', expires_in: 3600, refresh_token_expires_in: 7200 });
  const grants = await signed(o);
  assert.equal((await grants.grant())?.refreshTokenExpiresIn, 7200);
  assert.equal((await connect(app, o).grant())?.refreshTokenExpiresAt, 7_201_000);
  http2.set({ access_token: 'rotated-access-canary', refresh_token: 'rotated-refresh-canary', token_type: 'Bearer', expires_in: 3600, refresh_token_expires_in: 9000 });
  await grants.token('access-canary');
  assert.equal((await grants.grant())?.refreshTokenExpiresIn, 9000);
  http2.set({ error: 'server_error', error_description: 'Setup delayed: secret-canary rotated-refresh-canary rotated-access-canary https://example.test/?key=private', access_token: 'returned-canary' }, 503);
  await assert.rejects(grants.token('rotated-access-canary'), (e: unknown) => {
    assert.ok(e instanceof ConnectError); assert.equal(e.cause?.error, 'server_error');
    assert.match(e.cause?.error_description ?? '', /Setup delayed/);
    const seen = String(e) + JSON.stringify(e.cause);
    assert.doesNotMatch(seen, /secret-canary|refresh-canary|rotated-access-canary|returned-canary|private/);
    return true;
  });

  // A host can wrap its store with the documented seal: ciphertext only, rebound names, cleared on disconnect.
  const keys = new Map<string, string>(), persisted = memory(), http3 = fake();
  const sealing = { service: 'connect-sealed-test', stateDir: scratchDir('connect-sealed'), fallback: false,
    keyring: { get: (name: string) => keys.get(name) ?? null, set: (name: string, value: string) => { keys.set(name, value); }, delete: (name: string) => keys.delete(name) } };
  const wrap = (): Keystore => {
    const seal = osKeyringSeal(sealing);
    return {
      async get(name) {
        const value = await persisted.get(name);
        if (value === null) return null;
        const record = JSON.parse(seal.decryptString(Buffer.from(value, 'base64')));
        if (record.name !== name || typeof record.secret !== 'string') throw new Error('Stored sign-in could not be opened.');
        return record.secret;
      },
      async set(name, secret) { await persisted.set(name, Buffer.from(seal.encryptString(JSON.stringify({ name, secret }))).toString('base64')); },
      delete: name => persisted.delete(name),
    };
  };
  const sealedOpts = { ...options(http3), store: wrap() }, sealed = await signed(sealedOpts);
  const initial = [...persisted.values.values()][0];
  assert.equal(Buffer.from(initial, 'base64').subarray(0, 4).toString(), 'BKS1');
  http3.set({ access_token: 'rotated-access-canary', refresh_token: 'rotated-refresh-canary', expires_in: 3600, token_type: 'Bearer' });
  assert.equal(await sealed.token('access-canary'), 'rotated-access-canary');
  assert.notEqual([...persisted.values.values()][0], initial);
  for (const value of persisted.values.values()) assert.doesNotMatch(Buffer.from(value, 'base64').toString(), /access-canary|refresh-canary/);
  assert.equal(await connect(app, { ...sealedOpts, store: wrap() }).token(), 'rotated-access-canary');
  await sealed.disconnect(); assert.equal(persisted.values.size, 0);
});

test('declined, untimed, expired, cancelled, superseded and misconfigured sign-ins save nothing and are refused plainly', async () => {
  const http = fake(), opts = options(http), c = connect(app, { ...opts, client: { id: 'client', secret: 'secret-canary' } });
  // The person declines; the provider's own description is kept sanitized.
  const declined = await refusal('declined', async () => { const flow = await c.signIn(); const back = callback(flow.url); back.searchParams.set('error', 'access_denied'); back.searchParams.set('error_description', 'No permission for secret-canary code-canary'); return flow.finish(back); });
  assert.equal(declined.cause?.error, 'access_denied'); assert.doesNotMatch(JSON.stringify(declined.cause), /canary/);
  // Incomplete scopes, cancel and a newer sign-in each refuse the old flow.
  await refusal('scope', async () => { const flow = await c.signIn(); http.set({ access_token: 'access-canary', token_type: 'Bearer', scope: 'other' }); return flow.finish(callback(flow.url)); });
  await refusal('callback', async () => { const flow = await c.signIn(); flow.cancel(); return flow.finish(callback(flow.url)); });
  await refusal('callback', async () => { const flow = await c.signIn(); await connect(app, opts).signIn(); return flow.finish(callback(flow.url)); });
  let now = 0; const timed = connect(app, { ...opts, now: () => now, flowTimeoutMs: 100 });
  await refusal('expired', async () => { const flow = await timed.signIn(); now = 101; return flow.finish(callback(flow.url)); });
  assert.equal(await c.connected(), false);
  // Cancel and expiry during an in-flight exchange never persist the returned grant.
  for (const mode of ['cancel', 'expire'] as const) {
    let clock = 0, started!: () => void, release!: () => void;
    const begun = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { release = r; });
    const fetcher: typeof fetch = async () => { started(); await gate; return response({ access_token: 'late-canary', token_type: 'Bearer', expires_in: 3600, scope: 'read' }); };
    const racing = connect(app, { ...options(), fetch: fetcher, now: () => clock, flowTimeoutMs: 100 });
    const flow = await racing.signIn(), finishing = flow.finish(callback(flow.url));
    await begun; if (mode === 'cancel') flow.cancel(); else clock = 101; release();
    await assert.rejects(finishing, error(mode === 'cancel' ? 'declined' : 'expired'));
    assert.equal(await racing.connected(), false);
  }

  // Bad redirects, insecure endpoints, mismatched metadata and failed registration cannot start sign-in.
  for (const uri of ['http://remote.test/callback', 'javascript:alert(1)', 'https://user:pass@device.test/callback']) {
    assert.throws(() => connect(app, { ...opts, redirectUri: uri }), error('configuration'));
  }
  await refusal('configuration', () => connect({ ...app, oauth: { ...app.oauth!, token: 'http://remote.test/token' } }, opts).signIn());
  const badMeta: typeof fetch = async input => String(input).endsWith('/mcp') ? new Response(null, { status: 401 }) : response({ resource: 'https://other.test/mcp', authorization_servers: ['https://auth.test'] });
  await refusal('discovery', () => connect('https://resource.test/mcp', { ...opts, fetch: badMeta }).signIn());
  const noClient: typeof fetch = async input => String(input).includes('well-known') ? response({ issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/auth', token_endpoint: 'https://auth.test/token', registration_endpoint: 'https://auth.test/register' }) : response({ client_id: null });
  await refusal('registration', () => connect({ id: 'dcr', name: 'App', issuer: 'https://auth.test' }, { ...opts, client: undefined, fetch: noClient }).signIn());
  // A callback exchange that fails keeps the provider's cause, sanitized.
  await refusal('token', async () => { const flow = await c.signIn(); http.set({ error: 'invalid_grant', error_description: 'Expired code-canary secret-canary' }, 400); return flow.finish(callback(flow.url)); });

  // verifyClient reports invalid/valid/inconclusive without ever touching the person's grant.
  const store = memory(), probeHttp = fake();
  const probe = connect({ ...providers.google, oauth: app.oauth }, { ...options(probeHttp, store), client: { id: 'client', secret: 'secret-canary' } });
  probeHttp.set({ error: 'invalid_client', error_description: 'Wrong secret-canary' }, 401);
  const invalid = await probe.verifyClient(); assert.equal(invalid.outcome, 'invalid'); assertPlain(invalid.message); assert.doesNotMatch(JSON.stringify(invalid), /secret-canary/);
  probeHttp.set({ error: 'invalid_grant' }, 400);
  const valid = await probe.verifyClient(); assert.equal(valid.outcome, 'valid'); assertPlain(valid.message);
  for (const code of ['unauthorized_client', 'invalid_request', 'server_error', 'invalid_grant']) { probeHttp.set({ error: code }, 503); const inconclusive = await probe.verifyClient(); assert.equal(inconclusive.outcome, 'inconclusive'); assertPlain(inconclusive.message); }
  probeHttp.set({ access_token: 'probe-access-canary', token_type: 'Bearer' }); assert.equal((await probe.verifyClient()).outcome, 'inconclusive');
  probeHttp.offline(); assert.equal((await probe.verifyClient()).outcome, 'inconclusive');
  assert.equal(store.values.size, 0);
  for (const form of probeHttp.forms) { assert.equal(form.get('grant_type'), 'refresh_token'); assert.equal(form.get('refresh_token'), 'byokit-client-check-not-a-grant'); }
  // Supplied basic credentials are used, a secret is required, and an existing grant is untouched.
  const signedHttp = fake(), signedStore = memory(), signedOpts = options(signedHttp, signedStore), live = await signed(signedOpts);
  const original = [...signedStore.values.values()];
  const basic: typeof fetch = async (_url, init) => {
    const form = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(form.has('client_secret'), false); assert.equal(form.has('client_id'), false);
    assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Basic '));
    return response({ error: 'invalid_client', error_description: 'Wrong key canary%2Bsecret canary+secret' }, 400);
  };
  const entered = await connect(app, { ...signedOpts, fetch: basic }).verifyClient({ id: 'entered', secret: 'canary+secret', authMethod: 'client_secret_basic' });
  assert.equal(entered.outcome, 'invalid'); assert.doesNotMatch(JSON.stringify(entered), /canary/);
  assert.deepEqual([...signedStore.values.values()], original);
  assert.equal(await live.token(), 'access-canary');
  await refusal('configuration', () => live.verifyClient({ id: 'entered' }));
  const malformed = connect(app, { ...signedOpts, fetch: async () => new Response('not JSON', { status: 502 }) });
  assert.equal((await malformed.verifyClient({ id: 'entered', secret: 'canary' })).outcome, 'inconclusive');
});

test('a remote MCP server is discovered, registered and driven through the typed client, with a 401 refreshed', async () => {
  // Discovery follows the 401 challenge, the issuer path and DCR, binding the resource on every call.
  const calls: { url: string; init?: RequestInit }[] = []; let now = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init });
    if (url === 'https://resource.test/mcp') return new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://resource.test/metadata"' } });
    if (url.endsWith('/metadata')) return response({ resource: 'https://resource.test', authorization_servers: ['https://auth.test/tenant'], scopes_supported: ['read'] });
    if (url === 'https://auth.test/.well-known/oauth-authorization-server/tenant') return response({ issuer: 'https://auth.test/tenant', authorization_endpoint: 'https://auth.test/authorize', token_endpoint: 'https://auth.test/token', registration_endpoint: 'https://auth.test/register', code_challenge_methods_supported: ['S256'] });
    if (url.endsWith('/register')) { assert.deepEqual(JSON.parse(String(init?.body)).redirect_uris, ['myapp://callback']); return response({ client_id: 'dynamic', token_endpoint_auth_method: 'none' }, 201); }
    if (url.endsWith('/token')) return response({ access_token: 'mcp-access', refresh_token: 'mcp-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'read' });
    throw new Error('unexpected request');
  };
  const store = memory(), opts: ConnectOptions = { store, person: 'Umer', redirectUri: 'myapp://callback', fetch: fetcher, now: () => now };
  const discovered = connect('https://resource.test/mcp', opts), flow = await discovered.signIn();
  assert.equal(new URL(flow.url).searchParams.get('resource'), 'https://resource.test');
  await flow.finish(callback(flow.url, opts.redirectUri));
  const form = new URLSearchParams(calls.at(-1)!.init!.body as URLSearchParams);
  assert.equal(form.get('resource'), 'https://resource.test'); assert.equal(form.get('client_id'), 'dynamic');
  now = 3_600_000; const before = calls.length; await connect('https://resource.test/mcp', opts).token();
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)!.url, 'https://auth.test/token');
  assert.equal(new URLSearchParams(calls.at(-1)!.init!.body as URLSearchParams).get('resource'), 'https://resource.test');

  // The typed client negotiates, sends session/protocol/auth, keeps rich results and refreshes a 401 once.
  const http = fake(), signedOpts = options(http); const server = 'https://resource.test/mcp';
  const target = { ...app, mcpUrl: server };
  const signedConnection = await signed(signedOpts, target);
  const messages: Record<string, unknown>[] = []; let unauthorized = true;
  const transport: typeof fetch = async (input, init) => {
    if (String(input) === app.oauth!.token) { http.set({ access_token: 'refreshed-access', token_type: 'Bearer', expires_in: 3600 }); return http.fetch(input, init); }
    const headers = new Headers(init?.headers); assert.match(headers.get('authorization')!, /^Bearer (access-canary|refreshed-access)$/);
    assert.equal(init?.redirect, 'error');
    if (init?.method === 'GET') return new Response(null, { status: 405 });
    const m = JSON.parse(String(init?.body)); messages.push(m);
    if (m.method === 'initialize') return response({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'fake', version: '1' } } }, 200, { 'mcp-session-id': 'session' });
    assert.equal(headers.get('mcp-session-id'), 'session'); assert.ok(headers.get('mcp-protocol-version'));
    if (!m.id) return new Response(null, { status: 202 });
    if (m.method === 'tools/list' && unauthorized) { unauthorized = false; return new Response(null, { status: 401 }); }
    let result: unknown;
    if (m.method === 'tools/list') result = { tools: [{ name: 'read', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }], nextCursor: 'next-page' };
    else if (m.method === 'tools/call') result = { content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { answer: 42 }, isError: false };
    else if (m.method === 'resources/read') result = { contents: [{ uri: 'fake://data', mimeType: 'text/plain', text: 'resource' }] };
    else if (m.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: 'prompt' } }] };
    else throw new Error(`unexpected ${m.method}`);
    return new Response(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\r\n\r\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
  const client = await connect(target, { ...signedOpts, fetch: transport }).mcp({ configure: client => { client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {}); } });
  try {
    const list = await client.listTools(); assert.equal(list.nextCursor, 'next-page'); assert.equal(list.tools[0].annotations?.readOnlyHint, true);
    const toolResult = await client.callTool({ name: 'read', arguments: {} }, CallToolResultSchema);
    assert.deepEqual(toolResult.structuredContent, { answer: 42 }); assert.ok(Array.isArray(toolResult.content)); assert.equal(toolResult.content[1].type, 'image');
    const resource = (await client.readResource({ uri: 'fake://data' })).contents[0]; assert.ok('text' in resource); assert.equal(resource.text, 'resource');
    assert.equal((await client.getPrompt({ name: 'greet' })).messages[0].content.type, 'text');
    assert.ok(messages.some(m => m.method === 'notifications/initialized')); assert.equal(http.refreshes(), 1);
  } finally { await client.close(); }
  await signedConnection.disconnect();
});

test('a computer signs in over loopback with the house Google client, then reads, exports and sends with one approval', async () => {
  // Loopback binds a real local callback: unrelated requests, wrong state and reused calls are refused, then closed.
  const http = fake(), loopOpts = options(http); const { redirectUri: _uri, ...rest } = loopOpts;
  let callbackUrl = '';
  const flow = await connectLoopback(app, { ...rest, open: async url => {
    callbackUrl = new URL(url).searchParams.get('redirect_uri')!;
    const miss = await fetch(new URL('/wrong', callbackUrl)); assert.equal(miss.status, 404); assertPlain(await miss.text());
    const wrong = callback(url, callbackUrl); wrong.searchParams.set('state', 'bad');
    const bad = await fetch(wrong); assert.equal(bad.status, 400); assertPlain(await bad.text());
    const ok = await fetch(callback(url, callbackUrl)); assert.equal(ok.status, 200); assertPlain(await ok.text());
  } });
  await flow.done; assert.equal(await flow.connection.token(), 'access-canary');
  assert.equal(await connect(app, { ...loopOpts, redirectUri: 'http://127.0.0.1:1/callback' }).token(), 'access-canary');
  await assert.rejects(fetch(callbackUrl));
  const cancelled = await connectLoopback(app, { ...rest, open: () => {} }); cancelled.cancel(); await assert.rejects(cancelled.done, error('declined'));
  const expired = await connectLoopback(app, { ...rest, flowTimeoutMs: 20, open: () => {} }); await assert.rejects(expired.done, error('expired'));
  await refusal('configuration', () => connectLoopback('bad-url', { ...rest, open: () => {} }));

  // The house Google client: absent is null, an exposed or non-Desktop file is refused without echoing it.
  const dir = scratchDir('connect-house'), path = join(dir, 'google-oauth-client.json');
  const store = memory(), seen: string[] = [], forms: URLSearchParams[] = [];
  const SCOPES = [...providers.gmail.scopes, 'https://www.googleapis.com/auth/gmail.send'];
  const google: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); seen.push(url.host + url.pathname);
    if (url.href === providers.gmail.oauth.token) { forms.push(new URLSearchParams(init?.body as URLSearchParams)); return response({ access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', expires_in: 3600, scope: SCOPES.join(' ') }); }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer access-canary');
    return response({ id: 'sent-1', threadId: 't-1', labelIds: ['SENT'] });
  };
  const houseOpts = { store, person: 'Umer', scopes: SCOPES, fetch: google };
  assert.equal(await googleClientFile(path), null);
  await refusal('configuration', () => connect('gmail', { ...houseOpts, redirectUri: 'http://127.0.0.1:1/callback' }).signIn());
  assert.deepEqual(seen, []);
  writeFileSync(path, JSON.stringify({ installed: { client_id: '123-house.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-canary' } }), { mode: 0o644 }); chmodSync(path, 0o644);
  if (process.platform !== 'win32') await assert.rejects(googleClientFile(path), (e: Error) => { assertPlain(e.message); return true; });
  writeFileSync(path, JSON.stringify({ web: { client_id: '123-house.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-canary' } })); chmodSync(path, 0o600);
  await assert.rejects(googleClientFile(path), (e: Error) => { assertPlain(e.message); return true; });
  writeFileSync(path, JSON.stringify({ installed: { client_id: '123-house.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-canary', redirect_uris: ['http://localhost'] } }));
  const client = await googleClientFile(path);
  assert.deepEqual(client, { id: '123-house.apps.googleusercontent.com', secret: 'GOCSPX-secret-canary' });

  // Denying consent saves nothing; approving carries the house client and both scopes, then sends once.
  const refused = await connectLoopback('gmail', { ...houseOpts, client: client!, open: async url => {
    const back = new URL(new URL(url).searchParams.get('redirect_uri')!); back.searchParams.set('state', new URL(url).searchParams.get('state')!); back.searchParams.set('error', 'access_denied');
    const deny = await fetch(back); assert.equal(deny.status, 400); assertPlain(await deny.text());
  } });
  await assert.rejects(refused.done, error('declined'));
  assert.equal(await refused.connection.connected(), false);
  const approved = await connectLoopback('gmail', { ...houseOpts, client: client!, open: async url => {
    const asked = new URL(url).searchParams;
    assert.equal(asked.get('client_id'), client!.id); assert.equal(asked.get('scope'), SCOPES.join(' '));
    assert.equal(asked.get('access_type'), 'offline'); assert.equal(asked.get('prompt'), 'consent');
    assert.equal((await fetch(callback(url, asked.get('redirect_uri')!))).status, 200);
  } });
  await approved.done;
  assert.equal(forms[0].get('client_id'), client!.id); assert.equal(forms[0].get('client_secret'), client!.secret);
  const before = seen.length;
  await assert.rejects(new MailSender(approved.connection, () => false, { fetch: google }).send({ to: 'crew@example.test', subject: 'Hi', body: 'From Umer' }),
    (e: unknown) => e instanceof MailError && e.code === 'denied');
  assert.equal(seen.length, before);
  const sent = await new MailSender(approved.connection, () => true, { fetch: google }).send({ to: 'crew@example.test', subject: 'Hi', body: 'From Umer' });
  assert.equal(sent.id, 'sent-1');
  assert.deepEqual(seen.slice(before), ['gmail.googleapis.com/gmail/v1/users/me/messages/send']);
});

test('the owner reads and exports Gmail history, denies a foreign principal, and sends only after its own approval', async () => {
  // A signed Gmail connection is the credential; the canned transport answers pages and messages.
  const oauth: typeof fetch = async () => response({ access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
  const store = memory();
  const gmail: Provider = { id: 'gmail', name: 'Gmail', oauth: { authorize: 'https://app.test/authorize', token: 'https://app.test/token' }, scopes: ['https://www.googleapis.com/auth/gmail.readonly'] };
  const connection = connect(gmail, { store, person: 'Umer', client: { id: 'client' }, redirectUri: 'https://device.test/callback', fetch: oauth });
  const signIn = await connection.signIn(); await signIn.finish(callback(signIn.url));
  const BODY = 'Hello Umer, the invoice is attached. '.repeat(40);
  const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
  const HEADERS = (subject: string) => [{ name: 'Subject', value: subject }, { name: 'From', value: 'crew@example.test' }, { name: 'To', value: 'umer@example.test' }, { name: 'Date', value: 'Tue, 06 Oct 2026 06:00:00 +0000' }];
  const meta = (id: string) => ({ id, threadId: `t-${id}`, snippet: `snippet ${id}`, labelIds: ['INBOX'], payload: { mimeType: 'multipart/mixed', headers: HEADERS(`Subject ${id}`) } });
  const calls: string[] = [], auth: (string | null)[] = [];
  let denials = 1;
  const serve: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname); auth.push(new Headers(init?.headers).get('authorization'));
    if (url.pathname === '/gmail/v1/users/me/messages') {
      if (denials-- > 0) return response({}, 401);
      return response(url.searchParams.get('pageToken') === 'p2'
        ? { messages: [{ id: 'm3', threadId: 't3' }] }
        : { messages: [{ id: 'm1', threadId: 't1' }, { id: 'm2', threadId: 't2' }], nextPageToken: 'p2', resultSizeEstimate: 3 });
    }
    const id = url.pathname.split('/').pop()!;
    if (url.searchParams.get('format') === 'full') {
      const m = meta(id);
      return response({ ...m, payload: { ...m.payload, parts: [{ mimeType: 'text/plain', body: { data: b64url(BODY) } }] } });
    }
    return response(meta(id));
  };
  // search follows the opaque page token and returns envelopes; a 401 retries once with a fresh token.
  const reader = new MailReader(connection, { fetch: serve });
  const page = await reader.search('invoice');
  assert.deepEqual(page.messages.map(m => m.subject), ['Subject m1', 'Subject m2']);
  assert.equal(page.messages[0].from, 'crew@example.test'); assert.equal(page.nextPageToken, 'p2'); assert.equal(page.resultSizeEstimate, 3);
  assert.equal((await reader.list({ pageToken: page.nextPageToken })).messages.length, 1);
  assert.ok(auth.every(h => h === 'Bearer access-canary'));
  // get decodes the bounded body and flags truncation.
  const message = await reader.get('m1'); assert.equal(message.body.text, BODY); assert.equal(message.body.truncated, false);
  const capped = await new MailReader(connection, { fetch: serve, maxBodyChars: 10 }).get('m1');
  assert.equal(capped.body.text, BODY.slice(0, 10)); assert.equal(capped.body.truncated, true);

  // The owner reads across pages and exports json/csv; bodies are never exported.
  const history = new MailHistory(connection, { owner: 'Umer', fetch: serve });
  const rows = await history.messages({ principal: 'Umer', query: 'invoice' });
  assert.deepEqual(rows.map(m => m.subject), ['Subject m1', 'Subject m2', 'Subject m3']);
  const json = JSON.parse(await history.export({ principal: 'Umer', query: 'invoice', format: 'json' }));
  assert.deepEqual(json.map((m: { id: string }) => m.id), ['m1', 'm2', 'm3']);
  assert.ok(json.every((m: Record<string, unknown>) => !('body' in m)));
  const csv = await history.export({ principal: 'Umer', query: 'invoice', format: 'csv' });
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'id,threadId,subject,from,to,date,snippet,labelIds'); assert.equal(lines.length, 4);
  assert.match(lines[1], /^m1,t-m1,Subject m1,crew@example\.test,umer@example\.test,/);
  const cap = await history.messages({ principal: 'Umer', maxMessages: 2, pageSize: 2 });
  assert.deepEqual(cap.map(m => m.id), ['m1', 'm2']);

  // A foreign principal is denied before any provider fetch; bad calls reject early.
  const beforeForeign = calls.length;
  await assert.rejects(history.messages({ principal: 'crew' }), (e: unknown) => e instanceof HistoryError && e.code === 'denied');
  await assert.rejects(history.export({ principal: 'crew', format: 'json' }), (e: unknown) => e instanceof HistoryError && e.code === 'denied');
  assert.equal(calls.length, beforeForeign);
  await assert.rejects(history.messages({ principal: '' }), TypeError);
  await assert.rejects(history.messages({ principal: 'Umer', maxMessages: 0 }), RangeError);
  await assert.rejects(history.messages({ principal: 'Umer', query: '  ' }), TypeError);
  await assert.rejects(history.export({ principal: 'Umer', format: 'mbox' as never }), TypeError);
  assert.throws(() => new MailHistory(connection, { owner: '  ' }), TypeError);
  assert.throws(() => new MailHistory({} as never, { owner: 'Umer' }), TypeError);

  // Provider failures keep their codes and mapping, and bad calls never reach the provider.
  const limitReader = new MailReader(connection, { now: () => 1_000_000, fetch: async () => response({ error: { code: 429 } }, 429, { 'retry-after': '2' }) });
  await assert.rejects(limitReader.list(), (e: unknown) => e instanceof MailError && e.code === 'rate-limited' && e.until === 1_002_000);
  const down = new MailReader(connection, { fetch: async () => response({}, 500) });
  await assert.rejects(down.list(), (e: unknown) => e instanceof MailError && e.code === 'network' && e.status === 500);
  const shape = new MailReader(connection, { fetch: async input => String(input).includes('/m1') ? response({ nope: true }) : response(meta('m1')) });
  await assert.rejects(shape.get('m1'), (e: unknown) => e instanceof MailError && e.code === 'invalid');
  const quiet = new MailReader(connection, { fetch: async () => { throw new Error('must not fetch'); } });
  await assert.rejects(quiet.search('  '), TypeError);
  await assert.rejects(quiet.get(''), TypeError);
  await assert.rejects(quiet.list({ maxResults: 0 }), RangeError);
  assert.throws(() => new MailReader({} as never), TypeError);

  // A send leaves only after its own `true`, encodes exactly what the approval saw, and the entry stays portable.
  // A fake Gmail send endpoint records the encoded MIME; the approval sees the frozen message first.
  const outbox = (answer: () => Response = () => response({ id: 's1', threadId: 'st1', labelIds: ['SENT'] })) => {
    const posts: { url: string; auth: string | null; raw: string }[] = [];
    let tokens = 0;
    const fetch: typeof globalThis.fetch = async (input, init) => { assert.equal(init?.method, 'POST'); posts.push({ url: String(input), auth: new Headers(init?.headers).get('authorization'), raw: JSON.parse(String(init?.body)).raw }); return answer(); };
    return { fetch, posts, tokens: () => tokens, credential: { token: async () => `t${++tokens}` } };
  };
  const DRAFT = { to: ['crew@example.test', 'ops@example.test'], subject: 'Rechnung für Umer ✓', body: 'Hi crew,\nthe invoice is paid.' };
  const o = outbox();
  const seen: unknown[] = [];
  const sender = new MailSender(o.credential, mail => { seen.push(mail); return true; }, { fetch: o.fetch });
  assert.deepEqual(await sender.send(DRAFT), { id: 's1', threadId: 'st1', labelIds: ['SENT'] });
  assert.equal(seen.length, 1); assert.ok(Object.isFrozen(seen[0])); assert.deepEqual(seen[0], DRAFT);
  assert.equal(o.posts[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'); assert.equal(o.posts[0].auth, 'Bearer t1');
  const [head, body] = Buffer.from(o.posts[0].raw, 'base64url').toString('utf8').split('\r\n\r\n');
  assert.match(head, /^To: crew@example\.test, ops@example\.test\r\n/);
  const subject = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map(m => Buffer.from(m[1], 'base64').toString('utf8')).join('');
  assert.equal(subject, DRAFT.subject);
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hi crew,\r\nthe invoice is paid.');
  await sender.send({ ...DRAFT, to: 'crew@example.test', subject: '=?UTF-8?B?UGF5IG5vdw==?=' });
  assert.equal(seen.length, 2, 'every message asks again');
  const literal = Buffer.from(o.posts[1].raw, 'base64url').toString('utf8').match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)!;
  assert.equal(Buffer.from(literal[1], 'base64').toString('utf8'), '=?UTF-8?B?UGF5IG5vdw==?=', 'what was approved is what a reader sees');

  // Denial, a thrown approval, bad drafts and forged addresses leave no token call and no fetch.
  for (const approve of [() => false, () => 'yes' as never, async () => { throw new Error('closed'); }]) {
    const denied = outbox();
    await assert.rejects(new MailSender(denied.credential, approve, { fetch: denied.fetch }).send(DRAFT), (e: unknown) => e instanceof MailError && e.code === 'denied');
    assert.equal(denied.posts.length + denied.tokens(), 0);
  }
  const malformed = outbox(); let asked = 0;
  const strict = new MailSender(malformed.credential, () => { asked++; return true; }, { fetch: malformed.fetch });
  const forged = Object.assign(['ok@example.test'], { [Symbol.iterator]: function* () { yield 'ok@example.test\r\nBcc: spy@example.test'; } });
  for (const bad of [[DRAFT], { ...DRAFT, to: forged }, { ...DRAFT, to: [] }, { ...DRAFT, to: 'Umer <u@example.test>' }, { ...DRAFT, subject: 'x\r\nBcc: a@b.test' }, { ...DRAFT, body: 1 }]) {
    await assert.rejects(strict.send(bad as never), TypeError);
  }
  assert.equal(asked + malformed.posts.length + malformed.tokens(), 0);
  assert.throws(() => new MailSender(malformed.credential, undefined as never), TypeError);
  // Send failures keep their codes; a 401 is retried once with a fresh token.
  let n = 0;
  const once = outbox(() => n++ ? response({ id: 's2', threadId: 'st2' }) : response({}, 401));
  assert.equal((await new MailSender(once.credential, () => true, { fetch: once.fetch }).send(DRAFT)).id, 's2');
  assert.deepEqual(once.posts.map(p => p.auth), ['Bearer t1', 'Bearer t2']);
  for (const [answer, code] of [[() => response({}, 403), 'signed-out'], [() => response({}, 429, { 'retry-after': '1' }), 'rate-limited'], [() => response({}, 500), 'network'], [() => { throw new TypeError('offline'); }, 'network']] as const) {
    const fail = outbox(answer);
    await assert.rejects(new MailSender(fail.credential, () => true, { fetch: fail.fetch }).send(DRAFT), (e: unknown) => e instanceof MailError && e.code === code);
    assert.equal(fail.posts.length, 1);
  }

  // The published entry bundles for the browser and React Native with no Node, filesystem or keystore code.
  const bundle = await build({
    stdin: {
      contents: `import { connect, ConnectError, providers } from '@byokit/connect';
        globalThis.probe = () => ({ scope: providers.gmail.scopes[0], message: new ConnectError('signin').message });`,
      resolveDir: import.meta.dirname, sourcefile: 'phone-connect.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, metafile: true, logLevel: 'silent',
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.deepEqual(inputs.filter(path => /node:/.test(path)), [], 'nothing from Node');
  assert.deepEqual(inputs.filter(path => /packages\/secrets|\/src\/node\.ts/.test(path)), [], 'no keystore or loopback code');
  assert.ok(bundle.outputFiles[0].text.length > 0);
  assert.equal(providers.gmail.scopes[0], 'https://www.googleapis.com/auth/gmail.readonly');
  // Every message a person reads stays a plain sentence (the same rule fixtures/conformance/plain-words.json checks).
  for (const code of ['configuration', 'discovery', 'registration', 'callback', 'expired', 'declined', 'scope', 'token', 'signin', 'network'] as const) assertPlain(new ConnectError(code).message);
});
