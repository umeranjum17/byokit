// The link end to end over real WebSockets: a host behind a `ws` server, devices on Node's built-in (browser-shaped)
// WebSocket. Pairing, grants, revoke, reconnect with idempotent requests, a relay that routes blind, and migration.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  DeviceLink, Host, LinkError, b64url, hostId, keyPair, keyPairFrom, unb64url, pairWithCode as pairCode, pairWithOffer as pairOffer, parseOffer,
  type DeviceGrant, type Grant, type HostOptions, type LinkStatus, type PairRequest,
} from '../src/index.ts';

const pairWithOffer = (text: string, o: { name: string; onWords?: (w: string) => void }) => pairOffer(text, { ...o, onWords: o.onWords ?? (() => {}) });
const pairWithCode = (url: string, code: string, o: { name: string; onWords?: (w: string) => void }) => pairCode(url, code, { ...o, onWords: o.onWords ?? (() => {}) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 5000): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) { const v = await fn(); if (v) return v; }
  throw new Error('timed out');
}

const closers: (() => void)[] = [];
after(() => closers.forEach((c) => c()));

/** A host on a real port. `asked` records every pairing request; `sockets` are the host's side of each connection. */
async function startHost(o: Partial<HostOptions> = {}) {
  const asked: PairRequest[] = [];
  let saved: Grant[] = [];
  const ran: string[] = [];
  const host = await Host.open({
    keys: keyPair(), name: 'Kitchen computer',
    grants: { load: () => saved, save: (g) => { saved = g; } },
    confirm: (p) => { asked.push(p); return true; },
    canView: (r) => r.op.startsWith('get.'),
    handle: async (r, dev) => { ran.push(`${dev.name}:${r.op}`); if (r.op === 'slow') await sleep(300); if (r.op === 'fail') throw Object.assign(new Error('nope'), { expose: true }); if (r.op === 'secret-fail') throw new Error('secret-token'); return { op: r.op, args: r.args, by: dev.id }; },
    ...o,
  });
  const sockets: WsSocket[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });
  wss.on('connection', (ws) => { sockets.push(ws); host.accept(ws); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  closers.push(() => { host.close(); wss.close(); server.close(); });
  return { host, url, asked, ran, sockets, saved: () => saved };
}

/** A device's live link, with its statuses and events recorded and an in-memory store. */
function connect(grant: DeviceGrant) {
  const seen: LinkStatus[] = [], events: unknown[] = [];
  const store = { g: grant as DeviceGrant | null, save(g: DeviceGrant) { this.g = g; }, clear() { this.g = null; } };
  const link = new DeviceLink(grant, { store, onStatus: (s) => seen.push(s), onEvent: (e) => events.push(e) });
  closers.push(() => link.stop());
  return { link, seen, events, store };
}

test('scan to pair: the person at the host sees the same two words, then the device is granted', async () => {
  const h = await startHost();
  const { text } = h.host.offer({ role: 'control', urls: ['ws://127.0.0.1:1/nothing-here', h.url], meta: { person: 2 } });
  assert.equal(parseOffer(text).name, 'Kitchen computer');
  let shown = '';
  const grant = await pairWithOffer(text, { name: 'Pixel\u202e', onWords: (w) => { shown = w; } });
  assert.equal(h.asked.length, 1);
  assert.deepEqual({ ...h.asked[0], words: '' }, { name: 'Pixel', role: 'control', how: 'scan', meta: { person: 2 }, words: '' }, 'hidden characters are stripped from names');
  assert.equal(h.asked[0].words, shown, 'both screens show the same words');
  assert.equal(grant.device.role, 'control');
  assert.equal(grant.urls[0], h.url, 'the address that answered goes first');
  assert.equal(grant.hostName, 'Kitchen computer');
  assert.deepEqual(h.saved().map((g) => [g.name, g.role, g.meta]), [['Pixel', 'control', { person: 2 }]]);
  assert.equal(h.saved()[0].key, b64url(keyPairFrom(unb64url(grant.secretKey)).publicKey), 'the host holds the device key');

  // The ticket is single use: a second device with the same QR is refused, by the host itself.
  await assert.rejects(pairWithOffer(text, { name: 'Again' }), (e: LinkError) => e.code === 'expired' && e.sealed);
  assert.equal(h.asked.length, 1, 'the person is never asked about a spent code');
});

test('a pairing code runs out, a person can say no, and a host can be full', async () => {
  const h = await startHost({ pairMs: 150 });
  const late = h.host.offer({ role: 'view', urls: [h.url] }).text;
  await sleep(200);
  assert.throws(() => parseOffer(late), /run out/, 'the device says so before dialling');
  const offer = JSON.parse(Buffer.from(late.split(':')[2], 'base64url').toString());
  const forced = late.split(':').slice(0, 2).join(':') + ':' + Buffer.from(JSON.stringify({ ...offer, expires: Date.now() + 60_000 })).toString('base64url');
  await assert.rejects(pairWithOffer(forced, { name: 'Late' }), (e: LinkError) => e.code === 'expired' && e.sealed, 'the host refuses it too');

  const no = await startHost({ confirm: () => false });
  await assert.rejects(pairWithOffer(no.host.offer({ role: 'control', urls: [no.url] }).text, { name: 'Stranger' }), (e: LinkError) => e.code === 'declined');
  assert.deepEqual(no.saved(), []);

  const full = await startHost({ maxDevices: 1 });
  await pairWithOffer(full.host.offer({ role: 'control', urls: [full.url] }).text, { name: 'One' });
  await assert.rejects(pairWithOffer(full.host.offer({ role: 'control', urls: [full.url] }).text, { name: 'Two' }), (e: LinkError) => e.code === 'full');
});

test('typed code: pairs once, and five wrong codes withdraw every open code', async () => {
  const h = await startHost();
  const { code } = h.host.code({ role: 'view' });
  assert.match(code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  let shown = '';
  const grant = await pairWithCode(h.url, code.toLowerCase().replace(/-/g, ' '), { name: 'Laptop', onWords: (w) => { shown = w; } });
  assert.equal(h.asked[0].how, 'code');
  assert.equal(h.asked[0].words, shown);
  assert.equal(grant.device.role, 'view');
  assert.equal(grant.host, b64url(h.host.keys.publicKey), 'the device learned the host key from the handshake');
  await assert.rejects(pairWithCode(h.url, code, { name: 'Again' }), (e: LinkError) => e.code === 'wrong-code', 'single use');

  const good = h.host.code({ role: 'control' }).code;
  for (let i = 0; i < 5; i++) await assert.rejects(pairWithCode(h.url, 'ABCD-EFGH-JKMN', { name: 'Guess' }), (e: LinkError) => e.code === 'wrong-code');
  await assert.rejects(pairWithCode(h.url, good, { name: 'Real' }), (e: LinkError) => e.code === 'wrong-code', 'the window closed');
  await assert.rejects(pairWithCode(h.url, 'not a code', { name: 'x' }), (e: LinkError) => e.code === 'wrong-code');
});

test('grants: control can act, view-only can only look; answers come from the host', async () => {
  const h = await startHost();
  const control = connect(await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Phone' }));
  const viewer = connect(await pairWithOffer(h.host.offer({ role: 'view', urls: [h.url] }).text, { name: 'Tablet' }));
  assert.deepEqual(await control.link.request('send.message', { text: 'hi' }), { op: 'send.message', args: { text: 'hi' }, by: control.link.grant.device.id });
  assert.deepEqual(await viewer.link.request('get.state'), { op: 'get.state', by: viewer.link.grant.device.id });
  await assert.rejects(viewer.link.request('send.message'), (e: LinkError) => e.code === 'view-only' && e.message === 'This device can watch but not make changes.');
  await assert.rejects(control.link.request('fail'), /nope/);
  await assert.rejects(control.link.request('secret-fail'), (e: LinkError) => e.code === 'failed' && !e.message.includes('secret-token'));
  assert.deepEqual(h.ran, ['Phone:send.message', 'Tablet:get.state', 'Phone:fail', 'Phone:secret-fail']);
  h.host.broadcast({ kind: 'hello' }, (g) => g.role === 'control');
  await until(() => control.events.length);
  assert.deepEqual(control.events, [{ kind: 'hello' }]);
  assert.deepEqual(viewer.events, []);
  assert.deepEqual(h.host.devices().map((d) => [d.name, d.role, d.online]), [['Phone', 'control', true], ['Tablet', 'view', true]]);
});

test('reconnect and resume: a request cut off mid-flight is answered once after the device comes back', async () => {
  const h = await startHost();
  const d = connect(await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Phone' }));
  await until(() => d.link.status === 'online');
  const answer = d.link.request('slow', { n: 1 });
  await until(() => h.ran.length);
  for (const ws of h.sockets) ws.terminate(); // the network drops while the host is still working
  await until(() => d.seen.includes('offline'));
  assert.deepEqual(await answer, { op: 'slow', args: { n: 1 }, by: d.link.grant.device.id });
  assert.deepEqual(h.ran, ['Phone:slow'], 'resent with the same key after the reconnect, so it ran once');
  assert.equal(d.link.status, 'online');
  // Requests made while offline wait, then go.
  for (const ws of h.sockets) ws.terminate();
  const queued = d.link.request('send.later');
  assert.deepEqual(await queued, { op: 'send.later', by: d.link.grant.device.id });
});

test('unacknowledged answers survive more than 200 responses and a reconnect', async () => {
  const h = await startHost();
  const d = connect(await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Phone' }));
  await until(() => d.link.status === 'online');
  const ws = h.sockets.at(-1)!;
  ws.send = (() => {}) as typeof ws.send;
  const answers = Array.from({ length: 210 }, (_, n) => d.link.request(`op.${n}`));
  await until(() => h.ran.length === 210);
  ws.terminate();
  assert.equal((await Promise.all(answers)).length, 210);
  assert.equal(h.ran.length, 210, 'lost answers did not run again after reconnect');
});

test('failed grant saves leave memory unchanged and concurrent confirmations respect the device cap', async () => {
  let saved: Grant[] = [];
  let fail = false;
  const h = await startHost({
    grants: { load: () => saved, save: (g) => { if (fail) throw new Error('disk full'); saved = g; } },
  });
  const first = await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'One' });
  fail = true;
  await assert.rejects(h.host.revoke(first.device.id), /disk full/);
  assert.equal(h.host.devices().length, 1);
  await assert.rejects(pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Two' }), (e: LinkError) => e.code === 'failed');
  assert.equal(h.host.devices().length, 1);
  fail = false;
  await h.host.revoke(first.device.id);
  assert.equal(saved.length, 0);

  const confirms: ((yes: boolean) => void)[] = [];
  const cap = await startHost({ maxDevices: 1, confirm: () => new Promise<boolean>((r) => { confirms.push(r); }) });
  const a = pairWithOffer(cap.host.offer({ role: 'control', urls: [cap.url] }).text, { name: 'A' });
  const b = pairWithOffer(cap.host.offer({ role: 'control', urls: [cap.url] }).text, { name: 'B' });
  await until(() => confirms.length === 2);
  confirms.forEach((resolve) => resolve(true));
  const results = await Promise.allSettled([a, b]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(cap.host.devices().length, 1);
});

test('revoke closes the live socket, says so inside the channel, and the key is refused from then on', async () => {
  const h = await startHost();
  const grant = await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Lost phone' });
  const kept = connect(await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Kept phone' }));
  const lost = connect(grant);
  await until(() => lost.link.status === 'online' && kept.link.status === 'online');
  await h.host.revoke(lost.link.grant.device.id);
  await until(() => lost.link.status === 'removed');
  assert.equal(lost.store.g, null, 'the device forgets its grant');
  await assert.rejects(lost.link.request('get.x'), (e: LinkError) => e.code === 'removed');
  assert.deepEqual(h.host.devices().map((d) => d.name), ['Kept phone']);
  assert.ok(await kept.link.request('get.state'), 'other devices are untouched');

  // Revoked while offline: its next connection hears "not paired" from the host itself, and forgets.
  const offline = connect(grant);
  await until(() => offline.link.status === 'removed');
  assert.equal(offline.store.g, null);
});

test('a device whose host answers with another key stops and keeps its grant (not proof the host changed)', async () => {
  const h = await startHost();
  const grant = await pairWithOffer(h.host.offer({ role: 'control', urls: [h.url] }).text, { name: 'Phone' });
  const impostor = await startHost();
  const d = connect({ ...grant, urls: [impostor.url] });
  await until(() => d.link.status === 'refused');
  assert.ok(d.store.g, 'grant kept');
  assert.equal(impostor.asked.length, 0);
});

test('wrong host at one address does not prevent a later pinned address', async () => {
  const h = await startHost();
  const impostor = await startHost();
  const scanned = h.host.offer({ role: 'control', urls: [impostor.url, h.url] }).text;
  const grant = await pairWithOffer(scanned, { name: 'Phone' });
  const d = connect({ ...grant, urls: [impostor.url, h.url] });
  assert.deepEqual(await d.link.request('get.state'), { op: 'get.state', by: grant.device.id });
  assert.equal(d.link.status, 'online');
});

test('through a relay that routes on a header and never sees plaintext', async () => {
  const h = await startHost();
  // A toy relay: devices dial /link/v1/<host id>; the host keeps one socket at /host. Frames pass through as-is.
  const wire: string[] = [];
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let hostSocket: WsSocket | undefined;
  const devices = new Map<string, WsSocket>();
  let n = 0;
  wss.on('connection', (ws, req) => {
    if (req.url === '/host') {
      hostSocket = ws;
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        wire.push(String(raw));
        const d = devices.get(m.c);
        if (m.end !== undefined) d?.close();
        else d?.send(m.f);
      });
      return;
    }
    if (req.url !== `/link/v1/${h.host.id}`) return ws.close();
    const c = String(++n);
    devices.set(c, ws);
    ws.on('message', (raw) => { wire.push(String(raw)); hostSocket!.send(JSON.stringify({ c, f: String(raw) })); });
    ws.on('close', () => { devices.delete(c); hostSocket?.send(JSON.stringify({ c, end: 1000 })); });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => { wss.close(); server.close(); });
  const relay = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const toRelay = new WebSocket(`${relay}/host`);
  await new Promise((r) => { toRelay.onopen = r; });
  h.host.relay(toRelay);
  closers.push(() => toRelay.close());

  assert.equal(h.host.id, hostId(h.host.keys.publicKey));
  const grant = await pairWithOffer(h.host.offer({ role: 'control', urls: [`${relay}/link/v1/${h.host.id}`] }).text, { name: 'Away phone' });
  const d = connect(grant);
  assert.deepEqual(await d.link.request('send.secret', { text: 'plaintext-marker' }), { op: 'send.secret', args: { text: 'plaintext-marker' }, by: grant.device.id });
  const all = wire.join('\n');
  assert.ok(wire.length > 4);
  assert.doesNotMatch(all, /plaintext-marker|Away phone|send\.secret|Kitchen/, 'the relay saw only ciphertext');
  assert.doesNotMatch(all, new RegExp(grant.device.id), "and never the device's id");
  // Revoke works the same way through the relay.
  await h.host.revoke(grant.device.id);
  await until(() => d.link.status === 'removed');
});

test('migration: a device the app already trusts (paired under an older protocol) is enrolled without pairing again', async () => {
  const h = await startHost();
  // In the app, this key arrives over the old authenticated channel; the host's key goes back the same way.
  const deviceKeys = keyPair();
  const g = await h.host.enrol({ key: deviceKeys.publicKey, name: 'Old phone', role: 'view', meta: { legacyId: 'dev-17' } });
  assert.equal(h.asked.length, 0, 'no pairing prompt: the old grant already vouched for it');
  const d = connect({ v: 1, secretKey: b64url(deviceKeys.secretKey), host: b64url(h.host.keys.publicKey), hostName: '', urls: [h.url], device: { id: g.id, name: g.name, role: g.role } });
  assert.deepEqual(await d.link.request('get.state'), { op: 'get.state', by: g.id });
  await assert.rejects(d.link.request('send.x'), (e: LinkError) => e.code === 'view-only', 'observe maps to view');
  assert.deepEqual(h.saved().map((x) => x.meta), [{ legacyId: 'dev-17' }]);
});
