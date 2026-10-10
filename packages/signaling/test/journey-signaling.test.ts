// Consumer journeys for the published @byokit/signaling surface, driven the way an app drives it: `bridgeSignaling`
// opens one socket to a bridge and correlates `{id, method, params}` requests with `{id, result|error}` replies
// while `subscribe` delivers the typed `SessionEvent` stream, and `authorizeBridge` hands a session client a fresh
// socket on every authorization. Every import is the published entry (`@byokit/signaling`) — no src or internals.
// The security and correctness contracts the old unit/mock-heavy cases held survive as assertions inside a
// journey: id-correlated out-of-order results and untouched method/params, the bridge's own error codes passed
// through with malformed and stray frames ignored, the complete typed event union with unknown events dropped,
// token redaction on a refused or unreachable bridge, one synthetic `revoked` when a socket is lost, explicit close
// rejecting `closed` with no revocation, a fresh socket per authorization that never leaks a stale one, a transport
// that cannot open, error or send never corrupting another request, and a portable entry that bundles for browsers
// and React Native with no Node imports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { build } from 'esbuild';
import { WebSocketServer, type WebSocket as BridgeSocket } from 'ws';
import {
  authorizeBridge, bridgeSignaling, SignalingError, toSessionEvent,
  type BridgeSignalingOptions, type SessionEvent, type WebSocketLike,
} from '@byokit/signaling';

type Frame = { id?: unknown; method?: string; params?: Record<string, unknown> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A loopback bridge shaped like the stock host: `?token=` checked at upgrade, `{id,method,params}` in,
 * `{id,result|error}` and `{event,params}` out. The only stand-in, because the stock bridge is another product. */
async function fakeBridge(answer: (frame: Frame, socket: BridgeSocket) => void = () => {}) {
  const server = createServer();
  const sockets: BridgeSocket[] = [];
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
    connected: async (n: number) => { while (sockets.length < n) await sleep(5); },
    close: async () => { for (const s of wss.clients) s.terminate(); await new Promise((r) => wss.close(r)); await new Promise((r) => server.close(r)); },
  };
}

const echo = (f: Frame, s: BridgeSocket) => {
  if (f.method === 'refuse') s.send(JSON.stringify({ id: f.id, error: { code: 'consent-timeout', message: 'not approved' } }));
  else if (f.method !== 'hang') setTimeout(() => s.send(JSON.stringify({ id: f.id, result: { method: f.method, params: f.params } })), f.method === 'slow' ? 30 : 0);
};

test("a session client correlates concurrent requests over one bridge socket and reads refusals the bridge's own way", async () => {
  const bridge = await fakeBridge((f, s) => {
    // Junk that must never resolve a request: not JSON, an id-less error, a stray id, and a matching id with
    // neither a result nor an error.
    s.send('not json');
    s.send(JSON.stringify({ error: { code: 'malformed', message: 'not JSON' } }));
    s.send(JSON.stringify({ id: 999, result: 'stray' }));
    s.send(JSON.stringify({ id: f.id }));
    echo(f, s);
  });
  const signaling = bridgeSignaling(bridge.url);
  const [slow, fast] = await Promise.all([
    signaling.request('slow', { a: 1 }),
    signaling.request<{ method: string }>('session.open', { permissions: ['view'], max_width: 1280 }),
  ]);
  // Results come back by id, not arrival order, with method, params and result fields untouched.
  assert.deepEqual(slow, { method: 'slow', params: { a: 1 } });
  assert.deepEqual(fast, { method: 'session.open', params: { permissions: ['view'], max_width: 1280 } });
  await signaling.request('capabilities');
  assert.deepEqual(bridge.frames.map((f) => f.id), [1, 2, 3]);
  assert.equal('params' in bridge.frames[2], false, 'no params key when none were given');
  // A refusal rejects with the bridge's own code and message, not a generic one.
  await assert.rejects(signaling.request('refuse'), (e: unknown) =>
    e instanceof SignalingError && e.name === 'SignalingError' && e.code === 'consent-timeout' && e.message === 'not approved');
  // The junk above consumed nothing: the next request still resolves.
  assert.deepEqual(await signaling.request('after-junk'), { method: 'after-junk' });
  signaling.close();
  await bridge.close();
});

test('the receiver reads the complete typed event stream, drops unknown or malformed frames and stops on unsubscribe', async () => {
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
  bridge.broadcast({ event: 'session.revoked', params: { sessionId: 's', reason: 'lease ended', code: 'lease' } });
  // An event with no member in the union is ignored, and so is a malformed one.
  bridge.broadcast({ event: 'session.keyframeRequest', params: { sessionId: 's' } });
  bridge.broadcast({ event: 'session.state', params: 'nope' });
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
  // The same mapping is exported for apps on another authenticated transport, and refuses junk the same way.
  assert.equal(toSessionEvent('session.description', { description: { type: 'offer' } }), null);
  assert.equal(toSessionEvent('session.candidate', { candidate: 5 }), null);
  assert.equal(toSessionEvent('session.cursor', { x: 1, y: 2, timestamp_us: 3 }), null);
  assert.equal(toSessionEvent('session.state', 'nope'), null);
  assert.equal(toSessionEvent('session.state', { capture: {}, transport: 'connected', firstFrame: true }), null);
  assert.equal(toSessionEvent('session.restoreToken', { token: 5 }), null);
  assert.deepEqual(toSessionEvent('session.candidate', { candidate: 'c' }), { kind: 'candidate', candidate: { candidate: 'c', sdpMid: null, sdpMLineIndex: null } });
  signaling.close();
  await bridge.close();
});

test('a refused token, an unreachable bridge or a lost socket reject transport, redact the token and tell subscribers once', async () => {
  // A token the bridge's upgrade check refuses is indistinguishable from an unreachable bridge through the
  // portable WebSocket API, and neither leaks the token into the message.
  const bridge = await fakeBridge(echo);
  const refused = bridgeSignaling(bridge.url.replace('secret', 'wrong-token'));
  await assert.rejects(refused.request('hello'), (e: unknown) =>
    e instanceof SignalingError && e.code === 'transport' && !e.message.includes('wrong-token') && e.message.includes('token=…'));
  await bridge.close();
  const unreachable = bridgeSignaling('ws://127.0.0.1:1/desktop');
  await assert.rejects(unreachable.request('hello'), { code: 'transport' });

  // A socket the bridge closes rejects pending and later requests with transport, delivers exactly one synthetic
  // revoked with code transport, and nothing else.
  const host = await fakeBridge(echo);
  const signaling = bridgeSignaling(host.url);
  const seen: SessionEvent[] = [];
  signaling.subscribe((e) => seen.push(e));
  await signaling.request('hello');
  const hanging = signaling.request('hang');
  host.sockets[0].close();
  await assert.rejects(hanging, { code: 'transport' });
  await assert.rejects(signaling.request('hello'), { code: 'transport' });
  assert.deepEqual(seen, [{ kind: 'revoked', reason: 'the bridge connection closed', code: 'transport' }]);
  await host.close();
});

// A controllable standard-WebSocket surface for the races a loopback server cannot schedule: it opens, errors and
// sends only when told to. Injected through the documented `options.WebSocket`, so it still drives the published entry.
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

test('authorization opens a fresh socket every call, isolates a stale transport and never corrupts another request', async () => {
  // authorizeBridge hands out a new socket on every call, including after a disconnect and after close(), and the
  // previous one is gone: no event leaks from it and its requests reject closed.
  const bridge = await fakeBridge(echo);
  const session = { permissions: ['view', 'control'] };
  const authorize = authorizeBridge(bridge.url, session);
  const first = await authorize();
  assert.equal(first.session, session, 'the session object passes through unchanged');
  const firstSeen: SessionEvent[] = [];
  first.signaling.subscribe((e) => firstSeen.push(e));
  await first.signaling.request('hello');
  const second = await authorize();
  await assert.rejects(first.signaling.request('hello'), { code: 'closed' }, 'the previous socket is closed');
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
  assert.equal(bridge.sockets.length, 4, 'authorization after close() opens a fresh socket too');
  authorize.close();
  await bridge.close();

  // A socket closed before it opens rejects every waiter with closed, sends nothing, and a late open cannot revive it.
  Socket.instances = [];
  const early = bridgeSignaling('ws://fixture/desktop', { WebSocket: Socket });
  const earlySocket = Socket.instances.at(-1)!;
  const lateOpen = earlySocket.onopen!;
  const a = early.request('a'), b = early.request('b');
  early.close();
  lateOpen({});
  await assert.rejects(a, { code: 'closed' });
  await assert.rejects(b, { code: 'closed' });
  await assert.rejects(early.request('c'), { code: 'closed' });
  assert.equal(earlySocket.closes, 1);
  assert.deepEqual(earlySocket.sent, []);

  // A transport error after open rejects every pending request with transport and tells subscribers once; a new
  // authorization opens a fresh socket that a late frame from the old one cannot reach.
  Socket.instances = [];
  const reconnect = authorizeBridge('ws://fixture/desktop', {}, { WebSocket: Socket });
  const openOne = await reconnect();
  const openSocket = Socket.instances.at(-1)!;
  openSocket.open();
  const lost: SessionEvent[] = [];
  openOne.signaling.subscribe((e) => lost.push(e));
  const x = openOne.signaling.request('x'), y = openOne.signaling.request('y');
  await Promise.resolve();
  const lateMessage = openSocket.onmessage!;
  openSocket.onerror?.({});
  await assert.rejects(x, { code: 'transport' });
  await assert.rejects(y, { code: 'transport' });
  assert.deepEqual(lost, [{ kind: 'revoked', reason: 'the bridge connection closed', code: 'transport' }]);
  const fresh = await reconnect();
  const freshSocket = Socket.instances.at(-1)!;
  freshSocket.open();
  const freshSeen: SessionEvent[] = [];
  fresh.signaling.subscribe((e) => freshSeen.push(e));
  lateMessage({ data: JSON.stringify({ event: 'session.revoked', params: { reason: 'old' } }) });
  assert.deepEqual(freshSeen, []);
  reconnect.close();

  // A send that throws rejects only its own request with transport and leaves another pending request to resolve by id.
  Socket.instances = [];
  const sending = bridgeSignaling('ws://fixture/desktop', { WebSocket: Socket });
  const sendSocket = Socket.instances.at(-1)!;
  sendSocket.open();
  const pending = sending.request('first');
  await Promise.resolve();
  sendSocket.send = () => { throw new Error('send failed'); };
  await assert.rejects(sending.request('second'), { code: 'transport' });
  sendSocket.onmessage?.({ data: JSON.stringify({ id: 1, result: { nested: [1, null, { extra: true }] } }) });
  assert.deepEqual(await pending, { nested: [1, null, { extra: true }] });
  sending.close();
});

test('the published entry stays portable and refuses a call it cannot make before it dials', async () => {
  // The built entry bundles for browsers and React Native with no Node code, and a native WebSocket is injectable
  // through the typed options without a cast.
  const nativeOptions: BridgeSignalingOptions = { WebSocket };
  void nativeOptions;
  const bundle = await build({
    stdin: {
      contents: `import { bridgeSignaling, authorizeBridge, toSessionEvent } from '@byokit/signaling';
        globalThis.probe = () => [bridgeSignaling, authorizeBridge, toSessionEvent].length;`,
      resolveDir: import.meta.dirname, sourcefile: 'phone-signaling.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, metafile: true, logLevel: 'silent',
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.ok(inputs.some((path) => /signaling\/dist\/index\.js$/.test(path)), 'the bundle uses the built entry');
  assert.deepEqual(inputs.filter((path) => /node:/.test(path)), [], 'nothing from Node');
  assert.doesNotMatch(bundle.outputFiles[0].text, /\bfrom ["']node:|require\(["']node:/);

  // A constructor that cannot dial is a synchronous transport error that never echoes the token or keeps a cause.
  class Refused extends Socket { constructor(url: string) { super(url); throw new Error(url); } }
  assert.throws(() => bridgeSignaling('ws://fixture?token=secret', { WebSocket: Refused }),
    (e: unknown) => e instanceof SignalingError && e.code === 'transport' && !e.message.includes('secret') && e.cause === undefined);
  // An empty URL or a missing global WebSocket is a programming mistake, not a transport failure.
  assert.throws(() => bridgeSignaling(''), TypeError);
  const saved = globalThis.WebSocket;
  try {
    (globalThis as { WebSocket?: unknown }).WebSocket = undefined;
    assert.throws(() => bridgeSignaling('ws://127.0.0.1:1/desktop'), TypeError);
  } finally { globalThis.WebSocket = saved; }
});
