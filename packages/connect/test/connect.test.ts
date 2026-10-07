import WORDS from '../src/words.json' with { type: 'json' };
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { connect, ConnectError, providers, type Provider, type ConnectOptions, CallToolResultSchema, ToolListChangedNotificationSchema } from '../src/index.ts';
import { connectLoopback, googleClientFile } from '../src/node.ts';
import { MailSender, MailError } from '../src/index.ts';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { osKeyringSeal, overrideStore } from '../../secrets/src/index.ts';
import type { Keystore } from '@byokit/secrets';

function memory(): Keystore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); }, delete: async key => values.delete(key) };
}
function response(value: unknown, status = 200, headers?: HeadersInit) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } }); }
const app: Provider = { id: 'fake', name: 'App', oauth: { authorize: 'https://app.test/authorize', token: 'https://app.test/token' }, scopes: ['read'] };
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
async function signed(opts: ConnectOptions, target = app) { const c = connect(target, opts); const flow = await c.signIn(); await flow.finish(callback(flow.url, opts.redirectUri)); return c; }
function error(code: string) { return (e: unknown) => e instanceof ConnectError && e.code === code && !/canary/.test(e.message); }

test('PKCE, state, exact callback and one-shot exchange; per-person store isolation', async () => {
  const http = fake(), store = memory(), opts = options(http, store);
  const connection = connect({ ...app, extra: { state: 'bad', code_challenge_method: 'plain', prompt: 'consent' } }, opts);
  const flow = await connection.signIn(); const auth = new URL(flow.url);
  assert.equal(auth.searchParams.get('code_challenge_method'), 'S256'); assert.equal(auth.searchParams.get('prompt'), 'consent');
  assert.notEqual(auth.searchParams.get('state'), 'bad');
  for (const uri of ['https://other.test/callback', 'https://device.test/wrong']) await assert.rejects(flow.finish(callback(flow.url, uri)), error('callback'));
  const bad = callback(flow.url); bad.searchParams.set('state', 'bad'); await assert.rejects(flow.finish(bad), error('callback'));
  const duplicate = callback(flow.url); duplicate.searchParams.append('state', auth.searchParams.get('state')!); await assert.rejects(flow.finish(duplicate), error('callback'));
  assert.equal(http.count(), 0);
  await flow.finish(callback(flow.url));
  const form = http.forms[0]; assert.equal(form.get('redirect_uri'), opts.redirectUri); assert.equal(form.get('code'), 'code-canary');
  assert.match(form.get('code_verifier')!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), auth.searchParams.get('code_challenge'));
  await assert.rejects(flow.finish(callback(flow.url)), error('callback'));
  assert.equal(await connection.token(), 'access-canary');
  assert.equal(await connect(app, { ...opts, person: 'person-2' }).connected(), false);
  await signed({ ...opts, person: 'person-2' });
  await connection.disconnect(); assert.equal(await connection.connected(), false);
  assert.equal(await connect(app, { ...opts, person: 'person-2' }).token(), 'access-canary');
  assert.equal(store.values.size, 1);
});

test('unspecified scopes leave provider defaults intact instead of sending an invalid empty scope', async () => {
  const c = connect({ id: 'defaults', name: 'App', oauth: { ...app.oauth!, authorize: app.oauth!.authorize + '?scope=stale' }, extra: { scope: 'ignored' } }, options());
  const flow = await c.signIn();
  assert.equal(new URL(flow.url).searchParams.has('scope'), false);
  await flow.finish(callback(flow.url));
  assert.equal(await c.connected(), true);
});

test('a connection snapshots provider settings and cannot be retargeted after signing in', async () => {
  const target: Provider = { ...app, oauth: { ...app.oauth! }, mcpUrl: 'https://resource.test/mcp', scopes: ['read'] };
  const opts = options(), c = connect(target, opts);
  target.oauth!.token = 'https://other.test/token'; target.mcpUrl = 'https://other.test/mcp';
  assert.equal(c.provider.oauth!.token, app.oauth!.token);
  assert.equal(c.provider.mcpUrl, 'https://resource.test/mcp');
  assert.throws(() => { Object.assign(c.provider, { mcpUrl: 'https://other.test/mcp' }); }, TypeError);
  assert.throws(() => { Object.assign(c.provider.oauth!, { token: 'https://other.test/token' }); }, TypeError);
  const flow = await c.signIn(); await flow.finish(callback(flow.url));
  assert.equal(await c.token(), 'access-canary');
});

test('long connection identities fit the real keystore contract and restore across handles', async () => {
  const http = fake(), store = overrideStore({});
  const target = { ...app, id: 'long-provider-' + 'x'.repeat(300), mcpUrl: 'https://resource.test/' + 'path'.repeat(150) };
  const opts = { ...options(http), store, person: 'person-' + 'y'.repeat(300) };
  const c = await signed(opts, target);
  assert.equal(await connect(target, opts).token(), 'access-canary');
  await c.disconnect(); assert.equal(await c.connected(), false);
});

test('a secrets-sealed host store keeps sign-in and rotated refresh grants out of persisted plaintext', async () => {
  const keys = new Map<string, string>(), persisted = memory(), http = fake();
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
  const opts = { ...options(http), store: wrap() }, c = await signed(opts);
  const initial = [...persisted.values.values()][0];
  assert.equal(Buffer.from(initial, 'base64').subarray(0, 4).toString(), 'BKS1');
  http.set({ access_token: 'rotated-access-canary', refresh_token: 'rotated-refresh-canary', expires_in: 3600, token_type: 'Bearer' });
  assert.equal(await c.token('access-canary'), 'rotated-access-canary');
  assert.notEqual([...persisted.values.values()][0], initial);
  for (const value of persisted.values.values()) assert.doesNotMatch(Buffer.from(value, 'base64').toString(), /access-canary|refresh-canary/);
  const reopened = connect(app, { ...opts, store: wrap() });
  assert.equal(await reopened.token(), 'rotated-access-canary');
  await reopened.disconnect(); assert.equal(persisted.values.size, 0);
});

test('declined, unticked, expired, cancelled and superseded flows never save tokens', async () => {
  const http = fake(), opts = options(http), c = connect(app, opts);
  let flow = await c.signIn(); const declined = callback(flow.url); declined.searchParams.set('error', 'access_denied secret-canary');
  await assert.rejects(flow.finish(declined), error('declined'));
  flow = await c.signIn(); http.set({ access_token: 'access-canary', token_type: 'Bearer', scope: 'other' });
  await assert.rejects(flow.finish(callback(flow.url)), error('scope'));
  flow = await c.signIn(); flow.cancel(); await assert.rejects(flow.finish(callback(flow.url)), error('callback'));
  flow = await c.signIn(); await connect(app, opts).signIn(); await assert.rejects(flow.finish(callback(flow.url)), error('callback'));
  let now = 0; const timed = connect(app, { ...opts, now: () => now, flowTimeoutMs: 100 }); flow = await timed.signIn(); now = 101;
  await assert.rejects(flow.finish(callback(flow.url)), error('expired')); assert.equal(await c.connected(), false);
});

test('cancel and expiry during an in-flight exchange never persist the returned grant', async () => {
  for (const mode of ['cancel', 'expire'] as const) {
    let now = 0, started!: () => void, release!: () => void;
    const begun = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const fetcher: typeof fetch = async () => { started(); await gate; return response({ access_token: 'late-canary', token_type: 'Bearer', expires_in: 3600, scope: 'read' }); };
    const c = connect(app, { ...options(), fetch: fetcher, now: () => now, flowTimeoutMs: 100 });
    const flow = await c.signIn(), finishing = flow.finish(callback(flow.url));
    await begun;
    if (mode === 'cancel') flow.cancel(); else now = 101;
    release();
    await assert.rejects(finishing, error(mode === 'cancel' ? 'declined' : 'expired'));
    assert.equal(await c.connected(), false);
  }
});

test('refresh single-flight across handles, rotation, restart, force and no resurrection after disconnect', async () => {
  const http = fake(), opts = options(http); let now = 0; opts.now = () => now;
  const c = await signed(opts); now = 3_600_000;
  http.set({ access_token: 'new-canary', refresh_token: 'rotated-canary', token_type: 'Bearer', expires_in: 30 });
  assert.deepEqual(await Promise.all(Array.from({ length: 12 }, () => connect(app, opts).token())), Array(12).fill('new-canary'));
  assert.equal(http.refreshes(), 1); assert.equal(http.forms[1].get('refresh_token'), 'refresh-canary');
  http.set({ access_token: 'newest-canary', token_type: 'Bearer', expires_in: 3600 });
  assert.equal(await connect(app, opts).token(), 'newest-canary'); assert.equal(http.forms[2].get('refresh_token'), 'rotated-canary');
  assert.equal(await c.token('old-access'), 'newest-canary'); assert.equal(http.refreshes(), 2);
  await c.token('newest-canary'); assert.equal(http.refreshes(), 3);
  // Reconstruct over a new backend object: saved DCR/client/token metadata is sufficient.
  const sameStore = opts.store; assert.equal(await connect(app, { ...opts, store: { get: k => sameStore.get(k), set: (k,v) => sameStore.set(k,v), delete: k => sameStore.delete(k) } }).token(), 'newest-canary');
  now += 3_600_000;
  let started!: () => void, release!: () => void;
  const begun = new Promise<void>(r => { started = r; }), gate = new Promise<void>(r => { release = r; });
  const delayed: typeof fetch = async () => { started(); await gate; return response({ access_token: 'late-canary', token_type: 'Bearer', expires_in: 3600 }); };
  const pending = connect(app, { ...opts, fetch: delayed }).token(); await begun;
  const disconnect = c.disconnect(); release(); await assert.rejects(pending, error('signin')); await disconnect;
  assert.equal(await c.connected(), false);
});

test('transient refresh failures preserve sign-in; invalid_grant removes it; tokens never enter errors', async () => {
  const http = fake(), opts = options(http); let now = 0; opts.now = () => now;
  const c = await signed(opts); now = 3_600_000;
  http.set({ error: 'server_error', error_description: 'access-canary refresh-canary' }, 503);
  await assert.rejects(c.token(), error('token')); assert.equal(await c.connected(), true);
  http.set({ error: 'invalid_grant', error_description: 'refresh-canary' }, 400);
  await assert.rejects(c.token(), error('signin')); assert.equal(await c.connected(), false);
  const other = fake(); now = 0; const d = await signed({ ...opts, fetch: other.fetch }); now = 3_550_000; other.offline();
  assert.equal(await d.token(), 'access-canary'); now = 3_600_001;
  await assert.rejects(d.token(), error('network')); assert.equal(await d.connected(), true);
});

test('MCP discovery follows challenge, issuer path, DCR, resource binding and refresh after restart', async () => {
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
  const c = connect('https://resource.test/mcp', opts), flow = await c.signIn();
  assert.equal(new URL(flow.url).searchParams.get('resource'), 'https://resource.test');
  await flow.finish(callback(flow.url, opts.redirectUri));
  const form = new URLSearchParams(calls.at(-1)!.init!.body as URLSearchParams);
  assert.equal(form.get('resource'), 'https://resource.test'); assert.equal(form.get('client_id'), 'dynamic');
  now = 3_600_000; const before = calls.length; await connect('https://resource.test/mcp', opts).token();
  assert.equal(calls.length, before + 1); assert.equal(calls.at(-1)!.url, 'https://auth.test/token');
  assert.equal(new URLSearchParams(calls.at(-1)!.init!.body as URLSearchParams).get('resource'), 'https://resource.test');
});

test('bad metadata, insecure endpoints and registration cannot start sign-in', async () => {
  const opts = options();
  for (const uri of ['http://remote.test/callback', 'javascript:alert(1)', 'https://user:pass@device.test/callback']) assert.throws(() => connect(app, { ...opts, redirectUri: uri }), error('configuration'));
  const insecure = connect({ ...app, oauth: { ...app.oauth!, token: 'http://remote.test/token' } }, opts);
  await assert.rejects(insecure.signIn(), error('configuration'));
  const f: typeof fetch = async input => String(input).endsWith('/mcp') ? new Response(null, { status: 401 }) : response({ resource: 'https://other.test/mcp', authorization_servers: ['https://auth.test'] });
  await assert.rejects(connect('https://resource.test/mcp', { ...opts, fetch: f }).signIn(), error('discovery'));
  const auth: typeof fetch = async input => String(input).includes('well-known') ? response({ issuer: 'https://auth.test', authorization_endpoint: 'https://auth.test/auth', token_endpoint: 'https://auth.test/token', registration_endpoint: 'https://auth.test/register' }) : response({ client_id: null });
  await assert.rejects(connect({ id: 'dcr', name: 'App', issuer: 'https://auth.test' }, { ...opts, client: undefined, fetch: auth }).signIn(), error('registration'));
});

test('typed MCP client negotiates, sends session/protocol/auth, preserves rich tool/resources/prompts and refreshes a 401', async () => {
  const http = fake(), opts = options(http); const server = 'https://resource.test/mcp';
  const target = { ...app, mcpUrl: server };
  const c = await signed(opts, target);
  const messages: Record<string, unknown>[] = []; let unauthorized = true;
  const fetcher: typeof fetch = async (input, init) => {
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
  const client = await connect(target, { ...opts, fetch: fetcher }).mcp({ configure: client => { client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {}); } });
  try {
    const list = await client.listTools(); assert.equal(list.nextCursor, 'next-page'); assert.equal(list.tools[0].annotations?.readOnlyHint, true);
    const result = await client.callTool({ name: 'read', arguments: {} }, CallToolResultSchema); assert.deepEqual(result.structuredContent, { answer: 42 }); assert.ok(Array.isArray(result.content)); assert.equal(result.content[1].type, 'image');
    const resource = (await client.readResource({ uri: 'fake://data' })).contents[0]; assert.ok('text' in resource); assert.equal(resource.text, 'resource');
    assert.equal((await client.getPrompt({ name: 'greet' })).messages[0].content.type, 'text');
    assert.ok(messages.some(m => m.method === 'notifications/initialized')); assert.equal(http.refreshes(), 1);
  } finally { await client.close(); }
  await c.disconnect();
});

test('loopback completes through real local callback, rejects unrelated requests and closes on cancel', async () => {
  const http = fake(), opts = options(http); const { redirectUri: _uri, ...rest } = opts;
  let callbackUrl = '';
  const flow = await connectLoopback(app, { ...rest, open: async url => {
    callbackUrl = new URL(url).searchParams.get('redirect_uri')!;
    assert.equal((await fetch(new URL('/wrong', callbackUrl))).status, 404);
    const wrong = callback(url, callbackUrl); wrong.searchParams.set('state', 'bad'); assert.equal((await fetch(wrong)).status, 400);
    assert.equal((await fetch(callback(url, callbackUrl))).status, 200);
  } });
  await flow.done; assert.equal(await flow.connection.token(), 'access-canary');
  // A new ephemeral port does not lose the saved connection identity.
  assert.equal(await connect(app, { ...opts, redirectUri: 'http://127.0.0.1:1/callback' }).token(), 'access-canary');
  await assert.rejects(fetch(callbackUrl));
  const cancelled = await connectLoopback(app, { ...rest, open: () => {} }); cancelled.cancel(); await assert.rejects(cancelled.done, error('declined'));
  const timed = await connectLoopback(app, { ...rest, flowTimeoutMs: 20, open: () => {} }); await assert.rejects(timed.done, error('expired'));
  await assert.rejects(connectLoopback('bad-url', { ...rest, open: () => {} }), error('configuration'));
});

test('browser entry bundles without runtime Node, filesystem or keystore code', async () => {
  const result = await build({ entryPoints: ['packages/connect/src/index.ts'], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
  assert.ok(result.outputFiles[0].text.length > 0);
  assert.ok(!Object.keys(result.metafile!.inputs).some(path => /packages\/secrets|node:|\/src\/node\.ts/.test(path)));
  for (const text of [...Object.values(WORDS.errors), ...Object.values(WORDS.browser), ...Object.values(WORDS.verification), ...Object.values(WORDS.clientFile)]) assert.doesNotMatch(text, new RegExp(plain.pattern, 'i'));
  assert.equal(providers.gmail.scopes[0], 'https://www.googleapis.com/auth/gmail.readonly');
});

test('client verification distinguishes rejected details, confirmed details and uncertain provider replies without a grant', async () => {
  const store = memory(), http = fake();
  const c = connect({ ...providers.google, oauth: app.oauth }, { ...options(http, store), client: { id: 'client', secret: 'secret-canary' } });
  http.set({ error: 'invalid_client', error_description: 'Wrong secret-canary' }, 401);
  const invalid = await c.verifyClient(); assert.equal(invalid.outcome, 'invalid');
  assert.doesNotMatch(JSON.stringify(invalid), /secret-canary/);
  http.set({ error: 'invalid_grant' }, 400);
  assert.equal((await c.verifyClient()).outcome, 'valid');
  for (const code of ['unauthorized_client', 'invalid_request', 'server_error', 'invalid_grant']) {
    http.set({ error: code }, 503);
    assert.equal((await c.verifyClient()).outcome, 'inconclusive');
  }
  http.set({ access_token: 'probe-access-canary', token_type: 'Bearer' });
  assert.equal((await c.verifyClient()).outcome, 'inconclusive');
  http.offline(); assert.equal((await c.verifyClient()).outcome, 'inconclusive');
  assert.equal(store.values.size, 0);
  for (const form of http.forms) {
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'byokit-client-check-not-a-grant');
  }
});

test('refresh lifetime survives sign-in, restart and refresh; OAuth causes redact supplied and returned credentials', async () => {
  const http = fake(), store = memory(); let now = 1000;
  const opts = { ...options(http, store), client: { id: 'client', secret: 'secret-canary' }, now: () => now };
  http.set({ access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', expires_in: 3600, refresh_token_expires_in: 7200 });
  const c = await signed(opts);
  assert.equal((await c.grant())?.refreshTokenExpiresIn, 7200);
  assert.equal((await connect(app, opts).grant())?.refreshTokenExpiresAt, 7_201_000);
  http.set({ access_token: 'rotated-access-canary', token_type: 'Bearer', expires_in: 3600 });
  await c.token('access-canary');
  assert.equal((await c.grant())?.refreshTokenExpiresAt, 7_201_000);
  http.set({ access_token: 'rotated-access-canary', refresh_token: 'rotated-refresh-canary', token_type: 'Bearer', expires_in: 3600, refresh_token_expires_in: 9000 });
  await c.token('rotated-access-canary');
  assert.equal((await c.grant())?.refreshTokenExpiresIn, 9000);
  assert.equal((await c.grant())?.refreshTokenExpiresAt, 9_001_000);
  http.set({ error: 'server_error', error_description: 'Setup delayed: secret-canary rotated-refresh-canary rotated-access-canary https://example.test/?key=private', access_token: 'returned-canary' }, 503);
  await assert.rejects(c.token('rotated-access-canary'), (e: unknown) => {
    assert.ok(e instanceof ConnectError); assert.equal(e.cause?.error, 'server_error');
    assert.match(e.cause?.error_description ?? '', /Setup delayed/);
    assert.doesNotMatch(JSON.stringify(e), /secret-canary|refresh-canary|rotated-access-canary|returned-canary|private/);
    assert.doesNotMatch(String(e) + JSON.stringify(e.cause), /secret-canary|refresh-canary|rotated-access-canary|returned-canary|private/);
    return true;
  });
  http.set({ error: 'invalid_grant', error_description: 'rotated-refresh-canary secret-canary' }, 400);
  await assert.rejects(c.token('rotated-access-canary'), (e: unknown) => e instanceof ConnectError && e.code === 'signin' && e.cause?.error === 'invalid_grant');
  assert.equal(await c.connected(), false);
  now = 1000; http.set({ access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', refresh_token_expires_in: 1 });
  const expired = await signed(opts); now = 2000;
  const before = http.count(); await assert.rejects(expired.token('access-canary'), error('signin')); assert.equal(http.count(), before);
});


test('verification uses supplied basic credentials and leaves an existing grant unchanged', async () => {
  const http = fake(), store = memory(), opts = options(http, store), c = await signed(opts);
  const original = [...store.values.values()];
  const probe: typeof fetch = async (_url, init) => {
    const form = new URLSearchParams(init?.body as URLSearchParams);
    assert.equal(form.has('client_secret'), false); assert.equal(form.has('client_id'), false);
    assert.ok(new Headers(init?.headers).get('authorization')?.startsWith('Basic '));
    return response({ error: 'invalid_client', error_description: 'Wrong key canary%2Bsecret canary+secret' }, 400);
  };
  const check = await connect(app, { ...opts, fetch: probe }).verifyClient({ id: 'entered', secret: 'canary+secret', authMethod: 'client_secret_basic' });
  assert.equal(check.outcome, 'invalid'); assert.doesNotMatch(JSON.stringify(check), /canary/);
  assert.deepEqual([...store.values.values()], original);
  assert.equal(await c.token(), 'access-canary');
  await assert.rejects(c.verifyClient({ id: 'entered' }), error('configuration'));
  const malformed = connect(app, { ...opts, fetch: async () => new Response('not JSON', { status: 502 }) });
  assert.equal((await malformed.verifyClient({ id: 'entered', secret: 'canary' })).outcome, 'inconclusive');
});

test('authorization and callback failures retain sanitized provider causes', async () => {
  const http = fake(), c = connect(app, { ...options(http), client: { id: 'client', secret: 'secret-canary' } });
  let flow = await c.signIn();
  http.set({ error: 'invalid_grant', error_description: 'Expired code-canary secret-canary' }, 400);
  await assert.rejects(flow.finish(callback(flow.url)), (e: unknown) => {
    assert.ok(e instanceof ConnectError); assert.equal(e.cause?.error, 'invalid_grant');
    assert.match(e.cause?.error_description ?? '', /Expired/); assert.doesNotMatch(JSON.stringify(e.cause), /canary/); return true;
  });
  flow = await c.signIn();
  const declined = callback(flow.url); declined.searchParams.set('error', 'access_denied');
  declined.searchParams.append('code', 'second-code-canary');
  declined.searchParams.set('error_description', `No permission for secret-canary code-canary second-code-canary ${declined.searchParams.get('state')}`);
  await assert.rejects(flow.finish(declined), (e: unknown) => {
    assert.ok(e instanceof ConnectError); assert.equal(e.code, 'declined'); assert.equal(e.cause?.error, 'access_denied');
    assert.doesNotMatch(JSON.stringify(e.cause), /canary/); return true;
  });
});

test('house Google client file drives Gmail consent, an approved send, both denials and a missing client', async () => {
  const dir = scratchDir('connect-house'), path = join(dir, 'google-oauth-client.json');
  const store = memory(), seen: string[] = [], forms: URLSearchParams[] = [];
  const SCOPES = [...providers.gmail.scopes, 'https://www.googleapis.com/auth/gmail.send'];
  const google: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); seen.push(url.host + url.pathname);
    if (url.href === providers.gmail.oauth.token) { forms.push(new URLSearchParams(init?.body as URLSearchParams)); return response({ access_token: 'access-canary', refresh_token: 'refresh-canary', token_type: 'Bearer', expires_in: 3600, scope: SCOPES.join(' ') }); }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer access-canary');
    return response({ id: 'sent-1', threadId: 't-1', labelIds: ['SENT'] });
  };
  const opts = { store, person: 'Umer', scopes: SCOPES, fetch: google };
  // Missing: no file means Google is not set up; sign-in stops before any provider call.
  assert.equal(await googleClientFile(path), null);
  await assert.rejects(connect('gmail', { ...opts, redirectUri: 'http://127.0.0.1:1/callback' }).signIn(), error('configuration'));
  assert.deepEqual(seen, []);
  // A readable-by-others file or a non-Desktop client is refused without echoing its contents.
  writeFileSync(path, JSON.stringify({ installed: { client_id: '123-house.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-canary' } }), { mode: 0o644 }); chmodSync(path, 0o644);
  if (process.platform !== 'win32') await assert.rejects(googleClientFile(path), (e: Error) => e.message === WORDS.clientFile.mode);
  writeFileSync(path, JSON.stringify({ web: { client_id: '123-house.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-canary' } })); chmodSync(path, 0o600);
  await assert.rejects(googleClientFile(path), (e: Error) => e.message === WORDS.clientFile.shape);
  writeFileSync(path, JSON.stringify({ installed: { client_id: '123-house.apps.googleusercontent.com', client_secret: 'GOCSPX-secret-canary', redirect_uris: ['http://localhost'] } }));
  const client = await googleClientFile(path);
  assert.deepEqual(client, { id: '123-house.apps.googleusercontent.com', secret: 'GOCSPX-secret-canary' });
  // Deny on Google's consent page: nothing is saved.
  const refused = await connectLoopback('gmail', { ...opts, client: client!, open: async url => {
    const back = new URL(new URL(url).searchParams.get('redirect_uri')!); back.searchParams.set('state', new URL(url).searchParams.get('state')!); back.searchParams.set('error', 'access_denied');
    assert.equal((await fetch(back)).status, 400);
  } });
  await assert.rejects(refused.done, error('declined'));
  assert.equal(await refused.connection.connected(), false);
  // Approve: the consent URL carries the house client and both Gmail scopes; the exchange authenticates with its secret.
  const flow = await connectLoopback('gmail', { ...opts, client: client!, open: async url => {
    const asked = new URL(url).searchParams;
    assert.equal(asked.get('client_id'), client!.id); assert.equal(asked.get('scope'), SCOPES.join(' '));
    assert.equal(asked.get('access_type'), 'offline'); assert.equal(asked.get('prompt'), 'consent');
    assert.equal((await fetch(callback(url, asked.get('redirect_uri')!))).status, 200);
  } });
  await flow.done;
  assert.equal(forms[0].get('client_id'), client!.id); assert.equal(forms[0].get('client_secret'), client!.secret);
  // Deny the send: no token use and no Gmail call. Approve it: exactly one send.
  const before = seen.length;
  await assert.rejects(new MailSender(flow.connection, () => false, { fetch: google }).send({ to: 'crew@example.test', subject: 'Hi', body: 'From Umer' }),
    (e: unknown) => e instanceof MailError && e.code === 'denied');
  assert.equal(seen.length, before);
  const sent = await new MailSender(flow.connection, () => true, { fetch: google }).send({ to: 'crew@example.test', subject: 'Hi', body: 'From Umer' });
  assert.equal(sent.id, 'sent-1');
  assert.deepEqual(seen.slice(before), ['gmail.googleapis.com/gmail/v1/users/me/messages/send']);
});
