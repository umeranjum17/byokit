// Revoking a device must remove its push addresses from the relay even when the unsubscribe is lost on the way: the
// relay stops or restarts, the offline queue overflows, or the host restarts before the relay is back. The client keeps
// the unsubscribe in its store and resends it until the relay confirms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RelayClient, type RelayClientStore, type RelayState } from '../src/index.ts';
import { hostClient, paired, startHost, startRelay, until } from './helpers.ts';

const phone = { expo: 'ExponentPushToken[phone]' };
const pushOf = (s: RelayState | undefined, device: string) => (s?.push ?? []).filter((p) => p.device === device);
const removes = (wire: string[]) => wire.filter((w) => JSON.parse(w).t === 'push.remove');
const durable = () => ({ d: undefined as string[] | undefined, load() { return this.d; }, save(d: string[]) { this.d = d; } }) satisfies RelayClientStore;

/** A relay with a subscribed paired device, stopped; `restart` brings it back on the same port with its state. */
async function subscribedThenStopped(o: Parameters<typeof paired>[2] = {}) {
  const first = await startRelay();
  const p = await paired(first, 'Away phone', o);
  await p.client.subscribe(p.grant.device.id, phone);
  const port = Number(new URL(first.http).port);
  const restart = (state = first.saved()) => startRelay({ store: { load: () => state, save: (s) => { saved = s; } } }, port);
  let saved: RelayState | undefined;
  first.stop();
  await until(() => p.client.status === 'offline');
  return { ...p, first, restart, saved: () => saved };
}

test('the relay stops while an unsubscribe is in flight: it is sent again to the restarted relay, which removes it', async () => {
  let hold = false;
  let saved: RelayState | undefined;
  const r = await startRelay({ store: { load: () => saved, save: (s) => hold ? new Promise(() => {}) : void (saved = s) } });
  const p = await paired(r);
  await p.client.subscribe(p.grant.device.id, phone);
  hold = true; // the relay takes the remove and never answers it
  const revoked = p.client.revoke(p.grant.device.id);
  await until(() => removes(p.wire).length === 1);
  const state = saved;
  r.stop();
  await until(() => p.client.status === 'offline');
  assert.deepEqual(await p.client.pending(), [p.grant.device.id]);
  let after: RelayState | undefined;
  await startRelay({ store: { load: () => state, save: (s) => { after = s; } } }, Number(new URL(r.http).port));
  await revoked;
  assert.equal(removes(p.wire).length, 2);
  assert.deepEqual(pushOf(after, p.grant.device.id), []);
  assert.deepEqual(await p.client.pending(), []);
});

test('an unsubscribe queued while the relay is down survives a full queue, and goes once it is back', async () => {
  const p = await subscribedThenStopped();
  const revoked = p.client.revoke(p.grant.device.id);
  await until(async () => (await p.client.pending()).length === 1);
  const flood = Array.from({ length: 70 }, () => p.client.code().then(() => 'ok', (e: Error) => e.message));
  await p.restart();
  await revoked;
  assert.equal((await Promise.all(flood)).filter((v) => v === 'relay queue full').length, 6, 'the queue did overflow');
  assert.deepEqual(pushOf(p.saved(), p.grant.device.id), []);
});

test('the host restarts while the relay is down: the saved unsubscribe is sent by the next client', async () => {
  const store = durable();
  const revokedSeen: string[] = [];
  const p = await subscribedThenStopped({ store });
  const revoked = p.client.revoke(p.grant.device.id);
  await until(() => store.d?.length === 1);
  assert.deepEqual(store.d, [p.grant.device.id]);
  assert.equal(p.host.devices().length, 0, 'the grant is gone');
  p.client.stop();
  await assert.rejects(revoked, /relay client stopped/);
  const r = await p.restart();
  const next = hostClient(p.host, r.ws, { store, onRevoked: (d) => revokedSeen.push(d) });
  await until(() => revokedSeen.length === 1);
  assert.deepEqual(revokedSeen, [p.grant.device.id]);
  assert.deepEqual(pushOf(p.saved(), p.grant.device.id), []);
  await until(() => store.d?.length === 0);
  assert.deepEqual(await next.client.pending(), []);
});

test('a relay that fails the unsubscribe is retried with backoff until it confirms', async () => {
  let fails = 0;
  let saved: RelayState | undefined;
  const r = await startRelay({ store: { load: () => saved, save: (s) => {
    if (fails > 0 && saved?.push.length !== s.push.length) { fails--; throw new Error('disk failed'); }
    saved = s;
  } } });
  const p = await paired(r);
  await p.client.subscribe(p.grant.device.id, phone);
  fails = 2;
  await p.client.revoke(p.grant.device.id);
  assert.equal(removes(p.wire).length, 3);
  assert.deepEqual(p.wire.filter((w) => /disk failed/.test(w)).length, 2);
  assert.deepEqual(pushOf(saved, p.grant.device.id), []);
});

test('a relay that no longer has the host proves its addresses gone: the revoke completes without an answer', async () => {
  const seen: string[] = [];
  const p = await subscribedThenStopped({ onRevoked: (d) => seen.push(d) });
  const revoked = p.client.revoke(p.grant.device.id);
  const r = await p.restart();
  await r.relay.revoke(p.host.id); // the owner removed the host meanwhile, and its push addresses with it
  await revoked;
  assert.equal(p.client.status, 'refused');
  assert.deepEqual(seen, [p.grant.device.id]);
  assert.deepEqual(await p.client.pending(), []);
});

/** A socket to a scripted relay: `answer` gets each request and returns the frames to send back. */
function scripted(answer: (m: any) => object[]) {
  const sent: any[] = [];
  class Fake extends EventTarget {
    static last: Fake;
    readyState = 1;
    send(d: string) {
      const m = JSON.parse(d);
      sent.push(m);
      queueMicrotask(() => { for (const f of answer(m)) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(f) })); });
    }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
    constructor(_url: string) {
      super();
      Fake.last = this;
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ t: 'ready', id: 'host', vapid: 'key' }) })));
    }
  }
  return { Fake, sent };
}

test('an unknown-address answer ends the retry: the relay holds nothing for that device', async () => {
  for (const error of ['host revoked', 'bad device']) {
    const { Fake, sent } = scripted((m) => [{ t: 'res', id: m.id, ok: false, error }]);
    const client = new RelayClient(await startHost(), { url: 'ws://unused', WebSocket: Fake as any });
    await client.revoke('gone-device');
    assert.equal(sent.filter((m) => m.t === 'push.remove').length, 1, error);
    assert.deepEqual(await client.pending(), []);
    client.stop();
  }
});

test('duplicate answers and a double revoke complete once, and the device cannot subscribe again while pending', async () => {
  let answer = false;
  const { Fake, sent } = scripted((m) => m.t === 'push.remove' && answer ? [{ t: 'res', id: m.id, ok: true }, { t: 'res', id: m.id, ok: true }] : []);
  const seen: string[] = [];
  const client = new RelayClient(await startHost(), { url: 'ws://unused', WebSocket: Fake as any, onRevoked: (d) => seen.push(d) });
  await until(() => client.status === 'online');
  const one = client.revoke('phone');
  const two = client.revoke('phone');
  await until(() => sent.some((m) => m.t === 'push.remove'));
  await assert.rejects(client.subscribe('phone', phone), /device revoked/);
  Fake.last.close(1006); // unanswered: it goes again on the next socket
  answer = true;
  await Promise.all([one, two]);
  assert.equal(sent.filter((m) => m.t === 'push.remove').length, 2);
  assert.deepEqual(seen, ['phone'], 'confirmed once despite the duplicate answer');
  assert.deepEqual(await client.pending(), []);
  await client.revoke('phone'); // again, after it is gone: the relay's remove is idempotent
  assert.deepEqual(seen, ['phone', 'phone']);
  client.stop();
});

test('a store that cannot save the unsubscribe fails the revoke before the grant is dropped', async () => {
  const p = await paired(await startRelay(), 'Away phone', { store: { load: () => [], save: () => { throw new Error('disk full'); } } });
  await assert.rejects(p.client.revoke(p.grant.device.id), /disk full/);
  assert.equal(p.host.devices().length, 1, 'the device keeps its grant, so nothing is half-removed');
});
