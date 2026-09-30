import WORDS from '../src/words.json' with { type: 'json' };
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { connect, ConnectError, providers, type Provider, type ConnectOptions, CallToolResultSchema, ToolListChangedNotificationSchema } from '../src/index.ts';
import { connectLoopback } from '../src/node.ts';
import { overrideStore } from '../../secrets/src/index.ts';
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
function options(http = fake(), store = memory()): ConnectOptions { return { store, person: 'alice', client: { id: 'client' }, redirectUri: 'https://device.test/callback', fetch: http.fetch }; }
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
  assert.equal(await connect(app, { ...opts, person: 'bob' }).connected(), false);
  await signed({ ...opts, person: 'bob' });
  await connection.disconnect(); assert.equal(await connection.connected(), false);
  assert.equal(await connect(app, { ...opts, person: 'bob' }).token(), 'access-canary');
  assert.equal(store.values.size, 1);
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
  const store = memory(), opts: ConnectOptions = { store, person: 'alice', redirectUri: 'myapp://callback', fetch: fetcher, now: () => now };
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
  for (const text of [...Object.values(WORDS.errors), ...Object.values(WORDS.browser)]) assert.doesNotMatch(text, new RegExp(plain.pattern, 'i'));
  assert.equal(providers.gmail.scopes[0], 'https://www.googleapis.com/auth/gmail.readonly');
});
