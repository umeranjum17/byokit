// Routing @byokit/link through the relay end to end: blind frames, a host replaced by a newer copy of itself, a
// reconnect that sends the queued requests, typed pairing through a short code, and the per-address limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostId, keyPair, pairWithCode } from '@byokit/link';
import { CLOSE, LIMITS, RelayClient, findHost } from '../src/index.ts';
import { closed, device, hostClient, paired, sleep, startHost, startRelay, until } from './helpers.ts';

test('a device reaches its host through the relay, which routes by host address and never sees plaintext', async () => {
  const r = await startRelay();
  const p = await paired(r);
  assert.equal(p.client.id, hostId(p.host.keys.publicKey));
  assert.deepEqual(await p.dev.link.request('send.secret', { text: 'plaintext-marker' }), { op: 'send.secret', args: { text: 'plaintext-marker' }, by: p.grant.device.id });
  assert.equal(r.relay.count(p.host.id), 1);
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
  const { code: typed } = host.code({ role: 'view' });
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
