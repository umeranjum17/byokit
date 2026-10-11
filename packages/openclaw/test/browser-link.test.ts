import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { Host, DeviceLink, keyPair, pairWithOffer, type Grant } from '@byokit/pair';
import type { OpenClawKit } from '../src/kit.ts';
import { openclawLink } from '../src/link.ts';
import { browserDevice, openclawDevice, openSignInNotice } from '../src/device.ts';
import type { BrowserHost, LiveFrame, LiveViewState, NeedSignIn, TakeoverLease } from '../src/browser.ts';

const closers: (() => void)[] = [];
after(() => closers.forEach(close => close()));
const sleep = (n: number) => new Promise(r => setTimeout(r, n));
async function until(f: () => boolean): Promise<void> {
  for (let n = 0; n < 250; n++) { if (f()) return; await sleep(10); }
  throw new Error('condition timed out');
}
const source = { kind: 'browser' as const, member: 'a' };
const request = (member = 'a'): NeedSignIn => ({ id: `request-${member}`, gen: 1, member, sessionKey: `agent:${member}:task`,
  origin: 'http://127.0.0.1', site: '127.0.0.1', secure: true, firstTime: true, reasons: ['password-field'], hints: ['password'],
  choices: [{ kind: 'takeover' }, { kind: 'not-now' }, { kind: 'cancel' }], state: 'waiting', at: Date.now(), expires: Date.now() + 60000 });

async function world(o: { cleanup?: Promise<void>; protected?: boolean } = {}) {
  const rows = [request(), request('b')];
  let valid = true;
  let calls = 0;
  let inputs = 0;
  let closed = 0;
  const removed: string[] = [];
  const viewers: { grant: string; on: { state(s: LiveViewState): void; frame(f: LiveFrame): void } }[] = [];
  const lease: TakeoverLease = { requestId: rows[0].id, gen: 1, epoch: 1, nonce: 'synthetic-lease-capability',
    expires: Date.now() + 60000, claimMs: 1000, graceMs: 30000 };
  const change = async (id: string, gen: number, state: NeedSignIn['state']) => {
    const r = rows.find(r => r.id === id)!;
    assert.equal(gen, r.gen); r.state = state; return r;
  };
  const browser: BrowserHost & { revokeGrant(grant: string): Promise<void> } = {
    state: member => ({ member, phase: 'ready', why: 'handoff-unprotected' }),
    signIns: member => rows.filter(r => !member || r.member === member),
    takeover: async (id, gen, by) => { assert.equal(by.confirmSite, '127.0.0.1'); await change(id, gen, 'held'); return lease; },
    confirmOrigin: l => { if (!valid || l.nonce !== lease.nonce) throw new Error('synthetic secret must not escape'); },
    done: async () => { if (!valid) throw new Error('secret'); rows[0].state = 'settled';
      rows[0].settled = { state: 'entered-unverified', reason: 'no-verifier', at: Date.now() }; return rows[0]; },
    notNow: (id, gen) => change(id, gen, 'parked'), reopen: (id, gen) => change(id, gen, 'waiting'),
    retry: (id, gen) => change(id, gen, 'waiting'), cancel: (id, gen) => change(id, gen, 'settled'),
    forget: async () => {},
    thumbnail: async () => ['waiting', 'held', 'checking'].includes(rows[0].state) ? { state: 'private' }
      : { state: 'ok', frame: { seq: 1, w: 2, h: 1, at: Date.now(), jpeg: new Uint8Array([1, 2, 3]) } },
    live: (s, opts, on) => {
      viewers.push({ grant: opts.grant, on });
      on.state({ source: s, phase: !opts.lease && ['waiting', 'held', 'checking'].includes(rows[0].state) ? 'private' : 'live',
        mode: opts.lease ? 'control' : 'observe' });
      return { input: () => { if (!valid) throw new Error('secret'); inputs++; }, close: () => { closed++; } };
    },
    revokeGrant: async id => {
      valid = false; removed.push(id); // exact synchronous invalidation before privacy I/O
      await o.cleanup;
      rows[0].state = 'waiting'; rows[0].gen++;
    },
  };
  if (o.protected === false) delete (browser as Partial<typeof browser>).revokeGrant;
  const events = new Set<(p: unknown, event: string) => void>();
  const notices: Record<string, unknown>[] = [];
  const kit = { browser, onEvent: (_e: string, cb: (p: unknown, event: string) => void) => { events.add(cb); return () => events.delete(cb); },
    onApproval: () => () => {}, call: async () => { calls++; return {}; } } as unknown as OpenClawKit & { browser: BrowserHost };
  const api = openclawLink(kit, { memberOf: g => (g.meta as { member: string }).member, passThrough: () => true,
    relay: { notify: async (n: Record<string, unknown>) => { notices.push(n); return {}; } } as never });
  let durable = 0;
  const host = await Host.open({ keys: keyPair(), name: 'Synthetic browser', confirm: () => true, ...api,
    answers: { get: () => undefined, put: () => { durable++; }, drop: () => {} } });
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const sockets: WebSocket[] = [];
  wss.on('connection', ws => { sockets.push(ws); host.accept(ws); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => { host.close(); sockets.forEach(s => s.terminate()); wss.close(); server.close(); });
  const device = async (member: string, role: Grant['role'] = 'control', lifetime?: number) => {
    const grant = await pairWithOffer(host.offer({ role, urls: [url], meta: { member }, lifetime }).text,
      { name: 'Synthetic viewer', onWords: () => {} });
    const link = new DeviceLink(grant);
    closers.push(() => link.stop()); await until(() => link.status === 'online');
    return { link, browser: openclawDevice(link).browser, id: grant.device.id };
  };
  return { host, api, browser, rows, viewers, lease, device, notices, sockets, removed,
    emit: () => events.forEach(e => e({ member: 'a', kind: 'signin' }, 'byokit.browser')),
    calls: () => calls, inputs: () => inputs, closed: () => closed, durable: () => durable };
}

test('O22: all browser actions and request states round-trip transiently; roles and members are guarded', async () => {
  const w = await world(); const a = await w.device('a'); const view = await w.device('a', 'view'); const b = await w.device('b');
  assert.equal((await a.browser.state('a')).why, 'handoff-unprotected');
  for (const state of ['waiting', 'held', 'checking', 'parked', 'settled'] as const) {
    w.rows[0].state = state;
    assert.equal((await view.browser.signIns())[0].state, state);
  }
  for (const state of ['verified', 'entered-unverified', 'cancelled', 'expired', 'failed'] as const) {
    w.rows[0].settled = { state, at: Date.now() };
    assert.equal((await a.browser.signIns())[0].settled?.state, state);
  }
  w.rows[0].state = 'waiting';
  await assert.rejects(view.browser.takeover('request-a', 1));
  await assert.rejects(b.browser.takeover('request-a', 1));
  await assert.rejects(a.browser.state('b'));
  await assert.rejects(a.browser.thumbnail({ kind: 'browser', member: 'b' }));
  await assert.rejects(a.link.request('oc.call', { method: 'browser.request', params: {} }));
  await assert.rejects(a.link.request('oc.call', { method: 'terminal.open', params: {} }));
  await assert.rejects(a.link.request('oc.call', { method: 'tools.invoke', params: {} }));
  const before = w.durable();
  const lease = await a.browser.takeover('request-a', 1, { confirmSite: '127.0.0.1' });
  await assert.rejects(b.browser.done(lease));
  await assert.rejects(view.browser.done(lease));
  await a.browser.confirmOrigin(lease, 'http://127.0.0.1');
  assert.equal((await a.browser.done(lease)).settled?.state, 'entered-unverified');
  assert.equal((await a.browser.notNow('request-a', 1)).state, 'parked');
  assert.equal((await a.browser.reopen('request-a', 1)).state, 'waiting');
  await a.browser.cancel('request-a', 1); await a.browser.retry('request-a', 1); await a.browser.forget('a', '127.0.0.1');
  assert.deepEqual(await a.browser.thumbnail(source), { state: 'private' });
  w.rows[0].state = 'settled';
  const thumb = await a.browser.thumbnail(source);
  assert.equal(thumb.state, 'ok'); if (thumb.state === 'ok') assert.deepEqual(thumb.frame.jpeg, new Uint8Array([1, 2, 3]));
  assert.equal(w.durable(), before, 'browser leases and JPEGs never reach the durable answer store');
  assert.deepEqual(await a.browser.thumbnail({ kind: 'desktop', member: 'a', source: 'host' }), { state: 'unsupported' });
  const desktop = a.browser.live({ kind: 'desktop', member: 'a', source: 'host' });
  const states = desktop.states[Symbol.asyncIterator]();
  await states.next();
  assert.equal((await states.next()).value?.why, 'unsupported', 'browser-only implementation never qualifies full-computer capture');
  desktop.close();
  assert.equal(w.calls(), 0, 'watching/actions never invoke the model or arbitrary gateway method');
});

test('O22: revoke while held without a live stream and during live is immediate, even while cleanup awaits', async () => {
  let release!: () => void; const cleanup = new Promise<void>(r => { release = r; });
  const w = await world({ cleanup }); const a = await w.device('a');
  const lease = await a.browser.takeover('request-a', 1, { confirmSite: '127.0.0.1' });
  a.link.stop(); await until(() => !w.host.devices()[0]?.online);
  assert.equal(w.removed.length, 0, 'drop without a stream does not revoke: host grace is preserved');
  const removing = w.host.revoke(a.id);
  await until(() => w.removed.length === 1);
  assert.deepEqual(w.host.devices(), []);
  await assert.rejects(w.browser.done(lease));
  assert.equal(w.rows[0].state, 'held', 'no new request generation before cleanup');
  release(); await removing;
  assert.equal(w.rows[0].state, 'waiting'); assert.equal(w.rows[0].gen, 2);

  const liveWorld = await world(); const controller = await liveWorld.device('a');
  const l = await controller.browser.takeover('request-a', 1, { confirmSite: '127.0.0.1' });
  const live = controller.browser.live(source, { lease: l });
  await until(() => liveWorld.viewers.length === 1);
  await liveWorld.host.revoke(controller.id);
  await until(() => liveWorld.closed() === 1);
  assert.equal(liveWorld.removed.length, 1);
  live.close();
});

test('O22: one browser stream supplies thumbnail/full view; slow readers drop frames; cancellation and reconnect need zero model calls', async () => {
  const w = await world(); const a = await w.device('a');
  const events = openclawDevice(a.link).events()[Symbol.asyncIterator]();
  const ping = events.next();
  await sleep(30); w.emit();
  assert.deepEqual((await ping).value, { event: 'byokit.browser', payload: { member: 'a', kind: 'signin' } });
  await events.return?.();
  w.rows[0].state = 'settled';
  const live = a.browser.live(source, { maxWidth: 320 });
  const states = live.states[Symbol.asyncIterator](); const frames = live.frames[Symbol.asyncIterator]();
  assert.equal((await states.next()).value?.phase, 'connecting');
  await until(() => w.viewers.length === 1);
  assert.equal((await states.next()).value?.phase, 'live');
  for (let seq = 1; seq <= 100; seq++) w.viewers[0].on.frame({ seq, w: 2, h: 1, at: Date.now(), jpeg: new Uint8Array([seq]) });
  await sleep(50);
  assert.equal((await frames.next()).value?.seq, 100, 'latest frame, not a growing reader queue');
  const parked = frames.next(); live.close(); assert.equal((await parked).done, true);
  await until(() => w.closed() === 1);
  const reconnect = a.browser.live(source); const rs = reconnect.states[Symbol.asyncIterator]();
  await rs.next(); await until(() => w.viewers.length === 2); await rs.next();
  w.sockets.forEach(s => s.terminate());
  assert.equal((await rs.next()).value?.phase, 'reconnecting');
  assert.equal(w.calls(), 0); reconnect.close();
});

test('O22: private observer frames and arbitrary input are refused; expiry invalidates offline grants', async () => {
  const w = await world(); const a = await w.device('a'); const other = await w.device('a');
  const lease = await a.browser.takeover('request-a', 1, { confirmSite: '127.0.0.1' });
  await assert.rejects(other.browser.done(lease), 'lease capability is bound to the grant, not just the member');
  const observe = other.browser.live(source);
  const states = observe.states[Symbol.asyncIterator](); const frames = observe.frames[Symbol.asyncIterator]();
  await states.next(); await until(() => w.viewers.length === 1);
  assert.equal((await states.next()).value?.phase, 'private');
  const pending = frames.next();
  w.viewers[0].on.frame({ seq: 1, w: 1, h: 1, at: Date.now(), jpeg: new Uint8Array([7]) });
  await sleep(20); observe.close();
  assert.equal((await pending).done, true, 'a host frame callback cannot override private state');
  const raw = await a.link.stream('oc.browser.live', { source, mode: 'control', lease });
  let end: string | undefined;
  raw.onData = () => {}; raw.onEnd = error => { end = error; };
  await raw.write(`${JSON.stringify({ kind: 'cdp', method: 'Runtime.evaluate', text: 'synthetic-secret' })}\n`);
  await until(() => end !== undefined);
  assert.equal(w.inputs(), 0);
  assert.ok(!end!.includes('synthetic-secret'), 'refusals never echo arbitrary input');

  const expiry = await world(); const d = await expiry.device('a', 'control', 400);
  await d.browser.takeover('request-a', 1, { confirmSite: '127.0.0.1' });
  d.link.stop();
  await until(() => expiry.removed.length === 1);
  assert.equal(expiry.rows[0].state, 'waiting');
  assert.equal(expiry.rows[0].gen, 2, 'expired offline control has no grace');
});

test('O22: browser pings whitelist member/kind, discard foreign/malformed payloads and never forward capabilities', async () => {
  let fire: ((p: unknown, e: string) => void) | undefined;
  const kit = { onEvent: (_e: string, f: typeof fire) => { fire = f; return () => {}; }, onApproval: () => () => {} } as never;
  const api = openclawLink(kit, { memberOf: () => 'a' });
  const writes: string[] = [];
  await api.stream!({ write: async (s: string) => { writes.push(s); } } as never,
    { op: 'oc.events' }, { id: 'grant', role: 'view' } as never);
  fire!({ member: 'a', kind: 'signin', nonce: 'synthetic-do-not-forward' }, 'byokit.browser');
  fire!({ member: 'b', kind: 'signin' }, 'byokit.browser');
  fire!({ agentId: 'a', kind: 'signin', nonce: 'synthetic-do-not-forward' }, 'byokit.browser');
  fire!({ member: 'a', kind: 'unknown' }, 'byokit.browser');
  assert.deepEqual(writes.map(s => JSON.parse(s)), [{ event: 'byokit.browser', payload: { member: 'a', kind: 'signin' } }]);
});

test('O22: ordinary keydown/keyup queue behind credit without closing; cancellation clears queued secret input', async () => {
  const writes: string[] = [];
  const releases: (() => void)[] = [];
  let ended = 0;
  const stream = { write: (value: string) => { writes.push(value); return new Promise<void>(r => releases.push(r)); },
    end: () => { ended++; } };
  const live = browserDevice({ stream: async () => stream } as never).live(source, {
    lease: { requestId: 'r', gen: 1, epoch: 1, nonce: 'synthetic', expires: Date.now() + 1000, claimMs: 100, graceMs: 100 },
  });
  await sleep(0);
  live.input({ kind: 'key', type: 'down', key: 'a' });
  live.input({ kind: 'key', type: 'up', key: 'a' });
  live.input({ kind: 'text', text: 'synthetic-secret-input' });
  assert.equal(ended, 0, 'ordinary typing must not close the stream');
  assert.equal(writes.length, 1);
  releases.shift()!(); await sleep(0);
  assert.equal(JSON.parse(writes[1]).type, 'up', 'input order survives backpressure');
  live.close(); releases.shift()!(); await sleep(0);
  assert.equal(writes.length, 2, 'queued text was discarded, never sent after cancellation');
  assert.equal(ended, 1);
});

test('O22: control fails closed without revoke seam; notices contain only sealed non-authorizing hints', async () => {
  const missing = await world({ protected: false }); const a = await missing.device('a');
  await assert.rejects(a.browser.takeover('request-a', 1, { confirmSite: '127.0.0.1' }));
  const w = await world(); const d = await w.device('a'); const seed = new Uint8Array(32).fill(17);
  await openclawDevice(d.link).registerNotices(seed);
  w.emit(); await until(() => w.notices.length === 1);
  const notice = w.notices[0];
  assert.ok(!JSON.stringify(notice).includes('127.0.0.1'));
  assert.ok(!JSON.stringify(notice).includes(w.lease.nonce));
  assert.deepEqual(openSignInNotice(notice.data as Record<string, unknown>, seed),
    { source: 'signin', id: 'request-a', gen: 1, member: 'a', site: '127.0.0.1' });
  assert.equal(openSignInNotice(notice.data as Record<string, unknown>, new Uint8Array(32)), null);
});
