// Routing @byokit/pair through the relay end to end: blind frames, a host replaced by a newer copy of itself, a
// reconnect that sends the queued requests, typed pairing through a short code, and the per-address limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostId, keyPair, pairWithCode } from '@byokit/pair';
import { CLOSE, LIMITS, RELAY_LOOKUP_MS, Relay, RelayClient, RelayLookupError, findHost } from '../src/index.ts';
import { closed, device, hostClient, paired, sleep, startHost, startRelay, until } from './helpers.ts';
import { linkUrl } from '../src/device.ts';
import { Handshake, firstFrame } from '../../pair/src/channel.ts';
import { codeKey, parseCode } from '../../pair/src/pairing.ts';

test('linkUrl builds device addresses from host ids and findHost reuses the same address', async () => {
  const id = hostId(keyPair().publicKey);
  for (const [protocol, expected] of [['https', 'wss'], ['wss', 'wss'], ['http', 'ws'], ['ws', 'ws']]) {
    assert.equal(linkUrl(`${protocol}://relay.example:7300/ignored?query=1#fragment`, id), `${expected}://relay.example:7300/link/v1/${id}`);
  }
  assert.equal(linkUrl('http://[::1]:7300', id), `ws://[::1]:7300/link/v1/${id}`);
  for (const bad of ['', 'x/../../other', 'a'.repeat(21), 'a'.repeat(23)]) assert.throws(() => linkUrl('https://relay.example', bad));
  assert.throws(() => linkUrl('ftp://relay.example', id));
  const relay = 'https://relay.example/path';
  assert.equal(await findHost(relay, ' K7M2QX ', { fetch: async (input) => {
    assert.equal(String(input), 'https://relay.example/relay/v1/codes/K7M2QX');
    return Response.json({ host: id });
  } }), linkUrl(relay, id));
});

test('a device reaches its host through the relay, which routes by host address and never sees plaintext', async () => {
  const r = await startRelay();
  const p = await paired(r);
  assert.equal(p.client.id, hostId(p.host.keys.publicKey));
  assert.deepEqual(await p.dev.link.request('send.secret', { text: 'plaintext-marker' }), { op: 'send.secret', args: { text: 'plaintext-marker' }, by: p.grant.device.id });
  await until(() => r.relay.count(p.host.id) === 1);
  assert.deepEqual(r.relay.hosts().map((h) => [h.id, h.online, h.devices]), [[p.host.id, true, 1]]);
  const all = p.wire.join('\n');
  assert.ok(p.wire.some((w) => w.startsWith('{"c":')), 'device frames went over the host socket');
  assert.doesNotMatch(all, /plaintext-marker|Away phone|send\.secret|Kitchen computer/, 'the relay saw only ciphertext');
  assert.doesNotMatch(all, new RegExp(p.grant.device.id), "and never the device's id");
  // Revoke works the same way through the relay, and closing the device's socket ends it at the host.
  await p.host.revoke(p.grant.device.id);
  await until(() => p.dev.link.status === 'removed');
  await until(() => r.relay.count(p.host.id) === 0);
});

test('a newer copy of the host replaces the older one, which stops rather than fight back', async () => {
  const r = await startRelay();
  const p = await paired(r);
  await p.dev.link.request('ping');
  // The same computer restarted as a new process: same key, same stored grants.
  const again = await startHost(p.host.keys, p.grants);
  const newer = hostClient(again, r.ws);
  await until(() => newer.client.status === 'online');
  await until(() => p.client.status === 'replaced');
  assert.deepEqual(p.seen.slice(-1), ['replaced']);
  // The device's old connection went with the old socket; it reconnects on its own and the newer host serves it.
  assert.deepEqual(await p.dev.link.request('after'), { op: 'after', by: p.grant.device.id });
  assert.equal(r.relay.count(p.host.id), 1);
  await sleep(1500);
  assert.equal(p.client.status, 'replaced', 'no reconnect from the replaced copy');
  assert.equal(newer.client.status, 'online');
});

test('the host reconnects after the relay restarts, and requests queued meanwhile go out once it is back', async () => {
  const first = await startRelay();
  const p = await paired(first);
  await p.dev.link.request('before');
  const port = Number(new URL(first.http).port);
  const state = first.saved();
  first.stop();
  await until(() => p.client.status === 'offline');
  const code = p.client.code(); // queued: the relay is down
  const r = await startRelay({ store: { load: () => state, save: () => {} } }, port);
  assert.match((await code).code, /^[0-9A-Z]{6}$/);
  assert.equal(p.client.status, 'online');
  assert.deepEqual(await p.dev.link.request('after'), { op: 'after', by: p.grant.device.id }, 'the device found its host again');
  assert.equal(r.relay.count(p.host.id), 1);
});

test('with nothing listening, the host stays alive, goes offline, retries, and registers once a relay starts', async () => {
  const free = await startRelay();
  const port = Number(new URL(free.http).port);
  free.stop(); // the port is now refused
  const host = await startHost();
  const h = hostClient(host, free.ws);
  await until(() => h.client.status === 'offline');
  assert.ok((h.client as any).timer, 'a reconnect is scheduled');
  await until(() => h.seen.filter((s) => s === 'offline').length >= 2, 10_000); // it retried, and failed again
  assert.ok((h.client as any).timer, 'and scheduled another');
  const r = await startRelay({}, port);
  await r.relay.admit(host.keys.publicKey);
  await until(() => h.client.status === 'online', 10_000);
  assert.equal(r.relay.count(host.id), 0);
  assert.deepEqual(r.relay.hosts().map((x) => [x.id, x.online]), [[host.id, true]]);
});

test('a dropped socket retains no more than 64 unanswered outbound calls', async () => {
  class FakeSocket extends EventTarget {
    readyState = 1;
    send() {}
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
    constructor(_url: string) { super(); queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ready', id: 'host', vapid: 'key' }) }))); }
  }
  const host = await startHost();
  const client = new RelayClient(host, { url: 'ws://unused', WebSocket: FakeSocket as any });
  await until(() => client.status === 'online');
  const calls = Array.from({ length: 70 }, () => client.code().then(() => 'ok', (e: Error) => e.message));
  (client as any).ws.close(1006);
  await until(() => client.status === 'offline');
  client.stop();
  const results = await Promise.all(calls);
  assert.equal(results.filter((v) => v === 'relay queue full').length, 6);
});

test('typed pairing through the relay: a short code finds the host, and the relay never learns the pairing code', async () => {
  const r = await startRelay();
  const host = await startHost();
  await r.relay.admit(host.keys.publicKey);
  const h = hostClient(host, r.ws);
  const { code: short } = await h.client.code();
  const { code: typed } = host.shortCode({ role: 'view' });
  const url = await findHost(r.http, short.toLowerCase());
  assert.equal(url, `${r.ws}/link/v1/${host.id}`);
  const grant = await pairWithCode(url, typed, { name: 'Tablet', onWords: () => {} });
  assert.equal(grant.device.role, 'view');
  assert.deepEqual(await device(grant).link.request('get.x').catch((e) => e.code), 'view-only');
  assert.ok(!h.wire.join('\n').includes(typed.replace(/-/g, '')), 'the pairing code never crossed the relay in the clear');
  await assert.rejects(findHost(r.http, 'ZZZZZZ'), /wrong or has run out/);
  // Lookups are limited per address, as muxr limits pair-code lookups.
  let status = 0;
  for (let i = 0; i < LIMITS.code + 1 && status !== 429; i++) status = (await fetch(`${r.http}/relay/v1/codes/${short}`)).status;
  assert.equal(status, 429);
});

test('a dropped relay never answers the short-code lookup, so a bounded findHost fails within its bound and frees its socket', async () => {
  // A real relay on loopback first: the same call resolves through it.
  const r = await startRelay();
  const host = await startHost();
  await r.relay.admit(host.keys.publicKey);
  const h = hostClient(host, r.ws);
  const { code: short } = await h.client.code();
  assert.equal(await findHost(r.http, short), `${r.ws}/link/v1/${host.id}`);

  // The same relay class, but its HTTP routing stops answering: the connection opens and nothing comes back (a
  // dropped relay), which made pairing spin for the platform's own ~140 s before there was a bound.
  let dropped = false;
  let carried: Promise<void> | undefined;
  const relay = await Relay.open({ store: { load: () => undefined, save: () => {} } });
  const server = createServer((req, res) => {
    if (dropped) { carried = new Promise<void>((resolve) => req.socket.once('close', resolve)); return; } // never answers
    void relay.request(req, res).then((ours) => { if (!ours) res.writeHead(404).end(); }, () => res.writeHead(400).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const at = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    dropped = true;
    const started = Date.now();
    await assert.rejects(findHost(at, 'K7M2QX', { timeoutMs: 250 }),
      (e: unknown) => e instanceof RelayLookupError && e.code === 'timeout' && /didn't answer in time/.test(e.message));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 200, `waits out the bound before failing (${elapsed}ms)`);
    assert.ok(elapsed < 2000, `fails within the bound, not the platform default (${elapsed}ms)`);
    // The abort tears down the socket that carried the lookup. Wait on that socket's real close, not a poll:
    // Node <=22's fetch opens a second, idle keep-alive connection that lingers to the server's own timeout, so
    // counting every connection would flake; the request's own socket closes at once on every supported version.
    assert.ok(carried, 'the lookup opened a connection');
    const carriedSocket = carried;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the aborted lookup left the socket that carried it open')), 3000);
      carriedSocket.then(() => { clearTimeout(timer); resolve(); }, (e) => { clearTimeout(timer); reject(e); });
    });
  } finally {
    server.closeAllConnections();
    server.close();
    relay.close();
  }
  // The default is a single-digit number of seconds, not a magic value: link's own dial timeout is the same 8 s.
  assert.equal(RELAY_LOOKUP_MS, 8000);
});

test('malicious relay lookup cannot substitute a machine key, even knowing the pairing secret', async () => {
  const r = await startRelay();
  const host = await startHost();
  const { code } = host.shortCode({ role: 'control' });
  const impostor = await startHost();
  // An attacker who photographed the full code can answer XXpsk0 with its own static key.
  // Route real sockets through the relay, but respond with an unapproved Noise responder.
  let sentIdentity = false;
  impostor.relay = (ws) => {
    const attempts = new Map<string, Handshake>();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data));
      if (m.end !== undefined) return;
      if (attempts.has(m.c)) { sentIdentity = true; return; }
      const hs = new Handshake('code', false, impostor.keys, { psk: codeKey(parseCode(code)!.secret) });
      hs.read(firstFrame(m.f).body);
      attempts.set(m.c, hs);
      ws.send(JSON.stringify({ c: m.c, f: hs.write() }));
    });
  };
  await r.relay.admit(impostor.keys.publicKey);
  const attacker = hostClient(impostor, r.ws);
  await until(() => attacker.client.status === 'online');
  const url = await findHost(r.http, 'ABCDEF', { fetch: async (input) => {
    assert.ok(!String(input).includes(code), 'lookup never receives the pairing secret');
    return Response.json({ host: impostor.id });
  } });
  let shown = false;
  await assert.rejects(pairWithCode(url, code, { name: 'Umer’s phone', onWords: () => { shown = true; } }),
    (e: any) => e.code === 'wrong-host');
  assert.equal(shown, false, 'no words from the substituted key');
  assert.equal(sentIdentity, false, 'no device key/name sent to the impostor');
  assert.deepEqual(impostor.devices(), []);
  assert.deepEqual(host.devices(), []);
});

test('owner routes are not subject to an extra blanket HTTP limit', async () => {
  const r = await startRelay({ ownerToken: 'owner' });
  for (let i = 0; i < 301; i++) {
    const res = await fetch(`${r.http}/relay/v1/hosts`, { headers: { authorization: 'Bearer owner' } });
    assert.equal(res.status, 200);
    await res.arrayBuffer();
  }
});

test('a device for a host that is not online is closed, and sockets past the per-address limit are refused', async () => {
  const r = await startRelay();
  const nobody = new WebSocket(`${r.ws}/link/v1/${hostId(keyPair().publicKey)}`);
  assert.deepEqual(await closed(nobody), [1013, 'host offline']);
  const sockets = Array.from({ length: LIMITS.ws }, () => new WebSocket(`${r.ws}/link/v1/${hostId(keyPair().publicKey)}`));
  await Promise.all(sockets.map(closed));
  assert.equal((await closed(new WebSocket(`${r.ws}/relay/v1/host`)))[0], CLOSE.tooMany);
  assert.equal((await fetch(`${r.http}/elsewhere`)).status, 404, 'other paths are left to the embedding server');
});

test('custom tenant buckets share limits across addresses and undefined falls back to per-IP', async () => {
  const kinds: string[] = [];
  const r = await startRelay({ trustProxy: true, limitKey: ({ kind, request, host }) => {
    kinds.push(kind);
    assert.equal(host, undefined, 'unauthenticated lookup has no proven host');
    // Test-only trusted proxy mapping, supplied by the embedding app.
    return request.headers['x-tenant'] === 'same' ? 'tenant:same' : undefined;
  } });
  for (let i = 0; i < LIMITS.code; i++) {
    assert.equal((await fetch(`${r.http}/relay/v1/codes/ABCDEF`, { headers: { 'x-forwarded-for': `192.0.2.${i}`, 'x-tenant': 'same' } })).status, 404);
  }
  assert.equal((await fetch(`${r.http}/relay/v1/codes/ABCDEF`, { headers: { 'x-forwarded-for': '192.0.2.99', 'x-tenant': 'same' } })).status, 429);
  for (let i = 0; i < LIMITS.code; i++) {
    assert.equal((await fetch(`${r.http}/relay/v1/codes/ABCDEF`, { headers: { 'x-forwarded-for': '192.0.2.100' } })).status, 404);
  }
  assert.equal((await fetch(`${r.http}/relay/v1/codes/ABCDEF`, { headers: { 'x-forwarded-for': '192.0.2.100' } })).status, 429);
  assert.equal((await fetch(`${r.http}/relay/v1/codes/ABCDEF`, { headers: { 'x-forwarded-for': '192.0.2.101' } })).status, 404);
  assert.ok(kinds.every((k) => k === 'code'));
});

test('host bucket selection receives only a successfully proven registration key', async () => {
  const proven: string[] = [];
  const r = await startRelay({ signup: { open: true, maxHosts: 2 }, limitKey: ({ kind, host }) => {
    if (kind === 'enrol' && host) proven.push(host);
    return host;
  } });
  const h = await startHost();
  const c = hostClient(h, r.ws);
  await until(() => c.client.status === 'online');
  assert.deepEqual(proven, [h.id]);
});
