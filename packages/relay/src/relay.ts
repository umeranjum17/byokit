// The relay: a server both sides dial out to, so a host needs no inbound port. It routes @byokit/link frames by host
// address and never reads them: devices dial /link/v1/<host id> and speak bare link frames; each host keeps one socket
// at /relay/v1/host, proves it holds its key, and gets every device's frames wrapped as {c, f}. Devices are never
// authenticated here, because the host checks each one itself on every handshake.
//
// It also holds what a sleeping phone needs (push subscriptions), a short code a person can type to find a host, and
// the owner's list of hosts allowed to register. Mount it on any Node HTTP server (`attach`), or call `upgrade` and
// `request` from your own routing to embed it in a bigger service.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { b64url, hostId, unb64url } from '@byokit/link';
import { CLOSE, challenge } from './proof.ts';
import { deliver, parseNotification, parseSubscription, pushHosts, vapidKeys, type Notification, type PushRecord, type Vapid } from './push.ts';

/** A host allowed to register. `id` is link's `hostId(key)`, the address devices dial. */
export type HostRecord = { id: string; key: string; name: string; added: number };
/** An owner-created enrolment: the claim is kept only as a hash. */
export type Enrolment = { id: string; hash: string; name?: string; expires: number };
/** Everything the relay keeps. Save it where only the relay can read it; never restore an old copy automatically, as it
 *  could bring back a revoked host. */
export type RelayState = { hosts: HostRecord[]; enrolments: Enrolment[]; push: PushRecord[]; vapid?: Vapid };
export type RelayStore = { load(): RelayState | undefined | Promise<RelayState | undefined>; save(s: RelayState): void | Promise<void> };

export type RelayOptions = {
  store?: RelayStore;
  /** Turns on the owner's HTTP routes (create an enrolment, list and revoke hosts), for this bearer token. */
  ownerToken?: string;
  /** Take the client's address from X-Forwarded-For (only behind a proxy you run). */
  trustProxy?: boolean;
  /** Web Push's contact (`mailto:` or `https:`), and the fetch used to reach push services. */
  push?: { subject?: string; fetch?: typeof fetch; hosts?: readonly string[] };
  /** How long a push action waits for the host's answer. Default 15 s. */
  actionMs?: number;
  now?: () => number;
};

/** Per-client-address limits in a one-minute window, the same as muxr's relay. */
export const LIMITS = {
  ws: 60, // WebSocket connections, host or device
  code: 10, // short-code lookups (muxr: pair-code)
  action: 20, // push actions (muxr: claim)
  enrol: 10, // enrolment claims
  proof: 10, // failed host proofs (muxr: failed mints)
};

const ENROL_MS = 5 * 60_000;
const CODE_MS = 5 * 60_000;
const HELLO_MS = 10_000;
const MAX_DEVICES = 256; // live device connections per host
const MAX_PAYLOAD = 2 << 20;
const DEDUP = 2048; // notification ids remembered per host

type Live = { id: string; ws: WebSocket; devices: Map<string, WebSocket>; next: number };
type Waiting = { live: Live; resolve: (answer: { ok: boolean; value?: unknown; error?: string }) => void };

// Short codes use link's typed-code alphabet (no 0, 1, I, L, O), so a person types both kinds the same way.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const UNSAFE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu; // control and direction-flipping characters
const cleanName = (name: unknown, fallback: string): string =>
  (typeof name === 'string' ? name.replace(UNSAFE, '').trim().slice(0, 60) : '') || fallback;
const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const later = (ms: number, fn: () => void) => { const t = setTimeout(fn, ms); t.unref(); return t; };
const closeCode = (c: unknown) => (c === 1000 || (Number.isInteger(c) && (c as number) >= 3000 && (c as number) <= 4999) ? (c as number) : 1000);

export class Relay {
  private opts: RelayOptions;
  private state: RelayState;
  private pushHosts: readonly string[];
  private live = new Map<string, Live>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  private buckets = new Map<string, { start: number; n: number }>();
  private codes = new Map<string, { host: string; expires: number }>();
  private tokens = new Map<string, { host: string; device: string; event: string; actions: string[]; expires: number }>();
  private sent = new Map<string, string[]>(); // host -> recent notification ids
  private waiting = new Map<string, Waiting>();
  private pending = new Map<string, Set<string>>();
  private saves: Promise<void> = Promise.resolve();
  private seq = 0;

  private constructor(opts: RelayOptions, state: RelayState) {
    this.opts = opts;
    this.state = state;
    this.pushHosts = pushHosts(opts.push?.hosts);
  }

  static async open(opts: RelayOptions = {}): Promise<Relay> {
    const s = await opts.store?.load();
    const state: RelayState = { hosts: [...(s?.hosts ?? [])], enrolments: [...(s?.enrolments ?? [])], push: [...(s?.push ?? [])], vapid: s?.vapid };
    const relay = new Relay(opts, state);
    if (!state.vapid) await relay.change((s) => { s.vapid = vapidKeys(); });
    return relay;
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  private change<T>(update: (state: RelayState) => T): Promise<T> {
    const work = this.saves.then(async () => {
      const next = structuredClone(this.state);
      const result = update(next);
      await this.opts.store?.save(next);
      this.state = next;
      return result;
    });
    this.saves = work.then(() => {}, () => {});
    return work;
  }

  /** Serves the relay's WebSocket and HTTP routes on this server; anything else gets a 404. */
  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => { if (!this.upgrade(req, socket, head)) socket.destroy(); });
    server.on('request', (req, res) => {
      void this.request(req, res).then((ours) => { if (!ours) json(res, 404, { error: 'not found' }); });
    });
  }

  /** Takes a WebSocket upgrade if it is for the relay; false leaves it to the caller. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = new URL(req.url ?? '/', 'http://relay').pathname;
    const device = /^\/link\/v1\/([A-Za-z0-9_-]{22})$/.exec(path);
    if (!device && path !== '/relay/v1/host') return false;
    const limited = this.limited('ws', req);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (limited) return ws.close(CLOSE.tooMany, 'too many requests');
      if (device) this.device(ws, device[1]!);
      else this.host(ws, req);
    });
    return true;
  }

  /** Answers an HTTP request if it is for the relay; false leaves it to the caller. */
  async request(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://relay');
    const path = url.pathname;
    if (!path.startsWith('/relay/v1/')) return false;
    try {
      // Anyone may look up a code or press a notification's button: both carry their own unguessable capability.
      const code = /^\/relay\/v1\/codes\/([A-Za-z0-9-]{1,16})$/.exec(path);
      if (code || path === '/relay/v1/push/action') {
        res.setHeader('access-control-allow-origin', '*');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }).end();
          return true;
        }
      }
      if (code && req.method === 'GET') {
        if (this.limited('code', req)) return json(res, 429, { error: 'too many requests' });
        const host = this.lookup(code[1]!);
        return host ? json(res, 200, { host }) : json(res, 404, { error: 'no such code' });
      }
      if (path === '/relay/v1/push/action' && req.method === 'POST') {
        if (this.limited('action', req)) return json(res, 429, { error: 'too many requests' });
        const body: any = await readJson(req);
        const r = await this.action(String(body?.token ?? ''), String(body?.action ?? ''));
        return json(res, r.status, r.body);
      }
      const owner = this.opts.ownerToken;
      if (path === '/relay/v1/enrolments' || path.startsWith('/relay/v1/hosts')) {
        const presented = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!owner || !presented || !same(presented, owner)) return json(res, 403, { error: 'owner only' });
        if (path === '/relay/v1/enrolments' && req.method === 'POST') {
          const body: any = await readJson(req);
          return json(res, 201, await this.enrolment({ name: body?.name }));
        }
        if (path === '/relay/v1/hosts' && req.method === 'GET') return json(res, 200, { hosts: this.hosts() });
        const one = /^\/relay\/v1\/hosts\/([A-Za-z0-9_-]{22})$/.exec(path);
        if (one && req.method === 'DELETE') return json(res, 200, { ok: true, removed: await this.revoke(one[1]!) });
      }
      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
  }

  /** Allows a host to register, the owner vouching for its key directly (a self-hosted relay beside its one host, or
   *  a hosted service's own sign-up). Returns its address. */
  async admit(key: Uint8Array, name = 'Computer'): Promise<string> {
    const id = hostId(key);
    await this.change((s) => {
      s.hosts = [...s.hosts.filter((h) => h.id !== id), { id, key: b64url(key), name: cleanName(name, 'Computer'), added: this.now() }];
    });
    return id;
  }

  /** A one-use enrolment a host claims within five minutes, by registering with it (`RelayClient({ enrol })`). Give
   *  the token to the machine's owner over a channel you trust; only its hash is kept. */
  async enrolment(o: { name?: string; ttlMs?: number } = {}): Promise<{ token: string; expires: number }> {
    const id = b64url(randomBytes(9));
    const claim = b64url(randomBytes(32));
    const now = this.now();
    const expires = now + Math.min(o.ttlMs ?? ENROL_MS, ENROL_MS);
    await this.change((s) => {
      s.enrolments = [...s.enrolments.filter((e) => e.expires > now), { id, hash: sha(claim), expires, ...(o.name ? { name: cleanName(o.name, 'Computer') } : {}) }];
    });
    return { token: `${id}.${claim}`, expires };
  }

  hosts(): (HostRecord & { online: boolean; devices: number })[] {
    return this.state.hosts.map((h) => ({ ...h, online: this.live.has(h.id), devices: this.count(h.id) }));
  }

  /** Removes a host: its registration, push subscriptions and codes go, and its socket and its devices' close. */
  async revoke(id: string): Promise<boolean> {
    const had = await this.change((s) => {
      const present = s.hosts.some((h) => h.id === id);
      s.hosts = s.hosts.filter((h) => h.id !== id);
      s.push = s.push.filter((p) => p.host !== id);
      return present;
    });
    for (const [c, v] of this.codes) if (v.host === id) this.codes.delete(c);
    for (const [t, v] of this.tokens) if (v.host === id) this.tokens.delete(t);
    const l = this.live.get(id);
    if (l) this.drop(l, CLOSE.revoked, 'host revoked');
    return had;
  }

  /** Live device connections: to one host, or to all of them. */
  count(id?: string): number {
    if (id !== undefined) return this.live.get(id)?.devices.size ?? 0;
    let n = 0;
    for (const l of this.live.values()) n += l.devices.size;
    return n;
  }

  close() {
    for (const l of [...this.live.values()]) this.drop(l, 1001, 'relay closing');
    this.wss.close();
  }

  private limited(kind: keyof typeof LIMITS, req: IncomingMessage): boolean {
    const fwd = this.opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]!.trim() : '';
    const key = `${kind}:${fwd || req.socket.remoteAddress}`;
    const now = this.now();
    if (this.buckets.size > 10_000) this.buckets.clear();
    const b = this.buckets.get(key);
    if (!b || now - b.start >= 60_000) { this.buckets.set(key, { start: now, n: 1 }); return false; }
    return ++b.n > LIMITS[kind];
  }

  private drop(l: Live, code: number, why: string) {
    if (this.live.get(l.id) === l) this.live.delete(l.id);
    l.ws.close(code, why);
    for (const d of l.devices.values()) d.close(1012, 'host went away'); // the device reconnects to the host's next socket
    l.devices.clear();
  }

  private device(ws: WebSocket, id: string) {
    const l = this.live.get(id);
    if (!l) return ws.close(1013, 'host offline');
    if (l.devices.size >= MAX_DEVICES) return ws.close(1013, 'host busy');
    const c = (++l.next).toString(36);
    l.devices.set(c, ws);
    // ponytail: no backpressure; a device that floods its host's socket is limited only by link dropping bad frames.
    ws.on('message', (data, binary) => {
      if (binary) return ws.close(1003, 'text frames only');
      l.ws.send(JSON.stringify({ c, f: data.toString() }));
    });
    ws.on('close', () => { if (l.devices.delete(c)) l.ws.send(JSON.stringify({ c, end: 1000 })); });
    ws.on('error', () => ws.terminate());
  }

  private host(ws: WebSocket, req: IncomingMessage) {
    const ch = challenge();
    let l: Live | undefined;
    const timer = later(HELLO_MS, () => { if (!l) ws.close(4408, 'too slow'); });
    ws.send(JSON.stringify(ch.msg));
    ws.on('error', () => ws.terminate());
    ws.on('close', () => {
      clearTimeout(timer);
      if (l && this.live.get(l.id) === l) this.drop(l, 1000, 'closed');
    });
    let hello = false;
    ws.on('message', (data) => {
      let m: any;
      try { m = JSON.parse(data.toString()); } catch { return ws.close(4400, 'bad message'); }
      if (l) return this.fromHost(l, m);
      if (hello) return; // still checking its hello
      hello = true;
      void this.register(ws, req, ch, m).then((ok) => { l = ok; clearTimeout(timer); }, () => ws.close(4400, 'bad hello'));
    });
  }

  private async register(ws: WebSocket, req: IncomingMessage, ch: ReturnType<typeof challenge>, m: any): Promise<Live | undefined> {
    const fail = (code: number, why: string) => { ws.close(code, why); return undefined; };
    if (m?.t !== 'hello' || typeof m.key !== 'string' || typeof m.proof !== 'string') return fail(4400, 'bad hello');
    let key: Uint8Array, proof: Uint8Array;
    try { key = unb64url(m.key); proof = unb64url(m.proof); } catch { return fail(4400, 'bad hello'); }
    if (key.length !== 32 || !ch.verify(key, proof)) {
      return this.limited('proof', req) ? fail(CLOSE.tooMany, 'too many requests') : fail(CLOSE.badProof, 'bad proof');
    }
    const id = hostId(key);
    if (!this.state.hosts.some((h) => h.id === id)) {
      if (typeof m.enrol !== 'string') return fail(CLOSE.notEnrolled, 'not enrolled');
      if (this.limited('enrol', req)) return fail(CLOSE.tooMany, 'too many requests');
      const [eid, claim = ''] = m.enrol.split('.');
      const enrolled = await this.change((s) => {
        if (s.hosts.some((h) => h.id === id)) return true;
        const e = s.enrolments.find((x) => x.id === eid);
        if (!e || !same(sha(claim), e.hash)) return false;
        s.enrolments = s.enrolments.filter((x) => x !== e);
        if (e.expires < this.now()) return false;
        s.hosts = [...s.hosts, { id, key: b64url(key), name: cleanName(e.name ?? m.name, 'Computer'), added: this.now() }];
        return true;
      });
      if (!enrolled) return fail(CLOSE.enrolment, 'enrolment expired or used');
    }
    if (ws.readyState !== ws.OPEN) return undefined;
    if (!this.state.hosts.some((h) => h.id === id)) return fail(CLOSE.revoked, 'host revoked');
    const old = this.live.get(id);
    if (old) this.drop(old, CLOSE.replaced, 'replaced by a newer host');
    const l: Live = { id, ws, devices: new Map(), next: 0 };
    this.live.set(id, l);
    ws.send(JSON.stringify({ t: 'ready', id, vapid: this.state.vapid!.publicKey }));
    return l;
  }

  private fromHost(l: Live, m: any) {
    if (this.live.get(l.id) !== l) return;
    if (typeof m?.c === 'string') {
      const d = l.devices.get(m.c);
      if (!d) return;
      if (m.end !== undefined) { l.devices.delete(m.c); d.close(closeCode(m.end)); }
      else if (typeof m.f === 'string') d.send(m.f);
      return;
    }
    if (m?.t === 'answer') {
      const id = String(m.id);
      const w = this.waiting.get(id);
      if (w?.live !== l) return;
      this.waiting.delete(id);
      return w.resolve({ ok: m.ok === true, value: m.value, error: typeof m.error === 'string' ? m.error.slice(0, 200) : undefined });
    }
    const reply = (r: object) => { if (this.live.get(l.id) === l) l.ws.send(JSON.stringify({ t: 'res', id: m?.id, ...r })); };
    void this.control(l.id, m).then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: String(e?.message ?? e) }));
  }

  private async control(host: string, m: any): Promise<object> {
    const now = this.now();
    if (m?.t === 'code') {
      for (const [c, v] of this.codes) if (v.expires < now) this.codes.delete(c);
      const mine = [...this.codes].filter(([, v]) => v.host === host);
      if (mine.length >= 16) this.codes.delete(mine[0]![0]);
      let code: string;
      do code = [...randomBytes(16)].filter((b) => b < 248).slice(0, 6).map((b) => CODE_ALPHABET[b % 31]).join(''); // 248 = 8 × 31: no bias
      while (code.length < 6 || this.codes.has(code));
      const expires = now + Math.min(Number(m.ttlMs) || CODE_MS, CODE_MS);
      this.codes.set(code, { host, expires });
      return { code, expires };
    }
    const device = typeof m?.device === 'string' && m.device.length <= 128 ? m.device : undefined;
    if (m?.t === 'push.subscribe') {
      const sub = parseSubscription(m.sub, this.pushHosts);
      if (!device || !sub) throw new Error('bad subscription');
      const rec: PushRecord = { host, device, added: now, ...sub };
      // One Expo token per device (a reinstall replaces it); a browser may hold several Web Push subscriptions.
      await this.change((s) => {
        if (!s.hosts.some((h) => h.id === host)) throw new Error('host revoked');
        s.push = [...s.push.filter((p) => !(p.host === host && ('expo' in sub
          ? 'expo' in p && (p.expo === sub.expo || p.device === device)
          : 'web' in p && p.web.endpoint === sub.web.endpoint))), rec];
      });
      return {};
    }
    if (m?.t === 'push.remove') {
      if (!device) throw new Error('bad device');
      const sub = m.sub === undefined ? undefined : parseSubscription(m.sub, this.pushHosts);
      if (m.sub !== undefined && !sub) throw new Error('bad subscription');
      const remaining = await this.change((s) => {
        if (!s.hosts.some((h) => h.id === host)) throw new Error('host revoked');
        s.push = s.push.filter((p) => !(p.host === host && p.device === device
          && (!sub || ('expo' in sub ? 'expo' in p && p.expo === sub.expo : 'web' in p && p.web.endpoint === sub.web.endpoint))));
        return s.push.some((p) => p.host === host && p.device === device && parseSubscription(p, this.pushHosts));
      });
      if (!remaining) for (const [t, v] of this.tokens) if (v.host === host && v.device === device) this.tokens.delete(t);
      return {};
    }
    if (m?.t === 'push.notify') return this.notify(host, m.n);
    throw new Error('unknown request');
  }

  private async notify(host: string, raw: unknown): Promise<object> {
    const n = parseNotification(raw);
    if (!n) throw new Error('bad notification');
    const seen = this.sent.get(host) ?? [];
    // ponytail: remembered in memory, so a relay restart can deliver a retried notification twice.
    if (seen.includes(n.id) || this.pending.get(host)?.has(n.id)) return { sent: 0, duplicate: true };
    const pending = this.pending.get(host) ?? new Set<string>();
    this.pending.set(host, pending);
    pending.add(n.id);
    try {
    const invalid = this.state.push.filter((p) => !parseSubscription(p, this.pushHosts));
    const subs = this.state.push.filter((p) => p.host === host && !invalid.includes(p) && (!n.to || n.to.includes(p.device)));
    const action = new Map<string, string>();
    if (n.actions?.length) {
      const expires = this.now() + (n.ttl ?? 86_400) * 1000;
      for (const device of new Set(subs.map((s) => s.device))) {
        const token = b64url(randomBytes(18));
        action.set(device, token);
        this.tokens.set(token, { host, device, event: n.id, actions: n.actions, expires });
      }
      while (this.tokens.size > 4096) this.tokens.delete(this.tokens.keys().next().value!);
    }
    const { sent, gone } = await deliver({
      subs, n, action, vapid: this.state.vapid!, subject: this.opts.push?.subject ?? 'https://github.com/umeranjum17/byokit',
      fetch: this.opts.push?.fetch ?? fetch, hosts: this.pushHosts,
    });
    if (sent > 0) this.sent.set(host, [...(this.sent.get(host) ?? []), n.id].slice(-DEDUP)); // only once a push service took it, so a retry can succeed
    if (gone.length || invalid.length) {
      const removed = new Set([...gone, ...invalid].map((p) => JSON.stringify(p)));
      await this.change((s) => {
        s.push = s.push.filter((p) => !removed.has(JSON.stringify(p)));
      });
    }
    return { sent };
    } finally {
      pending.delete(n.id);
      if (!pending.size) this.pending.delete(host);
    }
  }

  private lookup(raw: string): string | undefined {
    const code = raw.toUpperCase().replace(/-/g, '');
    const v = this.codes.get(code);
    if (!v || v.expires < this.now()) return undefined;
    return v.host;
  }

  private async action(token: string, action: string): Promise<{ status: number; body: object }> {
    const t = this.tokens.get(token);
    if (!t || t.expires < this.now()) return { status: 404, body: { error: 'no such notification' } };
    if (!t.actions.includes(action)) return { status: 400, body: { error: 'no such action' } };
    const l = this.live.get(t.host);
    if (!l) return { status: 503, body: { error: 'computer offline' } }; // the token stays, so pressing again later works
    this.tokens.delete(token); // one use from here: the host may act on it
    const id = `a${++this.seq}`;
    const answer = await new Promise<Parameters<Waiting['resolve']>[0] | undefined>((resolve) => {
      const timer = later(Math.min(this.opts.actionMs ?? 15_000, 15_000), () => { this.waiting.delete(id); resolve(undefined); });
      this.waiting.set(id, { live: l, resolve: (a) => { clearTimeout(timer); resolve(a); } });
      l.ws.send(JSON.stringify({ t: 'push.action', id, device: t.device, event: t.event, action }));
    });
    if (!answer) return { status: 504, body: { error: 'computer did not answer in time' } };
    return answer.ok ? { status: 200, body: { ok: true, value: answer.value ?? null } } : { status: 502, body: { error: answer.error ?? 'failed' } };
  }
}

function json(res: ServerResponse, status: number, body: object): true {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const parts: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw new Error('too big');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
}

export type { Notification };
