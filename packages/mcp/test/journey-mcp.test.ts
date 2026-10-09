// Consumer journeys for the published @byokit/mcp surface, driven the way a host app uses it: `deviceFlow` and
// `hostedMcp` are wired exactly as the README quickstart shows, an HTTP server mounts `kit.handle`, and the real
// streamable-HTTP SDK client signs in with the issued bearer token. Every import is a published entry
// (`@byokit/mcp`, `@byokit/secrets`): no src, no internals. The security and correctness contracts the old suite
// held survive as assertions inside a journey: every transport method authenticates with a Bearer token, a session
// belongs to one person and names the current request's identity, codes are interval-limited and single-use, tokens
// are stored hashed and never leave through a failing backend, a handler error, a log, or the sealed file on disk,
// sessions are capped, expire and refuse work after shutdown, and the tool-call, progress, resource and termination
// transport contracts hold.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { format, inspect } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { overrideStore, fileStore, type Keystore } from '@byokit/secrets';
import { deviceFlow, hostedMcp, McpError } from '@byokit/mcp';

async function start(limits: { sessionMs?: number; maxSessions?: number } = {}) {
  let now = Date.now();
  let storeFailure = '';
  let handlerFailure = '';
  const base = overrideStore({});
  const store: Keystore = {
    async get(name) { if (storeFailure) throw new Error(storeFailure); return base.get(name); },
    async set(name, value) { if (storeFailure) throw new Error(storeFailure); return base.set(name, value); },
    async delete(name) { if (storeFailure) throw new Error(storeFailure); return base.delete(name); },
  };
  let kit: ReturnType<typeof hostedMcp>;
  const clients: Client[] = [];
  const http = createServer((req, res) => { void kit.handle(req, res); });
  http.listen(0, '127.0.0.1');
  await once(http, 'listening');
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  const auth = deviceFlow({ store, verificationUri: url + '/approve', now: () => now,
    codeSeconds: 10, tokenSeconds: 30, intervalSeconds: 1 });
  kit = hostedMcp({ name: 'demo', version: '0.1.0', url, auth, device: auth, ...limits, mount(m) {
    m.tool('hello', { inputSchema: { name: z.string() } }, async ({ name }, ctx) => {
      await ctx.progress(1, 2);
      await new Promise(resolve => setTimeout(resolve, 5));
      await ctx.progress(2, 2);
      return { content: [{ type: 'text', text: `${ctx.principal.name} says hello to ${name}.` }] };
    });
    m.tool('failure', { inputSchema: {} }, () => { throw new Error(handlerFailure); });
    m.resource('profile', 'demo://profile', { mimeType: 'text/plain' }, (uri, ctx) => ({ contents: [
      { uri: uri.href, text: ctx.principal.name, mimeType: 'text/plain' },
    ] }));
    m.resource('failure', 'demo://failure', {}, () => { throw new Error(handlerFailure); });
  } });
  return { url, auth, store,
    failStore(v: string) { storeFailure = v; },
    failHandler(v: string) { handlerFailure = v; },
    advance(ms: number) { now += ms; },
    async issue(id = 'umer', name = 'Umer') {
      const offer = auth.begin(); auth.approve(offer.user_code, { id, name });
      return (await auth.poll(offer.device_code)).access_token;
    },
    async connect(token: string) {
      const client = new Client({ name: 'test', version: '1' });
      clients.push(client);
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      return { client, transport };
    },
    stop: () => kit.close(),
    async close() {
      await Promise.all(clients.map(c => c.close()));
      await kit.close();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve()));
    } };
}
const post = (url: string, value: unknown, headers?: Record<string, string>) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
});

test('a person signs in on a device and the host app calls its tools and resources over HTTP', async () => {
  const f = await start();
  try {
    const response = await post(f.url + '/device/code', {});
    assert.equal(response.status, 200);
    const offer = await response.json();
    assert.equal(offer.verification_uri, f.url + '/approve');
    assert.equal(offer.expires_in, 10);
    assert.match(offer.user_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const poll = () => post(f.url + '/device/token', { device_code: offer.device_code });
    assert.equal((await (await poll()).json()).error, 'pending', 'approval is still needed');

    f.advance(1000);
    f.auth.approve(offer.user_code.toLowerCase(), { id: 'umer', name: 'Umer' });
    const token = await (await poll()).json();
    assert.equal(token.token_type, 'Bearer');
    assert.equal(token.expires_in, 30);

    const { client, transport } = await f.connect(token.access_token);
    assert.equal(client.getServerVersion()?.name, 'demo');
    assert.ok(transport.sessionId);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ['hello', 'failure']);
    const progress: number[] = [];
    const answer = await client.callTool({ name: 'hello', arguments: { name: 'the team' } }, undefined,
      { onprogress(p) { progress.push(p.progress); } });
    assert.deepEqual(answer.content, [{ type: 'text', text: 'Umer says hello to the team.' }]);
    assert.deepEqual(progress, [1, 2]);
    assert.equal((await client.listResources()).resources[0].uri, 'demo://profile');
    const profile = (await client.readResource({ uri: 'demo://profile' })).contents[0];
    assert.ok('text' in profile);
    assert.equal(profile.text, 'Umer');

    // The SDK client owns the session's standalone GET SSE stream; a second one is refused.
    const controller = new AbortController();
    const stream = await fetch(f.url, { headers: { Authorization: `Bearer ${token.access_token}`,
      'mcp-session-id': transport.sessionId!, Accept: 'text/event-stream' }, signal: controller.signal });
    assert.equal(stream.status, 409);
    controller.abort();
    const ended = transport.sessionId!;
    await transport.terminateSession();
    assert.equal((await fetch(f.url, { method: 'DELETE', headers: { Authorization: `Bearer ${token.access_token}`,
      'mcp-session-id': ended } })).status, 404);
  } finally { await f.close(); }
});

test('every transport method authenticates; a session belongs to one person and names the current identity', async () => {
  const f = await start();
  try {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await fetch(f.url, { method });
      assert.equal(res.status, 401); assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      assert.match(await res.text(), /Sign in/);
    }
    assert.equal((await post(f.url + '/device/code', {}, { Origin: 'https://untrusted.example' })).status, 403);

    const token = await f.issue(), other = await f.issue('other', 'another account');
    const a = await f.connect(token), b = await f.connect(other);
    const answers = await Promise.all([a.client.callTool({ name: 'hello', arguments: { name: 'A' } }),
      b.client.callTool({ name: 'hello', arguments: { name: 'B' } })]);
    assert.deepEqual(answers.map(x => x.content), [
      [{ type: 'text', text: 'Umer says hello to A.' }],
      [{ type: 'text', text: 'another account says hello to B.' }],
    ]);

    // Another person cannot borrow this session...
    const borrowed = { Authorization: `Bearer ${other}`, 'mcp-session-id': a.transport.sessionId! };
    assert.equal((await fetch(f.url, { headers: borrowed })).status, 404);
    assert.equal((await post(f.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, borrowed)).status, 404);
    // ...and an existing session answers as the identity of the current request.
    const fresh = await f.issue('umer', 'current name');
    const response = await post(f.url, { jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'hello', arguments: { name: 'C' } } }, {
      Authorization: `Bearer ${fresh}`, 'mcp-session-id': a.transport.sessionId!,
      Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    assert.match(await response.text(), /current name says hello to C/);

    // Revocation and expiry stop an existing session.
    await f.auth.revoke(token);
    assert.equal((await fetch(f.url, { headers: { ...borrowed, Authorization: `Bearer ${token}` } })).status, 401);
    f.advance(30_000);
    assert.equal(await f.auth.authenticate(other), null);
    assert.equal((await post(f.url, {}, { Authorization: `Bearer ${other}` })).status, 401);
  } finally { await f.close(); }
});

test('a sign-in code is interval-limited, single-use and expiring, and malformed polls are refused', async () => {
  const f = await start();
  try {
    const offer = await (await post(f.url + '/device/code', {})).json();
    const poll = () => post(f.url + '/device/token', { device_code: offer.device_code });
    assert.equal((await (await poll()).json()).error, 'pending');
    f.auth.approve(offer.user_code.toLowerCase(), { id: 'umer', name: 'Umer' });
    assert.equal((await poll()).status, 429, 'no faster than the advertised interval');
    f.advance(1000);
    const [a, b] = await Promise.all([poll(), poll()]);
    assert.equal([a.status, b.status].filter(s => s === 200).length, 1, 'exactly one of two racing polls issues');
    const issued = await (a.status === 200 ? a : b).json();
    assert.deepEqual(await f.auth.authenticate(issued.access_token), { id: 'umer', name: 'Umer' });
    assert.equal((await (await poll()).json()).error, 'expired', 'a grant is issued once');
    const stale = f.auth.begin(); f.advance(10_000);
    assert.throws(() => f.auth.approve(stale.user_code, { id: 'umer', name: 'Umer' }), McpError);
    assert.equal((await (await post(f.url + '/device/token', { device_code: stale.device_code })).json()).error, 'expired');
    assert.equal((await post(f.url + '/device/token', { device_code: 123 })).status, 400);
    assert.equal((await post(f.url + '/device/token', { device_code: 'x'.repeat(5000) })).status, 400);
  } finally { await f.close(); }
});

test('sessions are capped and expire, and shutdown refuses new work', async () => {
  const f = await start({ sessionMs: 200, maxSessions: 1 });
  try {
    const token = await f.issue();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' };
    assert.equal((await post(f.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)).status, 400);
    const { transport } = await f.connect(token);
    const session = transport.sessionId!;
    assert.equal((await post(f.url, {}, headers)).status, 429, 'the freed malformed slot is now full');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await fetch(f.url, { headers: { ...headers, 'mcp-session-id': session } })).status, 404);
    await f.connect(token);
    await f.stop();
    assert.equal((await post(f.url, {}, headers)).status, 404);
  } finally { await f.close(); }
});

test('credentials never leave through a failing backend, a handler error, a log, or the sealed file on disk', async () => {
  const f = await start();
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ['log', 'warn', 'error'] as const) console[method] = (...args) => { logs.push(format(...args)); };
  try {
    const token = await f.issue();
    const { client } = await f.connect(token);
    f.failStore(`private bearer ${token}`);
    const offer = f.auth.begin(); f.auth.approve(offer.user_code, { id: 'umer', name: 'Umer' });
    const response = await post(f.url + '/device/token', { device_code: offer.device_code });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes(token));
    await assert.rejects(f.auth.authenticate(token), e => e instanceof McpError && !inspect(e).includes(token));
    f.failStore('');
    // A handler failure reaches the protocol as a fixed sentence, never the credential it carried.
    f.failHandler(token);
    const failure = await client.callTool({ name: 'failure' });
    assert.equal(failure.isError, true);
    assert.deepEqual(failure.content, [{ type: 'text', text: new McpError('failed').message }]);
    assert.ok(!JSON.stringify(failure).includes(token));
    await assert.rejects(client.readResource({ uri: 'demo://failure' }), e => !inspect(e).includes(token));
    assert.ok(!logs.some(line => line.includes(token)));
  } finally {
    Object.assign(console, original);
    await f.close();
  }

  // A host persists grants with the sealed secrets backend: the file holds no plaintext token, and a new
  // process with the same store signs the same token in.
  const dir = await mkdtemp(join(tmpdir(), 'mcp-sealed-'));
  try {
    const path = join(dir, 'credentials');
    const options = { store: fileStore({ path, passphrase: 'test-only-passphrase' }),
      verificationUri: 'https://demo.example/approve' };
    const auth = deviceFlow(options), offer = auth.begin();
    auth.approve(offer.user_code, { id: 'umer', name: 'Umer' });
    const { access_token: token } = await auth.poll(offer.device_code);
    assert.ok(!(await readFile(path)).includes(Buffer.from(token)));
    assert.deepEqual(await deviceFlow(options).authenticate(token), { id: 'umer', name: 'Umer' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
