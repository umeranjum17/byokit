// Mock bridge, not the stock host: a loopback `ws` server shaped like the published bridge (token in the URL checked
// at upgrade, `{id, method, params}` in, `{id, result|error}` and `{event, params}` out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { authorizeBridge, bridgeSignaling, SignalingError, toSessionEvent, type SessionEvent, type WebSocketLike } from '../src/index.ts';

type Frame = { id?: unknown; method?: string; params?: Record<string, unknown> };

async function fakeBridge(answer: (frame: Frame, socket: WebSocket) => void = () => {}) {
  const server = createServer();
  const sockets: WebSocket[] = [];
  const frames: Frame[] = [];
  const wss = new WebSocketServer({
    server, path: '/desktop',
    verifyClient: (info: { req: { url?: string } }) => new URL(info.req.url ?? '/', 'http://x').searchParams.get('token') === 'secret',
  });
  wss.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => { const f = JSON.parse(String(raw)) as Frame; frames.push(f); answer(f, socket); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `ws://127.0.0.1:${port}/desktop?token=secret`, port, sockets, frames,
    broadcast: (line: unknown) => { for (const s of sockets) if (s.readyState === s.OPEN) s.send(JSON.stringify(line)); },
    connected: async (n: number) => { while (sockets.length < n) await new Promise((r) => setTimeout(r, 5)); },
    close: async () => { for (const s of wss.clients) s.terminate(); await new Promise((r) => wss.close(r)); await new Promise((r) => server.close(r)); },
  };
}

const echo = (f: Frame, s: WebSocket) => {
  if (f.method === 'refuse') s.send(JSON.stringify({ id: f.id, error: { code: 'consent-timeout', message: 'not approved' } }));
  else if (f.method !== 'hang') setTimeout(() => s.send(JSON.stringify({ id: f.id, result: { method: f.method, params: f.params } })), f.method === 'slow' ? 30 : 0);
};

test('concurrent requests resolve by id, out of order, and pass method and params through untouched', async () => {
  const bridge = await fakeBridge(echo);
  const signaling = bridgeSignaling(bridge.url);
  const [slow, fast] = await Promise.all([
    signaling.request('slow', { a: 1 }),
    signaling.request<{ method: string }>('session.open', { permissions: ['view'], max_width: 1280 }),
  ]);
  assert.deepEqual(slow, { method: 'slow', params: { a: 1 } });
  assert.deepEqual(fast, { method: 'session.open', params: { permissions: ['view'], max_width: 1280 } });
  await signaling.request('capabilities');
  assert.deepEqual(bridge.frames.map((f) => f.id), [1, 2, 3]);
  assert.equal('params' in bridge.frames[2], false, 'no params when none were given');
  signaling.close();
  await bridge.close();
});

test('a refusal rejects with the bridge code; unmatched and malformed frames are ignored', async () => {
  const bridge = await fakeBridge((f, s) => {
    s.send('not json');
    s.send(JSON.stringify({ error: { code: 'malformed', message: 'not JSON' } }));
    s.send(JSON.stringify({ id: 999, result: 'stray' }));
    s.send(JSON.stringify({ id: f.id })); // Not a response; must not consume this request.
    echo(f, s);
  });
  const signaling = bridgeSignaling(bridge.url);
  await assert.rejects(signaling.request('refuse'), (e: unknown) =>
    e instanceof SignalingError && e.name === 'SignalingError' && e.code === 'consent-timeout' && e.message === 'not approved');
  assert.deepEqual(await signaling.request('ok'), { method: 'ok' });
  signaling.close();
  await bridge.close();
});

test('events are unwrapped into session events; unsubscribe stops delivery', async () => {
  const bridge = await fakeBridge(echo);
  const signaling = bridgeSignaling(bridge.url);
  const seen: SessionEvent[] = [];
  const off = signaling.subscribe((e) => seen.push(e));
  await signaling.request('hello');
  bridge.broadcast({ event: 'session.description', params: { sessionId: 's', generation: 1, description: { type: 'offer', sdp: 'v=0' } } });
  bridge.broadcast({ event: 'session.candidate', params: { sessionId: 's', candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 } });
  bridge.broadcast({ event: 'session.state', params: { sessionId: 's', capture: 'streaming', transport: 'connected', firstFrame: true } });
  bridge.broadcast({ event: 'session.cursor', params: { sessionId: 's', x: 4, y: 3, visible: true, timestamp_us: 9 } });
  bridge.broadcast({ event: 'session.restoreToken', params: { sessionId: 's', token: 'mock-only' } });
  bridge.broadcast({ event: 'session.keyframeRequest', params: { sessionId: 's' } });
  bridge.broadcast({ event: 'session.revoked', params: { sessionId: 's', reason: 'lease ended', code: 'lease' } });
  await signaling.request('hello');
  off();
  bridge.broadcast({ event: 'session.state', params: { sessionId: 's', capture: 'ended', transport: 'closed', firstFrame: true } });
  await signaling.request('hello');
  assert.deepEqual(seen, [
    { kind: 'description', description: { type: 'offer', sdp: 'v=0' }, sessionId: 's' },
    { kind: 'candidate', candidate: { candidate: 'candidate:1', sdpMid: '0', sdpMLineIndex: 0 }, sessionId: 's' },
    { kind: 'state', capture: 'streaming', transport: 'connected', firstFrame: true, sessionId: 's' },
    { kind: 'cursor', sessionId: 's', x: 4, y: 3, visible: true, timestamp_us: 9 },
    { kind: 'restoreToken', token: 'mock-only', sessionId: 's' },
    { kind: 'revoked', reason: 'lease ended', code: 'lease', sessionId: 's' },
  ]);
  signaling.close();
  await bridge.close();
});

test('malformed event params are dropped', () => {
  assert.equal(toSessionEvent('session.description', { description: { type: 'offer' } }), null);
  assert.equal(toSessionEvent('session.candidate', { candidate: 5 }), null);
  assert.equal(toSessionEvent('session.cursor', { x: 1, y: 2, timestamp_us: 3 }), null);
  assert.equal(toSessionEvent('session.state', 'nope'), null);
  assert.equal(toSessionEvent('session.state', { capture: {}, transport: 'connected', firstFrame: true }), null);
  assert.equal(toSessionEvent('session.restoreToken', { token: 5 }), null);
  assert.deepEqual(toSessionEvent('session.candidate', { candidate: 'c' }), { kind: 'candidate', candidate: { candidate: 'c', sdpMid: null, sdpMLineIndex: null } });
});

test('close rejects pending requests with closed, drops subscribers and refuses later requests', async () => {
  const bridge = await fakeBridge(echo);
  const signaling = bridgeSignaling(bridge.url);
  const seen: SessionEvent[] = [];
  signaling.subscribe((e) => seen.push(e));
  await signaling.request('hello');
  const hanging = signaling.request('hang');
  signaling.close();
  await assert.rejects(hanging, { name: 'SignalingError', code: 'closed' });
  await assert.rejects(signaling.request('hello'), { code: 'closed' });
  assert.deepEqual(seen, [], 'no revoked event for the app closing its own signaling');
  await bridge.close();
});

test('the bridge closing rejects pending requests with transport and tells subscribers once', async () => {
  const bridge = await fakeBridge(echo);
  const signaling = bridgeSignaling(bridge.url);
  const seen: SessionEvent[] = [];
  signaling.subscribe((e) => seen.push(e));
  await signaling.request('hello');
  const hanging = signaling.request('hang');
  bridge.sockets[0].close();
  await assert.rejects(hanging, { code: 'transport' });
  await assert.rejects(signaling.request('hello'), { code: 'transport' });
  assert.deepEqual(seen, [{ kind: 'revoked', reason: 'the bridge connection closed', code: 'transport' }]);
  await bridge.close();
});

test('a refused token or unreachable bridge rejects with transport and keeps the token out of the message', async () => {
  const bridge = await fakeBridge(echo);
  const wrong = bridgeSignaling(bridge.url.replace('secret', 'wrong-token'));
  await assert.rejects(wrong.request('hello'), (e: unknown) =>
    e instanceof SignalingError && e.code === 'transport' && !e.message.includes('wrong-token') && e.message.includes('token=…'));
  await bridge.close();
  const gone = bridgeSignaling(bridge.url);
  await assert.rejects(gone.request('hello'), { code: 'transport' });
});

test('authorizeBridge opens a fresh socket on every call, including after a disconnect, and isolates stale ones', async () => {
  const bridge = await fakeBridge(echo);
  const session = { permissions: ['view', 'control'] };
  const authorize = authorizeBridge(bridge.url, session);
  const first = await authorize();
  assert.equal(first.session, session);
  const firstSeen: SessionEvent[] = [];
  first.signaling.subscribe((e) => firstSeen.push(e));
  await first.signaling.request('hello');

  const second = await authorize();
  assert.notEqual(second.signaling, first.signaling);
  await assert.rejects(first.signaling.request('hello'), { code: 'closed' });
  const secondSeen: SessionEvent[] = [];
  second.signaling.subscribe((e) => secondSeen.push(e));
  await second.signaling.request('hello');
  bridge.broadcast({ event: 'session.state', params: { sessionId: 'b', capture: 'streaming', transport: 'connected', firstFrame: false } });
  await second.signaling.request('hello');
  assert.deepEqual(firstSeen, [], 'the stale socket delivers nothing');
  assert.equal(secondSeen.length, 1);

  bridge.sockets[1].close();
  await assert.rejects(second.signaling.request('hang'), { code: 'transport' });
  const third = await authorize();
  await third.signaling.request('hello');
  await bridge.connected(3);
  assert.equal(bridge.sockets.length, 3, 'three authorizations, three sockets');
  authorize.close();
  await assert.rejects(third.signaling.request('hello'), { code: 'closed' });
  const fourth = await authorize();
  await fourth.signaling.request('hello');
  assert.equal(bridge.sockets.length, 4, 'authorization after explicit close also opens a fresh socket');
  authorize.close();
  await bridge.close();
});

// Controllable standard-WebSocket surface for races that a loopback server cannot schedule reliably.
class Socket implements WebSocketLike {
  static instances: Socket[] = [];
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  sent: string[] = [];
  closes = 0;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.closes++; }
  open() { this.readyState = 1; this.onopen?.({}); }
}

test('close before open rejects every waiter and removes callbacks; late callbacks cannot revive the socket', async () => {
  const signaling = bridgeSignaling('ws://fixture/desktop', { WebSocket: Socket });
  const socket = Socket.instances.at(-1)!;
  const lateOpen = socket.onopen!;
  const a = signaling.request('a');
  const b = signaling.request('b');
  signaling.close();
  lateOpen({});
  await assert.rejects(a, { code: 'closed' });
  await assert.rejects(b, { code: 'closed' });
  await assert.rejects(signaling.request('c'), { code: 'closed' });
  assert.equal(socket.closes, 1);
  assert.deepEqual([socket.onopen, socket.onmessage, socket.onerror, socket.onclose], [null, null, null, null]);
  assert.deepEqual(socket.sent, []);
});

test('error terminates an open socket, rejects all pending ids, cleans listeners and ignores queued stale events', async () => {
  const authorize = authorizeBridge('ws://fixture/desktop', {}, { WebSocket: Socket });
  const first = await authorize();
  const socket = Socket.instances.at(-1)!;
  socket.open();
  const seen: SessionEvent[] = [];
  first.signaling.subscribe(e => seen.push(e));
  const a = first.signaling.request('a');
  const b = first.signaling.request('b');
  await Promise.resolve();
  const lateMessage = socket.onmessage!;
  const lateClose = socket.onclose!;
  socket.onerror?.({});
  await assert.rejects(a, { code: 'transport' });
  await assert.rejects(b, { code: 'transport' });
  lateClose({});
  assert.equal(socket.closes, 1);
  assert.deepEqual([socket.onopen, socket.onmessage, socket.onerror, socket.onclose], [null, null, null, null]);
  const next = await authorize();
  const fresh = Socket.instances.at(-1)!;
  fresh.open();
  const nextSeen: SessionEvent[] = [];
  next.signaling.subscribe(e => nextSeen.push(e));
  lateMessage({ data: JSON.stringify({ event: 'session.revoked', params: { reason: 'old' } }) });
  assert.equal(seen.length, 1);
  assert.deepEqual(nextSeen, []);
  authorize.close();
});

test('send failure rejects its request without consuming another pending id', async () => {
  const signaling = bridgeSignaling('ws://fixture/desktop', { WebSocket: Socket });
  const socket = Socket.instances.at(-1)!;
  socket.open();
  const first = signaling.request('first');
  await Promise.resolve();
  socket.send = () => { throw new Error('send failed'); };
  await assert.rejects(signaling.request('second'), { code: 'transport' });
  socket.onmessage?.({ data: JSON.stringify({ id: 1, result: { nested: [1, null, { extra: true }] } }) });
  assert.deepEqual(await first, { nested: [1, null, { extra: true }] });
  signaling.close();
});

test('construction failure is transport without leaking the token from a native error', () => {
  class Refused extends Socket { constructor(url: string) { super(url); throw new Error(url); } }
  assert.throws(() => bridgeSignaling('ws://fixture?token=secret', { WebSocket: Refused }),
    (e: unknown) => e instanceof SignalingError && e.code === 'transport' && !e.message.includes('secret') && e.cause === undefined);
});

test('a call without a URL or WebSocket is a programming mistake', () => {
  assert.throws(() => bridgeSignaling(''), TypeError);
  const saved = globalThis.WebSocket;
  try {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    assert.throws(() => bridgeSignaling('ws://127.0.0.1:1/desktop'), TypeError);
  } finally {
    globalThis.WebSocket = saved;
  }
});
