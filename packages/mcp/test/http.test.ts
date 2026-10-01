import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { format, inspect } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { fileStore } from '@byokit/secrets';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deviceFlow, hostedMcp, McpError } from '../src/index.ts';
import type { Keystore } from '@byokit/secrets';

async function fixture(limits: { sessionMs?: number; maxSessions?: number } = {}) {
  let now = Date.now();
  const saved = new Map<string, string>();
  let fail = '';
  let handlerFail = '';
  const store: Keystore = {
    async get(k) { if (fail) throw new Error(fail); return saved.get(k) ?? null; },
    async set(k, v) { if (fail) throw new Error(fail); saved.set(k, v); },
    async delete(k) { return saved.delete(k); },
  };
  let kit: ReturnType<typeof hostedMcp>;
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
    m.tool('failure', { inputSchema: {} }, () => { throw new Error(handlerFail); });
    m.resource('profile', 'demo://profile', { mimeType: 'text/plain' }, (uri, ctx) => ({ contents: [
      { uri: uri.href, text: ctx.principal.name, mimeType: 'text/plain' },
    ] }));
    m.resource('failure', 'demo://failure', {}, () => { throw new Error(handlerFail); });
  } });
  const clients: Client[] = [];
  return { url, auth, saved, setFail(v: string) { fail = v; }, setHandlerFail(v: string) { handlerFail = v; }, advance(ms: number) { now += ms; },
    async issue(id = 'umer', name = 'Umer') {
      const offer = auth.begin(); auth.approve(offer.user_code, { id, name }); return (await auth.poll(offer.device_code)).access_token;
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

test('concurrent sessions isolate their principals; an existing session uses the current request identity', async () => {
  const f = await fixture();
  try {
    const token = await f.issue(), other = await f.issue('other', 'another account');
    const a = await f.connect(token), b = await f.connect(other);
    const answers = await Promise.all([a.client.callTool({ name: 'hello', arguments: { name: 'A' } }),
      b.client.callTool({ name: 'hello', arguments: { name: 'B' } })]);
    assert.deepEqual(answers.map(a => a.content), [
      [{ type: 'text', text: 'Umer says hello to A.' }],
      [{ type: 'text', text: 'another account says hello to B.' }],
    ]);
    const fresh = await f.issue('umer', 'current name');
    const response = await post(f.url, { jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'hello', arguments: { name: 'C' } } }, {
      Authorization: `Bearer ${fresh}`, 'mcp-session-id': a.transport.sessionId!,
      Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25',
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    assert.match(await response.text(), /current name says hello to C/);
  } finally { await f.close(); }
});

test('bounded sessions expire, malformed initialization releases capacity and shutdown refuses new requests', async () => {
  const f = await fixture({ sessionMs: 200, maxSessions: 1 });
  try {
    const token = await f.issue();
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' };
    assert.equal((await post(f.url, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, headers)).status, 400);
    const { transport } = await f.connect(token);
    const session = transport.sessionId!;
    assert.equal((await post(f.url, {}, headers)).status, 429);
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal((await fetch(f.url, { headers: { ...headers, 'mcp-session-id': session } })).status, 404);
    await f.connect(token);
    await f.stop();
    assert.equal((await post(f.url, {}, headers)).status, 404);
  } finally { await f.close(); }
});

test('real HTTP initializes, lists, calls and streams progress; resources and DELETE use the SDK', async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    const { client, transport } = await f.connect(token);
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
    // The SDK client already owns the session's standalone GET SSE stream.
    const controller = new AbortController();
    const stream = await fetch(f.url, { headers: { Authorization: `Bearer ${token}`,
      'mcp-session-id': transport.sessionId!, Accept: 'text/event-stream' }, signal: controller.signal });
    assert.equal(stream.status, 409);
    controller.abort();
    const ended = transport.sessionId!;
    await transport.terminateSession();
    assert.equal((await fetch(f.url, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`,
      'mcp-session-id': ended } })).status, 404);
  } finally { await f.close(); }
});

test('every HTTP method authenticates; users cannot borrow a session; revocation and expiry reject existing sessions', async () => {
  const f = await fixture();
  try {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const res = await fetch(f.url, { method });
      assert.equal(res.status, 401); assert.equal(res.headers.get('www-authenticate'), 'Bearer');
      assert.match(await res.text(), /Sign in/);
    }
    const token = await f.issue(), other = await f.issue('other', 'another account');
    const { transport } = await f.connect(token);
    const headers = { Authorization: `Bearer ${other}`, 'mcp-session-id': transport.sessionId! };
    assert.equal((await fetch(f.url, { headers })).status, 404);
    assert.equal((await post(f.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, headers)).status, 404);
    await f.auth.revoke(token);
    assert.equal((await fetch(f.url, { headers: { ...headers, Authorization: `Bearer ${token}` } })).status, 401);
    f.advance(30_000);
    assert.equal((await f.auth.authenticate(other)), null);
    assert.equal((await post(f.url, {}, { Authorization: `Bearer ${other}` })).status, 401);
    assert.equal((await post(f.url + '/device/code', {}, { Origin: 'https://untrusted.example' })).status, 403);
  } finally { await f.close(); }
});

test('device flow over HTTP: approval, polling interval, single use, code expiry and hashed tokens', async () => {
  const f = await fixture();
  try {
    const response = await post(f.url + '/device/code', {});
    assert.equal(response.status, 200);
    const offer = await response.json();
    const poll = () => post(f.url + '/device/token', { device_code: offer.device_code });
    assert.equal((await (await poll()).json()).error, 'pending');
    f.auth.approve(offer.user_code.toLowerCase(), { id: 'umer', name: 'Umer' });
    assert.equal((await poll()).status, 429);
    f.advance(1000);
    const [a, b] = await Promise.all([poll(), poll()]);
    assert.equal([a.status, b.status].filter(s => s === 200).length, 1);
    const issued = await (a.status === 200 ? a : b).json();
    assert.deepEqual(await f.auth.authenticate(issued.access_token), { id: 'umer', name: 'Umer' });
    assert.ok(!JSON.stringify([...f.saved]).includes(issued.access_token));
    assert.equal((await (await poll()).json()).error, 'expired');
    const expired = f.auth.begin(); f.advance(10_000);
    assert.throws(() => f.auth.approve(expired.user_code, { id: 'umer', name: 'Umer' }), McpError);
    assert.equal((await (await post(f.url + '/device/token', { device_code: expired.device_code })).json()).error, 'expired');
    assert.equal((await post(f.url + '/device/token', { device_code: 123 })).status, 400);
    assert.equal((await post(f.url + '/device/token', { device_code: 'x'.repeat(5000) })).status, 400);
  } finally { await f.close(); }
});

test('storage and handler failures redact credentials in HTTP, protocol results and typed exceptions', async () => {
  const f = await fixture();
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  for (const method of ['log', 'warn', 'error'] as const) console[method] = (...args) => { logs.push(format(...args)); };
  try {
    const token = await f.issue();
    const { client } = await f.connect(token);
    f.setFail(`private bearer ${token}`);
    const offer = f.auth.begin(); f.auth.approve(offer.user_code, { id: 'umer', name: 'Umer' });
    const response = await post(f.url + '/device/token', { device_code: offer.device_code });
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes(token));
    await assert.rejects(f.auth.authenticate(token), e => e instanceof McpError && !inspect(e).includes(token));
    f.setFail('');
    // Leave authentication operational while handler failures contain the bearer credential.
    f.setHandlerFail(token);
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
});

test('device credentials persist through the sealed secrets backend, without plaintext tokens on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-sealed-'));
  try {
    const path = join(dir, 'credentials');
    const store = fileStore({ path, passphrase: 'test-only-passphrase' });
    const options = { store, verificationUri: 'https://demo.example/approve' };
    const auth = deviceFlow(options), offer = auth.begin();
    auth.approve(offer.user_code, { id: 'umer', name: 'Umer' });
    const { access_token: token } = await auth.poll(offer.device_code);
    assert.ok(!(await readFile(path)).includes(Buffer.from(token)));
    assert.deepEqual(await deviceFlow(options).authenticate(token), { id: 'umer', name: 'Umer' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
