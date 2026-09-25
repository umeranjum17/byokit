// The host: the computer that owns the credentials. It pairs devices (scanned or typed code, then a person says yes),
// keeps one durable grant per device, answers their requests, and removes them. It never listens on anything itself:
// the app hands it WebSockets (`accept`), or one relay socket that carries many devices (`relay`).
import { Handshake, b64url, firstFrame, hostId, random, type Channel, type KeyPair } from './channel.ts';
import { cleanName, codeKey, newCode, normalizeCode, offerText, type PairOffer } from './pairing.ts';
import { PublicLinkError } from './device.ts';

export type Role = 'control' | 'view';
/** One paired device. `key` is its static public key (base64url); `meta` is the app's own (e.g. which person). */
export type Grant = { id: string; key: string; name: string; role: Role; created: number; lastSeen?: number; meta?: unknown };
export type GrantStore = { load(): Grant[] | Promise<Grant[]>; save(grants: Grant[]): void | Promise<void> };
export type LinkRequest = { op: string; args?: unknown };
/** What the person at the host is asked to approve. `words` are on the device's screen too. */
export type PairRequest = { name: string; role: Role; words: string; how: 'scan' | 'code'; meta?: unknown };
/** Anything shaped like a browser WebSocket or a `ws` one. */
export type Socket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, fn: (e: any) => void): void;
};

export type HostOptions = {
  keys: KeyPair;
  /** The name devices show for this computer. */
  name: string;
  /** Answers a device's request. Runs on the host, with the host's credentials; the device only gets the answer. */
  handle: (req: LinkRequest, device: Grant) => unknown;
  /** Asks the person at the host whether this device may join; nothing is stored until it says yes. */
  confirm: (p: PairRequest) => boolean | Promise<boolean>;
  /** Which requests a view-only device may make. Default: none. */
  canView?: (req: LinkRequest) => boolean;
  onError?: (error: unknown) => void;
  grants?: GrantStore;
  maxDevices?: number;
  /** How long a pairing code, and a person's answer, may take. Default five minutes. */
  pairMs?: number;
  now?: () => number;
};

type Conn = { send(text: string): void; close(code: number, reason: string): void };
type Handler = { message(text: string): void; closed(): void };
type Pending = { role: Role; meta?: unknown; expires: number };

const HANDSHAKE_MS = 15_000;
const MAX_TRIES = 5; // wrong codes before every open code is withdrawn
const MAX_ANSWERS = 1000;
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
  private live = new Map<Conn, { dev: Grant; ch: Channel }>();
  private answered = new Map<string, Map<string, { id: number; session: string; reply: Promise<object> }>>();
  private changes: Promise<void> = Promise.resolve();

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
  private async change<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.changes.then(fn);
    this.changes = next.then(() => {}, () => {});
    return next;
  }
  private async save(grants: Grant[]) { await this.store?.save(grants.map((g) => ({ ...g }))); }
  private report(error: unknown) { try { (this.opts.onError ?? console.error)(error); } catch {} }
  private transition(next: (grants: Grant[]) => Grant[] | null, revoke = false): Promise<Grant[] | null> {
    return this.change(async () => {
      const updated = next(this.grants);
      if (!updated) return null;
      await this.save(updated);
      const previous = this.grants;
      this.grants = updated;
      for (const old of previous) {
        const current = updated.find((g) => g.id === old.id);
        if (current) {
          for (const [conn, s] of this.live) if (s.dev.id === old.id) this.live.set(conn, { ...s, dev: current });
          continue;
        }
        this.answered.delete(old.id);
        for (const [conn, s] of this.live) if (s.dev.id === old.id) {
          if (revoke) this.sealed(conn, s.ch, { t: 'revoked' });
          this.live.delete(conn);
          if (revoke) later(1000, () => conn.close(4401, 'removed'));
          else try { conn.close(1001, 'grant changed'); } catch {}
        }
      }
      return updated;
    });
  }

  /** A QR's text for one device. `urls` are where a device can reach this host (direct `ws://`, or a relay's
   *  `wss://…/link/v1/<id>`); `base` makes it a link a browser can open. Single use, gone after `pairMs`. */
  offer(o: { role: Role; urls: string[]; meta?: unknown; base?: string }): { text: string; expires: number } {
    const expires = this.now() + this.pairMs;
    const ticket = b64url(random(16));
    this.tickets.set(ticket, { role: o.role, meta: o.meta, expires });
    this.tries = 0;
    const offer: PairOffer = { v: 1, host: b64url(this.keys.publicKey), name: cleanName(this.opts.name, 'your computer'), urls: o.urls, ticket, expires };
    return { text: offerText(offer, o.base), expires };
  }

  /** A code a person types on the device instead of scanning. Single use, gone after `pairMs`. */
  code(o: { role: Role; meta?: unknown }): { code: string; expires: number } {
    const code = newCode();
    const expires = this.now() + this.pairMs;
    this.codes.set(normalizeCode(code)!, { role: o.role, meta: o.meta, expires });
    this.tries = 0;
    return { code, expires };
  }

  /** Withdraws every open QR and code. */
  stopPairing() { this.tickets.clear(); this.codes.clear(); }

  devices(): (Grant & { online: boolean })[] {
    const online = new Set([...this.live.values()].map((s) => s.dev.id));
    return this.grants.map((g) => ({ ...g, online: online.has(g.id) }));
  }

  /** Adds a device this app already trusts some other way: for moving devices paired under an older protocol onto
   *  this one without pairing again. Only call it with a key that arrived over an authenticated channel. */
  async enrol(g: { key: Uint8Array; name: string; role: Role; meta?: unknown }): Promise<Grant> {
    const added = await this.grant(b64url(g.key), cleanName(g.name, 'Device'), g.role, g.meta);
    if (!added) throw new Error('Your computer has all the devices it allows. Remove one there first.');
    return added;
  }

  /** Removes a device: its grant goes, its open connections close, and its key is refused from now on. */
  async revoke(id: string) {
    await this.transition((grants) => grants.some((g) => g.id === id) ? grants.filter((g) => g.id !== id) : null, true);
  }

  /** An event for every connected device (or those `to` picks). */
  broadcast(e: unknown, to: (g: Grant) => boolean = () => true) {
    for (const [conn, s] of this.live) if (to(s.dev)) this.sealed(conn, s.ch, { t: 'event', e });
  }

  /** One WebSocket, straight from a device. */
  accept(ws: Socket) {
    const h = this.connection({ send: (t) => ws.send(t), close: (c, r) => ws.close(c, r) });
    ws.addEventListener('message', (e) => (typeof e.data === 'string' ? h.message(e.data) : ws.close(4400, 'text frames only')));
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

  close() { for (const conn of this.live.keys()) conn.close(1001, 'host closing'); this.live.clear(); }

  private sealed(conn: Conn, ch: Channel, msg: unknown) {
    try { for (const f of ch.seal(msg)) conn.send(f); } catch { conn.close(4400, 'send failed'); }
  }

  private take(map: Map<string, Pending>, key: string): Pending | undefined {
    const p = map.get(key);
    map.delete(key); // single use, even when it has run out
    return p && p.expires >= this.now() ? p : undefined;
  }

  private wrong() {
    if (++this.tries >= MAX_TRIES) this.stopPairing();
  }

  private async grant(key: string, name: string, role: Role, meta: unknown): Promise<Grant | null> {
    let added: Grant | null = null;
    await this.transition((grants) => {
      if (this.opts.maxDevices && grants.length >= this.opts.maxDevices && !grants.some((g) => g.key === key)) return null;
      const now = this.now();
      added = { id: b64url(random(9)), key, name, role, created: now, lastSeen: now, ...(meta === undefined ? {} : { meta }) };
      return [...grants.filter((g) => g.key !== key), added];
    });
    return added;
  }

  private connection(conn: Conn): Handler {
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
      const req: PairRequest = { name: cleanName(name, 'Device'), role: p.role, words: hs!.words, how, ...(p.meta === undefined ? {} : { meta: p.meta }) };
      const yes = await Promise.race([
        Promise.resolve().then(() => this.opts.confirm(req)).catch(() => false),
        new Promise<false>((r) => later(this.pairMs, () => r(false))),
      ]);
      if (gone) return;
      if (!yes) return refuse('declined');
      try {
        const added = await this.grant(k, req.name, p.role, p.meta);
        if (gone) return;
        if (added) await attach(added, true);
        else refuse('full');
      } catch { if (!gone) refuse('failed'); }
    };

    const attach = async (g: Grant, paired = false) => {
      if (gone) return;
      busy = true;
      try {
        if (!paired) {
          const updated = await this.transition((grants) => grants.some((x) => x.id === g.id)
            ? grants.map((x) => x.id === g.id ? { ...x, lastSeen: this.now() } : x) : null);
          if (!updated) return refuse('not-paired');
          g = updated.find((x) => x.id === g.id)!;
        }
        if (gone) return;
        if (!this.grants.some((x) => x.id === g.id)) return refuse('not-paired');
        dev = g;
        busy = false;
        clearTimeout(timer);
        this.live.set(conn, { dev, ch: ch! });
        this.sealed(conn, ch!, { t: 'ready', device: { id: g.id, name: g.name, role: g.role }, host: { name: this.opts.name } });
      } catch { if (!gone) refuse('failed'); }
    };

    const handshake = (text: string) => {
      if (!hs) {
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

    return {
      message: (text) => {
        if (gone) return;
        try {
          if (!ch) return handshake(text);
          const m = ch.open(text); // throws unless this is the device's next authentic frame
          if (m === undefined || busy) return;
          if (dev) return m.t === 'req' ? void this.request(conn, dev, m) : undefined;
          if (m.t === 'auth') {
            const g = this.grants.find((x) => x.key === b64url(hs!.remoteKey));
            if (g) { this.acknowledge(g.id, m.session, m.ack); void attach(g); }
            else refuse('not-paired');
            return;
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
      closed: () => { gone = true; clearTimeout(timer); this.live.delete(conn); },
    };
  }

  private acknowledge(device: string, session: unknown, ack: unknown) {
    if (typeof session !== 'string' || !Number.isSafeInteger(ack) || (ack as number) < 0) return;
    const seen = this.answered.get(device);
    if (seen) for (const [key, entry] of seen) if (entry.session === session && entry.id <= (ack as number)) seen.delete(key);
  }

  private async request(conn: Conn, dev: Grant, m: any) {
    const id = m.id;
    const answer = (r: object) => { const s = this.live.get(conn); if (s) this.sealed(conn, s.ch, { t: 'res', id, ...r }); };
    const g = this.grants.find((x) => x.id === dev.id);
    if (!g) return answer({ ok: false, error: 'removed' });
    this.acknowledge(g.id, m.session, m.ack);
    const seen = this.answered.get(g.id) ?? new Map<string, { id: number; session: string; reply: Promise<object> }>();
    this.answered.set(g.id, seen);
    const key = typeof m.key === 'string' && m.key.length <= 80 ? m.key : '';
    const session = typeof m.session === 'string' && m.session.length <= 80 ? m.session : '';
    if (!key || !session || !Number.isSafeInteger(id) || id < 1) return answer({ ok: false, error: 'failed' });
    let entry = seen.get(key);
    if (!entry) {
      if (seen.size >= MAX_ANSWERS) return answer({ ok: false, error: 'busy' });
      const req: LinkRequest = { op: String(m.op ?? ''), args: m.args };
      const reply = Promise.resolve().then(async () => {
        try {
          if (g.role !== 'control' && !(this.opts.canView?.(req) ?? false)) return { ok: false, error: 'view-only' };
        } catch (e) { this.report(e); return { ok: false, error: 'view-only' }; }
        try { return { ok: true, value: await this.opts.handle(req, g) }; }
        catch (e) {
          if (e instanceof PublicLinkError) return { ok: false, error: 'public', message: e.message };
          this.report(e);
          return { ok: false, error: 'failed' };
        }
      });
      entry = { id, session, reply };
      seen.set(key, entry);
    }
    answer(await entry.reply);
  }
}
