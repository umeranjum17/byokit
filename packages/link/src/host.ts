// The host: the computer that owns the credentials. It pairs devices (scanned or typed code, then a person says yes),
// keeps one durable grant per device, answers their requests, and removes them. It never listens on anything itself:
// the app hands it WebSockets (`accept`), or one relay socket that carries many devices (`relay`).
import { Handshake, b64, b64url, firstFrame, hostId, messageBytes, random, unb64url, type Channel, type KeyPair } from './channel.ts';
import { cleanName, codeKey, newCode, normalizeCode, offerText, type PairOffer } from './pairing.ts';
import { PublicLinkError } from './device.ts';
import { MAX_STREAMS, Streams, type LinkStream } from './stream.ts';

export type Role = 'control' | 'view';
/** One paired device. `key` is its static public key (base64url); `kind` is the app's own label (e.g. `browser`,
 *  `peer`) for per-kind caps; `expires` ends its access (absent: until removed); `meta` is the app's own. */
export type Grant = {
  id: string; key: string; name: string; role: Role; created: number; lastSeen?: number;
  kind?: string; expires?: number; nextKey?: string; meta?: unknown;
};
export type GrantStore = { load(): Grant[] | Promise<Grant[]>; save(grants: Grant[]): void | Promise<void> };
/** Keeps answers across host restarts, so a request retried after one still runs once. `drop` without keys drops
 *  every answer for that device. Stored answers are small JSON objects. */
export type AnswerStore = {
  get(device: string, key: string): unknown | Promise<unknown>;
  put(device: string, key: string, answer: object): void | Promise<void>;
  drop(device: string, keys?: string[]): void | Promise<void>;
};
export type LinkRequest = { op: string; args?: unknown; key?: string };
/** What the person at the host is asked to approve. `words` are on the device's screen too. */
export type PairRequest = { name: string; role: Role; words: string; how: 'scan' | 'code'; kind?: string; lifetime?: number; meta?: unknown };
/** Anything shaped like a browser WebSocket or a `ws` one. */
export type Socket = {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (e: any) => void): void;
};
/** How a grant is made: its role, and optionally its kind, how long its access lasts (ms) and the app's own data. */
export type GrantTerms = { role: Role; kind?: string; lifetime?: number; meta?: unknown };

export type HostOptions = {
  keys: KeyPair;
  /** The name devices show for this computer. */
  name: string;
  /** Answers a device's request. Runs on the host, with the host's credentials; the device only gets the answer. */
  handle: (req: LinkRequest, device: Grant) => unknown;
  /** Asks the person at the host whether this device may join; nothing is stored until it says yes. */
  confirm: (p: PairRequest) => boolean | Promise<boolean>;
  /** Takes a stream a device opened with `link.stream(op, args)` (a terminal pane, a tunnelled connection, a call):
   *  set `onData` and `onEnd`, `write`, `end`. The stream opens before this handler runs; a thrown
   *  `PublicLinkError` ends it with a message for the device, while other errors go to `onError` and end it with
   *  `failed`. `device` is the authenticated grant. Without this, devices are told this host has no streams. */
  stream?: (s: LinkStream, req: LinkRequest, device: Grant) => void | Promise<void>;
  /** Decides every request or stream before the app handles it. When absent, control devices may do anything
   *  and view-only devices only what `canView` allows. */
  allow?: (req: LinkRequest, device: Grant) => boolean | Promise<boolean>;
  /** Which requests and streams a view-only device may open when there is no `allow`. Default: none. */
  canView?: (req: LinkRequest) => boolean;
  onError?: (error: unknown) => void;
  grants?: GrantStore;
  answers?: AnswerStore;
  maxDevices?: number;
  /** At most this many devices of each kind, e.g. `{ peer: 16 }`. */
  caps?: Record<string, number>;
  /** New handshakes allowed per minute, in all and per `peer` given to `accept`. Default 300 and 30. */
  handshakes?: { perMinute?: number; perPeer?: number };
  /** How long a pairing code, and a person's answer, may take. At most (and by default) five minutes. */
  pairMs?: number;
  /** The clock, for tests. */
  now?: () => number;
};

/** `binary` sends a binary WebSocket message: only on a direct socket, since a relay's wrapper is text. */
type Conn = { send(text: string): void; binary?: (bytes: Uint8Array) => void; close(code: number, reason: string): void };
type Handler = { message(frame: string | Uint8Array): void; closed(): void };
type Pending = GrantTerms & { expires: number };
type Answer = { id: number; session: string; reply: Promise<object> };

const HANDSHAKE_MS = 15_000;
const MAX_TRIES = 5; // wrong codes before every open code is withdrawn
const MAX_ANSWERS = 1000;
const MAX_TIMER = 2 ** 31 - 1; // setTimeout's limit (about 24 days)
/** What a 0.3 host understands beyond 0.1, told to devices in `ready`. */
export const FEATURES = ['ping', 'unpair', 'rekey'];
class PairExpired extends Error {}
const later = (ms: number, fn: () => void) => { const t: any = setTimeout(fn, ms); t.unref?.(); return t; };

export class Host {
  readonly keys: KeyPair;
  /** This host's address on a relay. */
  readonly id: string;
  private opts: HostOptions;
  private grants: Grant[];
  private store?: GrantStore;
  private tickets = new Map<string, Pending>();
  private codes = new Map<string, Pending>();
  private tries = 0;
  private live = new Map<Conn, { dev: Grant; ch: Channel; streams: Streams }>();
  private answered = new Map<string, Map<string, Answer>>();
  private changes: Promise<void> = Promise.resolve();
  private recent = new Map<string, number[]>(); // handshake times, per peer and in all ('')

  private constructor(opts: HostOptions, grants: Grant[]) {
    this.opts = opts;
    this.keys = opts.keys;
    this.id = hostId(opts.keys.publicKey);
    this.store = opts.grants;
    this.grants = grants;
  }

  static async open(opts: HostOptions): Promise<Host> {
    return new Host(opts, [...((await opts.grants?.load()) ?? [])]);
  }

  private now() { return this.opts.now?.() ?? Date.now(); }
  private get pairMs() { return Math.min(this.opts.pairMs ?? 300_000, 300_000); }
  private ended(g: Grant) { return g.expires !== undefined && g.expires <= this.now(); }
  private async change<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.changes.then(fn);
    this.changes = next.then(() => {}, () => {});
    return next;
  }
  private async save(grants: Grant[]) { await this.store?.save(grants.map((g) => ({ ...g }))); }
  private report(error: unknown) { try { (this.opts.onError ?? console.error)(error); } catch {} }
  private drop(device: string, keys?: string[]) {
    if (!keys) this.answered.delete(device);
    if (this.opts.answers && (!keys || keys.length)) void Promise.resolve().then(() => this.opts.answers!.drop(device, keys)).catch((e) => this.report(e));
  }

  /** Every grant change goes through here, one at a time: store first, then memory, then the live sockets. */
  private transition(next: (grants: Grant[]) => Grant[] | null, why?: 'revoked' | 'ended'): Promise<Grant[] | null> {
    return this.change(async () => {
      const updated = next(this.grants);
      if (!updated) return null;
      await this.save(updated);
      const previous = this.grants;
      this.grants = updated;
      for (const old of previous) {
        const current = updated.find((g) => g.id === old.id);
        if (current && current.key === old.key && current.role === old.role) {
          for (const [conn, s] of this.live) if (s.dev.id === old.id) this.live.set(conn, { ...s, dev: current });
          continue;
        }
        if (!current) this.drop(old.id);
        for (const [conn, s] of this.live) if (s.dev.id === old.id) {
          this.live.delete(conn);
          s.streams.closeAll(why ? 'removed' : 'unreachable');
          if (why) {
            this.sealed(conn, s.ch, { t: 'revoked', why });
            later(1000, () => conn.close(4401, 'removed')); // some platforms surface a close before a frame sent just ahead of it
          } else try { conn.close(1001, 'grant changed'); } catch {}
        }
      }
      return updated;
    });
  }

  private pending(o: GrantTerms): Pending {
    this.checkLifetime(o.lifetime);
    return { role: o.role, expires: this.now() + this.pairMs,
      ...(o.kind === undefined ? {} : { kind: String(o.kind) }), ...(o.lifetime === undefined ? {} : { lifetime: o.lifetime }), ...(o.meta === undefined ? {} : { meta: o.meta }) };
  }

  /** A QR's text for one device. `urls` are where a device can reach this host (direct `ws://`, or a relay's
   *  `wss://…/link/v1/<id>`); `base` makes it a link a browser can open. Single use, gone after `pairMs`. */
  offer(o: GrantTerms & { urls: string[]; base?: string }): { text: string; expires: number } {
    const p = this.pending(o);
    const ticket = b64url(random(16));
    this.tickets.set(ticket, p);
    this.tries = 0;
    const offer: PairOffer = { v: 1, host: b64url(this.keys.publicKey), name: cleanName(this.opts.name, 'your computer'), urls: o.urls, ticket,
      expires: p.expires, role: p.role, ...(p.lifetime === undefined ? {} : { lifetime: p.lifetime }) };
    return { text: offerText(offer, o.base), expires: p.expires };
  }

  /** A code a person types on the device instead of scanning. Single use, gone after `pairMs`. */
  code(o: GrantTerms): { code: string; expires: number } {
    const code = newCode();
    const p = this.pending(o);
    this.codes.set(normalizeCode(code)!, p);
    this.tries = 0;
    return { code, expires: p.expires };
  }

  /** Withdraws every open QR and code. */
  stopPairing() { this.tickets.clear(); this.codes.clear(); }

  devices(): (Grant & { online: boolean })[] {
    const online = new Set([...this.live.values()].map((s) => s.dev.id));
    return this.grants.map((g) => ({ ...g, online: online.has(g.id) }));
  }

  /** Adds a device this app already trusts some other way: for moving devices paired under an older protocol onto
   *  this one without pairing again. Only call it with a key that arrived over an authenticated channel. */
  async enrol(g: GrantTerms & { key: Uint8Array; name: string }): Promise<Grant> {
    const added = await this.grant(b64url(g.key), cleanName(g.name, 'Device'), g);
    if (!added) throw new Error('Your computer has all the devices it allows. Remove one there first.');
    return added;
  }

  /** Removes a device: its grant goes, its open connections close, and its key is refused from now on. */
  async revoke(id: string, why: 'revoked' | 'ended' = 'revoked') {
    await this.transition((grants) => grants.some((g) => g.id === id) ? grants.filter((g) => g.id !== id) : null, why);
  }

  /** An event for every connected device (or those `to` picks). */
  broadcast(e: unknown, to: (g: Grant) => boolean = () => true) {
    for (const [conn, s] of this.live) if (to(s.dev) && !this.ended(s.dev)) this.sealed(conn, s.ch, { t: 'event', e });
  }

  /** One WebSocket, straight from a device. `peer` (e.g. its IP address) lets the host slow down one noisy source. */
  accept(ws: Socket, o: { peer?: string } = {}) {
    const h = this.connection({ send: (t) => ws.send(t), binary: (b) => ws.send(b), close: (c, r) => ws.close(c, r) }, o.peer);
    ws.addEventListener('message', (e) => {
      const d = e.data;
      if (typeof d === 'string') return h.message(d);
      if (d instanceof ArrayBuffer) return h.message(new Uint8Array(d));
      if (ArrayBuffer.isView(d)) return h.message(new Uint8Array(d.buffer, d.byteOffset, d.byteLength)); // ws's Buffer
      ws.close(4400, 'unexpected frame');
    });
    ws.addEventListener('close', () => h.closed());
  }

  /** One WebSocket to a relay that carries many devices' connections. Each relay message is `{c, f}` (connection id,
   *  one frame, exactly as a device sent it or should get it) or `{c, end: code}`. The relay sees only that. */
  relay(ws: Socket) {
    const conns = new Map<string, Handler>();
    ws.addEventListener('message', (e) => {
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (typeof m?.c !== 'string' || m.c.length > 64) return;
      let h = conns.get(m.c);
      if (m.end !== undefined) { h?.closed(); conns.delete(m.c); return; }
      if (typeof m.f !== 'string') return;
      if (!h) {
        const c = m.c;
        h = this.connection({
          send: (f) => ws.send(JSON.stringify({ c, f })),
          close: (code) => { if (conns.delete(c)) { ws.send(JSON.stringify({ c, end: code })); h!.closed(); } },
        });
        conns.set(c, h);
      }
      h.message(m.f);
    });
    ws.addEventListener('close', () => { for (const h of conns.values()) h.closed(); conns.clear(); });
  }

  close() {
    for (const [conn, { streams }] of this.live) {
      streams.closeAll('unreachable');
      conn.close(1001, 'host closing');
    }
    this.live.clear();
  }

  private sealed(conn: Conn, ch: Channel, msg: unknown) { this.out(conn, () => ch.seal(msg)); }

  private out(conn: Conn, frames: () => string[]) {
    try { for (const f of frames()) conn.send(f); } catch { conn.close(4400, 'send failed'); }
  }

  /** What the device hears when the app's stream code throws: a `PublicLinkError`'s message, else `failed`. */
  private reason(e: unknown): string {
    if (e instanceof PublicLinkError) return e.message.slice(0, 200);
    this.report(e);
    return 'failed';
  }

  private take(map: Map<string, Pending>, key: string): Pending | undefined {
    const p = map.get(key);
    map.delete(key); // single use, even when it has run out
    return p && p.expires >= this.now() ? p : undefined;
  }

  private wrong() {
    if (++this.tries >= MAX_TRIES) this.stopPairing();
  }

  /** A sliding one-minute window, in all and per peer; checked before any key agreement is spent on a stranger. */
  private admit(peer?: string): boolean {
    const now = Date.now();
    const limits: [string, number][] = [['', this.opts.handshakes?.perMinute ?? 300]];
    if (peer) limits.push([`peer:${peer}`, this.opts.handshakes?.perPeer ?? 30]);
    for (const [k, times] of this.recent) {
      const fresh = times.filter((t) => t > now - 60_000);
      if (fresh.length) this.recent.set(k, fresh);
      else this.recent.delete(k);
    }
    const windows = limits.map(([k, max]) => {
      const w = this.recent.get(k) ?? [];
      this.recent.set(k, w);
      return [w, max] as const;
    });
    if (windows.some(([w, max]) => w.length >= max)) return false;
    for (const [w] of windows) w.push(now);
    return true;
  }

  private checkLifetime(lifetime?: number) {
    if (lifetime !== undefined && (!Number.isSafeInteger(lifetime) || lifetime <= 0)) throw new Error('A lifetime must be a positive whole number of milliseconds.');
  }

  private async grant(key: string, name: string, t: GrantTerms, pairExpires?: number): Promise<Grant | null> {
    this.checkLifetime(t.lifetime);
    let added: Grant | null = null;
    await this.transition((grants) => {
      if (pairExpires !== undefined && pairExpires < this.now()) throw new PairExpired();
      const others = grants.filter((g) => g.key !== key && g.nextKey !== key); // pairing the same device again replaces its grant
      if (this.opts.maxDevices && others.length >= this.opts.maxDevices) return null;
      const cap = t.kind === undefined ? undefined : this.opts.caps?.[t.kind];
      if (cap !== undefined && others.filter((g) => g.kind === t.kind).length >= cap) return null;
      const now = this.now();
      added = { id: b64url(random(9)), key, name, role: t.role, created: now, lastSeen: now,
        ...(t.kind === undefined ? {} : { kind: t.kind }), ...(t.lifetime === undefined ? {} : { expires: now + t.lifetime }), ...(t.meta === undefined ? {} : { meta: t.meta }) };
      return [...others, added];
    });
    // A slow store can commit after the code ran out: the five-minute life holds through the save too.
    if (added && pairExpires !== undefined && pairExpires < this.now()) {
      await this.revoke((added as Grant).id);
      throw new PairExpired();
    }
    return added;
  }

  private connection(conn: Conn, peer?: string): Handler {
    let hs: Handshake | null = null;
    let ch: Channel | null = null;
    let dev: Grant | null = null;
    let code: Pending | undefined;
    let busy = false; // waiting for the person at the host
    let gone = false;
    const timer = later(HANDSHAKE_MS, () => { if (!dev && !busy) end(4408, 'too slow'); });
    const end = (c: number, why: string) => { if (!gone) conn.close(c, why); };
    const refuse = (why: string) => { this.sealed(conn, ch!, { t: 'refused', why }); later(1000, () => end(4401, why)); };

    const pair = async (key: Uint8Array, name: unknown, p: Pending, how: 'scan' | 'code') => {
      const k = b64url(key);
      busy = true;
      clearTimeout(timer);
      const req: PairRequest = { name: cleanName(name, 'Device'), role: p.role, words: hs!.words, how,
        ...(p.kind === undefined ? {} : { kind: p.kind }), ...(p.lifetime ? { lifetime: p.lifetime } : {}), ...(p.meta === undefined ? {} : { meta: p.meta }) };
      const yes = await Promise.race([
        Promise.resolve().then(() => this.opts.confirm(req)).catch(() => false),
        new Promise<false>((r) => later(this.pairMs, () => r(false))),
      ]);
      if (gone) return;
      if (!yes) return refuse('declined');
      try {
        const added = await this.grant(k, req.name, p, p.expires);
        if (gone) return;
        if (added) await attach(added, true);
        else refuse('full');
      } catch (e) { if (!gone) refuse(e instanceof PairExpired ? 'expired' : 'failed'); }
    };

    const attach = async (g: Grant, paired = false) => {
      if (gone) return;
      busy = true;
      try {
        if (!paired) {
          const key = b64url(hs!.remoteKey);
          // A device that rekeyed proves its new key by using it; from then on only that key works.
          const updated = await this.transition((grants) => {
            const current = grants.find((x) => x.id === g.id);
            if (!current || (current.key !== key && current.nextKey !== key)) return null;
            return grants.map((x) => {
              if (x.id !== g.id) return x;
              const { nextKey, ...rest } = x;
              return nextKey === key ? { ...rest, key, lastSeen: this.now() } : { ...x, lastSeen: this.now() };
            });
          });
          if (!updated) return refuse('not-paired');
          g = updated.find((x) => x.id === g.id)!;
        }
        if (gone) return;
        const current = this.grants.find((x) => x.id === g.id);
        if (!current) return refuse('not-paired');
        if (this.ended(current)) {
          void this.revoke(current.id, 'ended').catch((e) => this.report(e));
          return refuse('ended');
        }
        dev = g = current;
        busy = false;
        clearTimeout(timer);
        const c = ch!;
        const data = conn.binary
          ? (s: number, d: Uint8Array) => { try { for (const f of c.sealData(s, d)) conn.binary!(f); } catch { conn.close(4400, 'send failed'); } }
          : (s: number, d: Uint8Array) => this.out(conn, () => c.sealData(s, d).map(b64));
        const streams = new Streams({ send: (m) => this.sealed(conn, c, m), data, reason: (e) => this.reason(e), report: (e) => this.report(e) });
        this.live.set(conn, { dev, ch: c, streams });
        this.sealed(conn, c, { t: 'ready', device: { id: g.id, name: g.name, role: g.role }, host: { name: this.opts.name }, features: FEATURES,
          ...(g.expires === undefined ? {} : { expires: g.expires }),
          ...(this.opts.stream ? { streams: 1, ...(conn.binary ? { binary: 1 } : {}) } : {}) });
        if (g.expires !== undefined) watch(g.id);
      } catch { if (!gone) refuse('failed'); }
    };

    // Access that runs out ends like a removal, with the socket still open when it does.
    const watch = (id: string) => {
      const g = this.grants.find((x) => x.id === id);
      if (gone || !g || g.expires === undefined || !this.live.has(conn)) return;
      if (this.ended(g)) return void this.revoke(id, 'ended').catch((e) => this.report(e));
      later(Math.min(g.expires - this.now(), MAX_TIMER), () => watch(id));
    };

    const handshake = (text: string) => {
      if (!hs) {
        if (!this.admit(peer)) return end(4429, 'slow down');
        const first = firstFrame(text);
        if (first.mode === 'ik') {
          hs = new Handshake('ik', false, this.keys);
          let hello: any;
          try { hello = hs.read(first.body); } catch { return end(4403, 'wrong host key'); } // dialled for another key
          if (hello.v !== 1) throw new Error('unknown version');
          conn.send(hs.write());
          ch = hs.channel();
          return;
        }
        // A typed code: whichever open code finishes the handshake is the one this device holds.
        for (const [c, p] of this.codes) {
          const attempt = new Handshake('code', false, this.keys, { psk: codeKey(c) });
          try { attempt.read(first.body); } catch { continue; }
          this.codes.delete(c); // single use from the moment it is tried
          if (p.expires < this.now()) break;
          hs = attempt;
          code = p;
          conn.send(hs.write());
          return;
        }
        this.wrong();
        return end(4401, 'wrong code');
      }
      const hello = hs.read(text); // the typed-code handshake's last message: the device's key and name
      ch = hs.channel();
      void pair(hs.remoteKey, hello.name, code!, 'code');
    };

    const inner = (d: Grant, m: any) => {
      if (m.t === 'req') return void this.request(conn, d, m, b64url(hs!.remoteKey));
      if (m.t === 'ping') return this.sealed(conn, ch!, { t: 'pong', n: m.n });
      if (m.t === 'unpair') { // the device forgets this computer, and asks it to forget the device too
        this.live.delete(conn); // so the removal below leaves this socket open for the answer
        return void this.transition((grants) => grants.some((g) => g.id === d.id) ? grants.filter((g) => g.id !== d.id) : null)
          .then(() => { this.sealed(conn, ch!, { t: 'unpaired' }); later(1000, () => end(1000, 'unpaired')); })
          .catch((e) => {
            this.report(e);
            const current = this.grants.find((g) => g.id === d.id);
            if (current) this.live.set(conn, { dev: current, ch: ch! });
            this.sealed(conn, ch!, { t: 'unpair-failed' });
          });
      }
      if (m.t === 'rekey') { // a fresh device key, valid alongside the old one until the device first uses it
        let key: string;
        try { key = b64url(unb64url(String(m.key))); if (unb64url(key).length !== 32) throw new Error(); } catch { return end(4400, 'bad key'); }
        return void this.transition((grants) => grants.some((g) => g.id === d.id) ? grants.map((g) => g.id === d.id ? { ...g, nextKey: key } : g) : null)
          .then((ok) => { if (ok) this.sealed(conn, ch!, { t: 'rekeyed' }); })
          .catch((e) => { this.report(e); end(4400, 'failed'); });
      }
    };

    return {
      message: (text) => {
        if (gone) return;
        try {
          if (!ch) return typeof text === 'string' ? handshake(text) : end(4400, 'text frames only');
          const m = ch.open(text); // throws unless this is the device's next authentic frame
          if (m === undefined || busy) return;
          if (dev) {
            if (m.t === 'open') return this.openStream(dev, this.live.get(conn)!.streams, m);
            if (this.live.get(conn)?.streams.message(m)) return;
            return inner(dev, m);
          }
          if (m.t === 'auth') {
            const k = b64url(hs!.remoteKey);
            const g = this.grants.find((x) => x.key === k || x.nextKey === k);
            if (!g) return refuse('not-paired');
            if (this.ended(g)) { void this.revoke(g.id, 'ended').catch((e) => this.report(e)); return refuse('ended'); }
            if (m.fresh === true) this.drop(g.id);
            else this.acknowledge(g.id, m.session, m.ack);
            return void attach(g);
          }
          if (m.t === 'pair' && hs!.mode === 'ik') {
            const p = typeof m.ticket === 'string' ? this.take(this.tickets, m.ticket) : undefined;
            if (!p) { this.wrong(); return refuse('expired'); }
            return void pair(hs!.remoteKey, m.name, p, 'scan');
          }
          end(4400, 'unexpected');
        } catch {
          end(4400, 'bad frame'); // a bad frame ends the socket; the device reconnects with a fresh handshake
        }
      },
      closed: () => { gone = true; clearTimeout(timer); this.live.get(conn)?.streams.closeAll('unreachable'); this.live.delete(conn); },
    };
  }

  private openStream(dev: Grant, streams: Streams, m: any) {
    const id = m.s, credit = m.credit;
    if (!Number.isInteger(id) || id < 1 || id > 2 ** 32 - 1 || streams.has(id) || !Number.isInteger(credit) || credit < 0) throw new Error('bad stream message');
    const s = streams.add(id, String(m.op ?? ''), m.args);
    const g = this.grants.find((x) => x.id === dev.id);
    const req: LinkRequest = { op: s.op, args: s.args };
    let viewable = false;
    try { viewable = g?.role === 'control' || (this.opts.canView?.(req) ?? false); } catch (e) { this.report(e); }
    const why = !this.opts.stream ? 'not-supported' : !g ? 'removed' : streams.size > MAX_STREAMS ? 'busy' : !viewable ? 'view-only' : undefined;
    if (why) return s.end(why);
    s.accept(Math.min(credit, 2 ** 31));
    void Promise.resolve().then(() => this.opts.stream!(s, req, g!)).catch((e) => s.end(this.reason(e)));
  }

  private acknowledge(device: string, session: unknown, ack: unknown) {
    if (typeof session !== 'string' || !Number.isSafeInteger(ack) || (ack as number) < 0) return;
    const seen = this.answered.get(device);
    const gone: string[] = [];
    if (seen) for (const [key, entry] of seen) if (entry.session === session && entry.id <= (ack as number)) { seen.delete(key); gone.push(key); }
    this.drop(device, gone);
  }

  private async request(conn: Conn, dev: Grant, m: any, authenticatedKey: string) {
    const id = m.id;
    const answer = (r: object) => { const s = this.live.get(conn); if (s) this.sealed(conn, s.ch, { t: 'res', id, ...r }); };
    const g = this.grants.find((x) => x.id === dev.id);
    if (!g || (g.key !== authenticatedKey && g.nextKey !== authenticatedKey)) return answer({ ok: false, error: 'removed' });
    if (this.ended(g)) { answer({ ok: false, error: 'ended' }); return void this.revoke(g.id, 'ended').catch((e) => this.report(e)); }
    this.acknowledge(g.id, m.session, m.ack);
    const seen = this.answered.get(g.id) ?? new Map<string, Answer>();
    this.answered.set(g.id, seen);
    const key = typeof m.key === 'string' && m.key.length <= 80 ? m.key : '';
    const session = typeof m.session === 'string' && m.session.length <= 80 ? m.session : '';
    if (!key || !session || !Number.isSafeInteger(id) || id < 1) return answer({ ok: false, error: 'failed' });
    let entry = seen.get(key);
    if (!entry) {
      if (seen.size >= MAX_ANSWERS) return answer({ ok: false, error: 'busy' });
      const req: LinkRequest = { op: String(m.op ?? ''), args: m.args, key: `${g.id}:${key}` };
      const store = this.opts.answers;
      const reply = Promise.resolve().then(async (): Promise<object> => {
        if (store) {
          let kept: unknown;
          try { kept = await store.get(g.id, key); } catch (e) { this.report(e); return { ok: false, error: 'failed' }; } // unknown: never run twice
          if (kept && typeof kept === 'object') return kept;
        }
        const result = await this.run(req, g, m.notValidAfter);
        if (store) try { await store.put(g.id, key, result); } catch (e) { this.report(e); }
        return result;
      });
      entry = { id, session, reply };
      seen.set(key, entry);
    }
    const reply = await entry.reply;
    const current = this.grants.find((x) => x.id === g.id);
    if (!current || current.key !== g.key || current.role !== g.role || (current.key !== authenticatedKey && current.nextKey !== authenticatedKey)) return answer({ ok: false, error: 'removed' });
    if (this.ended(current)) {
      answer({ ok: false, error: 'ended' });
      return void this.revoke(current.id, 'ended').catch((e) => this.report(e));
    }
    answer(reply);
  }

  private async run(req: LinkRequest, g: Grant, notValidAfter: unknown): Promise<object> {
    const checked = (result: object) => {
      const snapshot = JSON.parse(JSON.stringify(result));
      messageBytes({ t: 'res', id: 0, ...snapshot });
      return snapshot;
    };
    // A request that arrives after the moment its sender said it stops making sense is not run at all.
    if (typeof notValidAfter === 'number' && this.now() > notValidAfter) return { ok: false, error: 'too-late' };
    try {
      const ok = this.opts.allow ? await this.opts.allow(req, g) : g.role === 'control' || (this.opts.canView?.(req) ?? false);
      if (ok !== true) return { ok: false, error: g.role === 'control' ? 'not-allowed' : 'view-only' };
    } catch (e) { this.report(e); return { ok: false, error: g.role === 'control' ? 'not-allowed' : 'view-only' }; }
    const current = this.grants.find((x) => x.id === g.id);
    if (!current || this.ended(current) || current.key !== g.key || current.role !== g.role) return { ok: false, error: 'removed' };
    if (typeof notValidAfter === 'number' && this.now() > notValidAfter) return { ok: false, error: 'too-late' };
    try { return checked({ ok: true, value: await this.opts.handle(req, current) }); }
    catch (e) {
      if (e instanceof PublicLinkError) {
        try { return checked({ ok: false, error: 'public', message: e.message }); }
        catch (invalid) { e = invalid; }
      }
      this.report(e);
      return { ok: false, error: 'failed' };
    }
  }
}
