// Streams end to end over real WebSockets: what muxr runs beside its requests (report row T4). A terminal pane's
// keystrokes and output, a bulk transfer (a preview tunnel's connection, a voice call's audio) held to the reader's
// pace, one controller per pane decided by the app from the authenticated grant, and streams ending with their socket.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { DeviceLink, Host, LinkError, PublicLinkError, WINDOW, b64url, keyPair, type HostOptions, type LinkStream, type Role } from '../src/index.ts';
import { Streams } from '../src/stream.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) { const v = fn(); if (v) return v; }
  throw new Error('timed out');
}
const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

async function startHost(o: Partial<HostOptions> = {}) {
  const errors: unknown[] = [];
  const host = await Host.open({ keys: keyPair(), name: 'Kitchen computer', confirm: () => true, handle: (r) => r.op, canView: (r) => r.op === 'watch', onError: (e) => errors.push(e), ...o });
  const sockets: WsSocket[] = [];
  const kinds = { in: new Set<string>(), out: new Set<string>() }; // what went over the host's direct sockets
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (_d, isBinary) => kinds.in.add(isBinary ? 'binary' : 'text'));
    const send = ws.send.bind(ws);
    ws.send = ((d: any, ...rest: any[]) => { kinds.out.add(typeof d === 'string' ? 'text' : 'binary'); return send(d, ...rest); }) as any;
    host.accept(ws);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  closers.push(() => { host.close(); wss.close(); server.close(); });
  return { host, url, sockets, kinds, errors };
}

/** A device the host enrolled, online. */
async function device(h: { host: Host; url: string }, name: string, role: Role = 'control', url = h.url) {
  const keys = keyPair();
  const g = await h.host.enrol({ key: keys.publicKey, name, role });
  const link = new DeviceLink({ v: 1, secretKey: b64url(keys.secretKey), host: b64url(h.host.keys.publicKey), hostName: '', urls: [url], device: { id: g.id, name, role } });
  closers.push(() => link.stop());
  await until(() => link.status === 'online');
  return { link, id: g.id };
}

const collect = (s: LinkStream) => {
  const got = { bytes: [] as Uint8Array[], end: undefined as string | undefined, ended: false };
  s.onData = (c) => { got.bytes.push(new Uint8Array(c)); };
  s.onEnd = (e) => { got.end = e; got.ended = true; };
  return { got, text: () => Buffer.concat(got.bytes).toString('latin1') };
};

test('T4: a terminal-like interactive stream: keystrokes in, output back, both ways at once and in order', async () => {
  const h = await startHost({
    stream: (s, req) => {
      assert.deepEqual([req.op, req.args], ['terminal', { pane: 'p1' }]);
      void s.write('\x1b[2J$ '); // the screen, sent before the device has even got its stream
      s.onData = (c) => s.write(c.map((b) => (b >= 97 && b <= 122 ? b - 32 : b))); // a shell that echoes, shouting
    },
  });
  const d = await device(h, 'Phone');
  const s = await d.link.stream('terminal', { pane: 'p1' });
  const out = collect(s);
  for (const ch of 'ls -la\r') void s.write(ch); // one keystroke per write, none awaited
  await until(() => out.text() === '\x1b[2J$ LS -LA\r');
  await s.write(Uint8Array.from([0x1b, 0xff, 0x00, 0x7f])); // raw bytes, not text
  await until(() => out.text().endsWith('\x1b\xff\x00\x7f'));
  s.end();
  await until(() => out.got.ended);
  assert.equal(out.got.end, undefined, 'a clean end');
  await assert.rejects(s.write('x'), /ended/);
});

test('T4: bulk transfer under backpressure: a stalled reader holds the writer to the window; every byte arrives, both ways at once', async () => {
  const down = Buffer.from(Array.from({ length: 3 << 20 }, (_, i) => (i * 131 + (i >> 9)) & 255));
  const up = down.subarray(0, 1 << 20);
  let sent = 0;
  let hostGot = Buffer.alloc(0), hostEnded = false;
  const h = await startHost({
    stream: (s) => {
      s.onData = async (c) => { hostGot = Buffer.concat([hostGot, c]); await sleep(1); }; // a slowish reader too
      s.onEnd = () => { hostEnded = true; };
      void (async () => {
        for (let at = 0; at < down.length; at += 100_000) { await s.write(down.subarray(at, at + 100_000)); sent = Math.min(at + 100_000, down.length); }
        s.end();
      })();
    },
  });
  const d = await device(h, 'Phone');
  const s = await d.link.stream('preview', { port: 5173 });
  let release!: () => void;
  const stalled = new Promise<void>((r) => { release = r; });
  const chunks: Buffer[] = [];
  let ended = false, end: string | undefined = 'unset';
  s.onData = async (c) => { chunks.push(Buffer.from(c)); if (chunks.length === 1) await stalled; };
  s.onEnd = (e) => { ended = true; end = e; };
  const uploading = (async () => { for (let at = 0; at < up.length; at += 50_000) await s.write(up.subarray(at, at + 50_000)); })();

  await sleep(300);
  assert.ok(sent > 0 && sent <= WINDOW, `the host has sent ${sent} bytes into a ${WINDOW}-byte window and waits`);
  const held = sent;
  await sleep(200);
  assert.equal(sent, held, 'and stays held while the reader is stalled');
  release();
  await until(() => ended, 20_000);
  assert.equal(end, undefined);
  const got = Buffer.concat(chunks);
  assert.equal(got.length, down.length);
  assert.equal(createHash('sha256').update(got).digest('hex'), createHash('sha256').update(down).digest('hex'), 'in order, byte for byte');
  await uploading.catch(() => {}); // the host ended the stream when it finished sending; the upload may be cut short
  assert.ok(up.subarray(0, hostGot.length).equals(hostGot), 'what the host read of the upload is intact');
  assert.ok(hostGot.length >= WINDOW, 'the upload moved while the download was held');
  assert.ok(hostEnded);
});

test('T4: the stream handler gets the authenticated grant, so the app keeps one controller per pane; view-only devices only watch', async () => {
  const controller = new Map<string, string>(); // pane -> device id
  const h = await startHost({
    stream: (s, req, dev) => {
      const pane = (req.args as { pane: string }).pane;
      if (req.op === 'watch') return void s.write(`watching ${pane}`);
      if (controller.has(pane) && controller.get(pane) !== dev.id) throw new PublicLinkError('Someone else is typing in this pane.');
      controller.set(pane, dev.id);
      s.onEnd = () => { if (controller.get(pane) === dev.id) controller.delete(pane); };
      void s.write(`${dev.name} controls ${pane}`);
    },
  });
  const a = await device(h, 'Phone A'), b = await device(h, 'Phone B'), v = await device(h, 'Browser', 'view');
  const sa = await a.link.stream('terminal', { pane: 'p1' });
  const oa = collect(sa);
  await until(() => oa.text() === 'Phone A controls p1');
  const blocked = collect(await b.link.stream('terminal', { pane: 'p1' }));
  await until(() => blocked.got.ended);
  assert.equal(blocked.got.end, 'Someone else is typing in this pane.');
  await assert.rejects(v.link.stream('terminal', { pane: 'p2' }), (e: LinkError) => e.code === 'view-only' && e.sealed, 'refused before the app sees it');
  const ov = collect(await v.link.stream('watch', { pane: 'p1' }));
  await until(() => ov.text() === 'watching p1');
  sa.end();
  await until(() => !controller.has('p1'));
  const ob = collect(await b.link.stream('terminal', { pane: 'p1' }));
  await until(() => ob.text() === 'Phone B controls p1');
});

test('T4: an async stream handler can await its first write, then end with a public or generic error', async () => {
  const h = await startHost({ stream: async (s, req) => {
    if (req.op === 'public') throw new PublicLinkError('No such pane.');
    if (req.op === 'bug') throw new Error('secret path /home/x');
    await s.write('welcome');
  } });
  const d = await device(h, 'Phone');
  const welcome = collect(await d.link.stream('welcome'));
  await until(() => welcome.text() === 'welcome');
  for (const [op, reason] of [['public', 'No such pane.'], ['bug', 'failed']]) {
    const s = collect(await d.link.stream(op));
    await until(() => s.got.ended);
    assert.equal(s.got.end, reason);
  }
  assert.match(String(h.errors.at(-1)), /secret path/);
});

test('T4: output-only streams release on peer end and host shutdown', async () => {
  const ended: string[] = [];
  const h = await startHost({ stream: (s, req) => {
    if (req.op === 'reply') {
      void s.write('output').then(() => s.end());
      return;
    }
    s.onEnd = (error) => { ended.push(`${req.op}:${error ?? 'clean'}`); };
  } });
  const d = await device(h, 'Phone');
  const input = await d.link.stream('input');
  await input.write('unread');
  input.end();
  await until(() => ended.includes('input:clean'));

  const reply = await d.link.stream('reply');
  let replyEnded = false;
  reply.onEnd = () => { replyEnded = true; };
  await until(() => replyEnded);

  const shutdown = await d.link.stream('shutdown');
  await shutdown.write('unread');
  h.host.close();
  await until(() => ended.includes('shutdown:unreachable'));
});

test('T4: revoke ends both sides even with readers stalled', async () => {
  let hostRead = false, deviceRead = false;
  let releaseHost!: () => void, releaseDevice!: () => void;
  const heldHost = new Promise<void>((resolve) => { releaseHost = resolve; });
  const heldDevice = new Promise<void>((resolve) => { releaseDevice = resolve; });
  let hostEnd: string | undefined, deviceEnd: string | undefined;
  const h = await startHost({ stream: async (s) => {
    s.onData = async () => { hostRead = true; await heldHost; };
    s.onEnd = (error) => { hostEnd = error; };
    await s.write('output');
  } });
  const d = await device(h, 'Phone');
  const s = await d.link.stream('terminal');
  s.onData = async () => { deviceRead = true; await heldDevice; };
  s.onEnd = (error) => { deviceEnd = error; };
  await s.write('input');
  await until(() => hostRead && deviceRead);
  await h.host.revoke(d.id);
  await until(() => hostEnd === 'removed' && deviceEnd === 'removed');
  releaseHost(); releaseDevice();
});

test('T4: streams end with their connection and on revoke; requests carry on; old hosts and refusals are told apart', async () => {
  const open: LinkStream[] = [];
  const h = await startHost({ stream: (s, req) => {
    if (req.op === 'nope') throw new PublicLinkError('No such pane.');
    if (req.op === 'bug') throw new Error('secret path /home/x');
    open.push(s); collect(s);
  } });
  const d = await device(h, 'Phone');
  const out = collect(await d.link.stream('terminal', { pane: 'p1' }));
  h.sockets.at(-1)!.terminate(); // the phone switched networks
  await until(() => out.got.ended);
  assert.equal(out.got.end, 'unreachable');
  await until(() => d.link.status === 'online');
  assert.equal(await d.link.request('still.works'), 'still.works');
  const again = collect(await d.link.stream('terminal', { pane: 'p1' })); // open it again on the next online
  const noPane = collect(await d.link.stream('nope'));
  await until(() => noPane.got.ended);
  assert.equal(noPane.got.end, 'No such pane.');
  const bug = collect(await d.link.stream('bug'));
  await until(() => bug.got.ended);
  assert.equal(bug.got.end, 'failed', "the app's own error stays on the host");
  assert.match(String(h.errors.at(-1)), /secret path/, 'and goes to onError');
  await h.host.revoke(d.id);
  await until(() => again.got.ended);
  assert.equal(again.got.end, 'removed');
  await assert.rejects(d.link.stream('terminal'), (e: LinkError) => e.code === 'removed');

  const old = await startHost(); // no `stream` option: what a host without streams looks like to a device
  const o = await device(old, 'Phone');
  await assert.rejects(o.link.stream('terminal'), (e: LinkError) => e.code === 'not-supported');
  assert.equal(await o.link.request('ping'), 'ping');
});

test('T4: failed opens settle and throwing end callbacks are reported without escaping', async () => {
  const failed = new Streams({ send: () => { throw new Error('message too large'); }, data: () => {} });
  await assert.rejects(failed.open('terminal', { pane: 'p1' }), /message too large/);
  assert.equal(failed.size, 0);
  failed.closeAll('unreachable');

  const errors: unknown[] = [];
  const streams = new Streams({ send: () => {}, data: () => {}, report: (e) => { errors.push(e); } });
  const clean = streams.add(1, 'terminal', {});
  clean.onEnd = () => { throw new Error('clean cleanup'); };
  clean.end();
  await until(() => errors.length === 1);
  const disconnected = streams.add(2, 'terminal', {});
  disconnected.onEnd = () => { throw new Error('disconnect cleanup'); };
  streams.closeAll('unreachable');
  const late = streams.add(3, 'terminal', {});
  late.ended('removed');
  late.onEnd = () => { throw new Error('late cleanup'); };
  await until(() => errors.length === 3);
  assert.deepEqual(errors.map(String), ['Error: clean cleanup', 'Error: disconnect cleanup', 'Error: late cleanup']);
});

test('T4: a peer that sends past its window, or data that is not bytes, is cut off', () => {
  const sent: object[] = [];
  const streams = new Streams({ send: (m) => sent.push(m), data: () => {} });
  streams.add(3, 'preview', {});
  assert.equal(streams.message({ t: 'data', s: 3, d: new Uint8Array(WINDOW) }), true, 'a full window is fine');
  assert.throws(() => streams.message({ t: 'data', s: 3, d: new Uint8Array(1) }), /window/);
  assert.throws(() => streams.message({ t: 'data', s: 3, d: 'aGk=' }), /bad stream/, 'data only arrives as a binary inner message');
  assert.throws(() => streams.message({ t: 'credit', s: 3, n: -1 }), /bad stream/);
  assert.equal(streams.message({ t: 'data', s: 99, d: new Uint8Array(1) }), true, 'late data for a stream ended here is dropped');
  assert.equal(streams.message({ t: 'req' }), false);
});

test('F4: stream bytes go as binary WebSocket messages on a direct socket, and as text through a relay, which still works', async () => {
  const echo: Partial<HostOptions> = { stream: (s) => { s.onData = (c) => s.write(c); } };
  const h = await startHost(echo);
  const d = await device(h, 'Phone');
  h.kinds.in.clear(); h.kinds.out.clear();
  const direct = await d.link.stream('echo');
  const od = collect(direct);
  await direct.write(Uint8Array.from([0, 1, 2, 255]));
  await until(() => od.got.bytes.length);
  assert.deepEqual([...od.got.bytes[0]], [0, 1, 2, 255]);
  assert.deepEqual([...h.kinds.in].sort(), ['binary', 'text'], 'the device sent its bytes as binary, the open as text');
  assert.deepEqual([...h.kinds.out].sort(), ['binary', 'text'], 'and so did the host');

  // A relay whose host wrapper is JSON text: the host says nothing about binary there, so both ends send text.
  const r = await startHost(echo);
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let hostSide: WsSocket | undefined;
  const devices = new Map<string, WsSocket>();
  const seen = new Set<string>();
  let n = 0;
  wss.on('connection', (ws, req) => {
    if (req.url === '/host') {
      hostSide = ws;
      ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.end !== undefined) devices.get(m.c)?.close(); else devices.get(m.c)?.send(m.f); });
      return;
    }
    const c = String(++n);
    devices.set(c, ws);
    ws.on('message', (raw, isBinary) => { seen.add(isBinary ? 'binary' : 'text'); hostSide!.send(JSON.stringify({ c, f: String(raw) })); });
    ws.on('close', () => hostSide?.send(JSON.stringify({ c, end: 1000 })));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const relay = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const toRelay = new WebSocket(`${relay}/host`);
  await new Promise((ok) => { toRelay.onopen = ok; });
  r.host.relay(toRelay);
  closers.push(() => { toRelay.close(); wss.close(); server.close(); });
  const far = await device(r, 'Away phone', 'control', `${relay}/link/v1/${r.host.id}`);
  const s = await far.link.stream('echo');
  const of = collect(s);
  const big = Uint8Array.from({ length: 200_000 }, (_, i) => i & 255);
  await s.write(big);
  await until(() => Buffer.concat(of.got.bytes).length === big.length);
  assert.ok(Buffer.concat(of.got.bytes).equals(big));
  assert.deepEqual([...seen], ['text']);
});
