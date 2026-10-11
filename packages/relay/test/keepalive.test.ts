// RelayClient/Relay ping keepalive: a half-open host→relay socket (open but silent) is closed and reconnected,
// an answered one stays up, and a tick that fires late because the host's own timers froze resets the silence
// instead of closing (the same guard as link's `DeviceLink.ping`). The sockets here are fakes: the silence is a
// peer that never answers, which is what a half-open socket looks like from the inside.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyPair } from '@byokit/pair';
import { RelayClient, type RelayStatus } from '../src/index.ts';
import { challenge } from '../src/proof.ts';
import { grantStore, hostClient, onEnd, sleep, startHost, startRelay, until } from './helpers.ts';

class FakeSocket {
  static created: FakeSocket[] = [];
  url: string;
  readyState = 1;
  sent: string[] = [];
  closed = false;
  autoPong = false;
  private listeners = new Map<string, ((e: any) => void)[]>();
  constructor(url: string) {
    this.url = url;
    FakeSocket.created.push(this);
  }
  addEventListener(type: string, fn: (e: any) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(d: any) {
    this.sent.push(String(d));
    if (this.autoPong) {
      try { if (JSON.parse(String(d))?.t === 'ping') this.emit({ t: 'pong' }); } catch { /* not JSON */ }
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => this.emitClose());
  }
  emit(data: unknown) {
    for (const fn of this.listeners.get('message') ?? []) fn({ data: JSON.stringify(data) });
  }
  get pings() { return this.sent.filter((s) => { try { return JSON.parse(s)?.t === 'ping'; } catch { return false; } }); }
  private emitClose() {
    for (const fn of this.listeners.get('close') ?? []) fn({ code: 1006, reason: '' });
  }
}

async function onlineClient(pingMs: number, autoPong: boolean) {
  FakeSocket.created = [];
  const host = await startHost();
  const seen: RelayStatus[] = [];
  const client = new RelayClient(host, {
    url: 'ws://relay.test/relay/v1/host', WebSocket: FakeSocket as any, pingMs, onStatus: (s) => seen.push(s),
  });
  onEnd(() => client.stop());
  const sock = await until(() => FakeSocket.created[0]);
  sock.autoPong = autoPong;
  sock.emit(challenge().msg);
  await until(() => sock.sent.some((s) => s.includes('"hello"')));
  sock.emit({ t: 'ready', id: 'test-host', vapid: 'vapid-test' });
  await until(() => client.status === 'online');
  return { host, client, sock, seen };
}

test('a half-open socket is closed and the client reconnects', async () => {
  const { client, sock, seen } = await onlineClient(25, false);
  // The socket looks open but the relay never answers: pings go out, then the client drops it. (How many
  // pings go first depends on timer skew: a late first tick leaves less than two full rounds of silence.)
  await until(() => sock.closed, 5000);
  assert.ok(sock.pings.length >= 1, `a ping went out first (saw ${sock.pings.length})`);
  await until(() => client.status === 'offline');
  assert.ok(seen.includes('offline'));
  // The usual reconnect path runs: a new socket registers and the client is online again.
  const sock2 = await until(() => FakeSocket.created[1], 5000);
  sock2.autoPong = true;
  sock2.emit(challenge().msg);
  await until(() => sock2.sent.some((s) => s.includes('"hello"')));
  sock2.emit({ t: 'ready', id: 'test-host', vapid: 'vapid-test' });
  await until(() => client.status === 'online');
});

test('an answered socket stays up', async () => {
  const { client, sock } = await onlineClient(25, true);
  await sleep(200);
  assert.equal(client.status, 'online');
  assert.equal(sock.closed, false);
  assert.ok(sock.pings.length >= 2, `keepalive pings went out (saw ${sock.pings.length})`);
  assert.equal(FakeSocket.created.length, 1, 'no reconnect was needed');
});

test('the relay answers the host ping over a real socket', async () => {
  const r = await startRelay();
  const host = await startHost(keyPair(), grantStore());
  await r.relay.admit(host.keys.publicKey, 'Kitchen computer');
  const h = hostClient(host, r.ws, { pingMs: 25 });
  await until(() => h.client.status === 'online');
  const isPong = (w: string) => { try { return JSON.parse(w)?.t === 'pong'; } catch { return false; } };
  await until(() => h.wire.some(isPong));
  assert.ok(h.wire.some((w) => { try { return JSON.parse(w)?.t === 'ping'; } catch { return false; } }), 'the client pinged');
  assert.equal(h.client.status, 'online', 'answered pings keep the client up');
});

const every = 1000;

function rig() {
  let now = 1_000_000;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const ticks: (() => void)[] = [];
  Date.now = () => now;
  (globalThis as any).setTimeout = (fn: () => void) => { ticks.push(fn); return { unref() {} }; };
  const client: any = Object.create(RelayClient.prototype);
  const sent: unknown[] = [];
  let closed = 0;
  const ws = { send: (m: unknown) => { sent.push(m); }, close: () => { closed++; } };
  client.opts = { pingMs: every };
  client.ws = ws;
  client.heard = now;
  return {
    client, ws, sent, ticks,
    state: () => ({ closed }),
    setNow: (t: number) => { now = t; },
    run: (i: number) => ticks[i](),
    restore: () => { Date.now = realNow; (globalThis as any).setTimeout = realSetTimeout; },
  };
}

test('a tick that fires more than every/2 late resets heard and does not close', () => {
  const r = rig();
  try {
    r.client.heard = 1_000_000 - 3 * every; // silent long enough that an on-time tick would close
    r.client.ping(r.ws); // due = now + every
    assert.equal(r.ticks.length, 1);
    r.setNow(1_000_000 + every + every / 2 + 1); // the host's timers were frozen past the tick
    r.run(0);
    assert.deepEqual(r.state(), { closed: 0 }, 'frozen timers are not relay silence');
    assert.equal(r.client.heard, 1_000_000 + every + every / 2 + 1, 'the silence is counted from now');
    assert.equal(r.sent.length, 1, 'a ping still goes out');
    assert.equal(r.ticks.length, 2, 'the watch continues');
  } finally { r.restore(); }
});

test('a really silent relay still closes after 2*every of on-time ticks', () => {
  const r = rig();
  try {
    r.client.ping(r.ws); // due = now + every
    r.setNow(1_000_000 + every);
    r.run(0); // heard one round ago: alive
    assert.deepEqual(r.state(), { closed: 0 });
    r.setNow(1_000_000 + 2 * every);
    r.run(1); // exactly two silent rounds: still alive, the check is strict
    assert.deepEqual(r.state(), { closed: 0 });
    assert.equal(r.sent.length, 2);
    r.setNow(1_000_000 + 2 * every + 1);
    r.run(2); // past two silent rounds of on-time ticks: the socket is dead
    assert.deepEqual(r.state(), { closed: 1 });
    assert.equal(r.sent.length, 2, 'nothing goes out after the close');
    assert.equal(r.ticks.length, 3, 'the watch stops');
  } finally { r.restore(); }
});
