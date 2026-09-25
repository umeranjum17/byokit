// A device's end of the link: a phone app, a browser page or another computer. It holds its own key and a grant, never
// the host's credentials. It pairs once (scan or typed code), then keeps one socket open, reconnecting on its own, and
// its requests survive a reconnect: each carries a key, so a retried tap runs once. Uses only the platform's
// WebSocket, so the same code runs in browsers, React Native and Node.
import { Handshake, b64, b64url, keyPair, keyPairFrom, random, unb64url, type KeyPair, type Mode } from './channel.ts';
import { cleanName, codeKey, normalizeCode, parseOffer } from './pairing.ts';
import type { Role } from './host.ts';
import { Streams, type LinkStream } from './stream.ts';

/** What a device keeps (in secure storage: it holds the device's secret key). `nextSecretKey` is only there while
 *  a rekey is under way. */
export type DeviceGrant = { v: 1; secretKey: string; nextSecretKey?: string; pendingUntil?: number; host: string; hostName: string; urls: string[]; device: { id: string; name: string; role: Role } };
export type DeviceStore = { save(g: DeviceGrant): void | Promise<void>; clear(): void | Promise<void> };
export type LinkStatus = 'connecting' | 'online' | 'offline' | 'refused' | 'removed';
type WebSocketLike = {
  send(data: string | Uint8Array): void; close(code?: number, reason?: string): void; binaryType?: string;
  onopen: any; onmessage: any; onclose: any; onerror: any;
};
/** `resolve` runs before each connection and returns the address to dial: e.g. open an SSH tunnel to the host and
 *  return `ws://127.0.0.1:<port>/…`. The grant keeps the original address. */
export type Dial = { WebSocket?: new (url: string) => WebSocketLike; timeoutMs?: number; resolve?: (url: string) => string | Promise<string> };

/** Every way the link can fail, in words a person can act on. */
export const LINK_WORDS = {
  unreachable: "Can't reach your computer. Check it's on and connected.",
  'wrong-host': "Something other than your computer answered, so this device didn't connect.",
  'wrong-code': "That code didn't match. Check it, or show a new one on your computer.",
  expired: 'That pairing code has run out. Show a new one on your computer.',
  declined: 'Your computer said no to this device.',
  full: 'Your computer has all the devices it allows. Remove one there first.',
  'not-paired': "Your computer doesn't know this device any more. Pair it again.",
  removed: 'This device was removed on your computer.',
  'view-only': 'This device can watch but not make changes.',
  timeout: "Your computer didn't answer in time.",
  failed: "Your computer couldn't do that.",
  busy: 'Your computer is still catching up. Try again in a moment.',
  stopped: 'This link is stopped. Try connecting again.',
  'not-supported': "The app on your computer can't do this yet. Update it there.",
  ended: "This device's access has run out. Pair it again on your computer.",
  'not-allowed': "This device isn't allowed to do that.",
  'too-late': "That reached your computer too late, so it wasn't done.",
  unsupported: 'Your computer needs an update for that.',
} as const;
export type LinkProblem = keyof typeof LINK_WORDS;

/** A failure with a plain `message` and a `code` for the app. `sealed` means the host said it inside the encrypted
 *  channel, so it is really the host speaking; anything else could come from whoever is on the network. */
export class LinkError extends Error {
  code: LinkProblem;
  sealed: boolean;
  constructor(code: LinkProblem, sealed = false) {
    super(LINK_WORDS[code]);
    this.code = code;
    this.sealed = sealed;
  }
}

export class PublicLinkError extends LinkError {
  constructor(message: string) { super('failed', true); this.message = message; }
}

const known = (why: unknown): why is LinkProblem => typeof why === 'string' && Object.hasOwn(LINK_WORDS, why);
const problem = (why: unknown): LinkProblem => (known(why) ? why : 'unreachable');
const later = (ms: number, fn: () => void) => { const t: any = setTimeout(fn, ms); t.unref?.(); return t; };

type Open = { ready: any; hostKey: Uint8Array; send: (m: unknown) => void; data: (s: number, d: Uint8Array) => void; close: () => void };
type Hello = { t: 'auth'; session: string; ack: number; fresh: boolean } | { t: 'pair'; ticket: string; name: string } | { t: 'code'; name: string };

/** One socket: the handshake, the first request (`auth` or `pair`), and the host's `ready`. */
async function dial(url: string, me: KeyPair, host: { key?: Uint8Array; psk?: Uint8Array }, hello: Hello, o: Dial & { onWords?: (w: string) => void },
  on: { message: (m: any) => void; close: (e: LinkError) => void } = { message: () => {}, close: () => {} }): Promise<Open> {
  let target = url;
  try { if (o.resolve) target = await o.resolve(url); } catch { throw new LinkError('unreachable'); }
  return new Promise((resolve, reject) => {
    const WS = o.WebSocket ?? (globalThis as any).WebSocket;
    const mode: Mode = hello.t === 'code' ? 'code' : 'ik';
    const hs = new Handshake(mode, true, me, { remote: host.key, psk: host.psk });
    const pairing = hello.t !== 'auth';
    let ch: ReturnType<Handshake['channel']> | null = null;
    let up = false;
    let settled = false;
    let ws: WebSocketLike;
    const fail = (e: LinkError) => {
      clearTimeout(timer);
      if (up) on.close(e);
      else if (!settled) reject(e);
      up = false;
      settled = true;
      try { ws.close(); } catch {}
    };
    let timer = later(o.timeoutMs ?? 8000, () => fail(new LinkError('timeout')));
    try { ws = new WS(target); ws.binaryType = 'arraybuffer'; } catch { return fail(new LinkError('unreachable')); }
    let binary = false; // the host said this socket reaches it directly, so stream bytes may go as binary messages
    const send = (m: unknown) => { for (const f of ch!.seal(m)) ws.send(f); };
    const data = (s: number, d: Uint8Array) => { for (const f of ch!.sealData(s, d)) ws.send(binary ? f : b64(f)); };
    ws.onopen = () => ws.send(hs.write(mode === 'ik' ? { v: 1 } : {}));
    ws.onerror = () => fail(new LinkError('unreachable'));
    // Before the handshake finishes nothing is authenticated, so these only choose what to say, never what to forget.
    ws.onclose = (e: any) => fail(new LinkError(ch ? 'unreachable' : e?.code === 4401 && mode === 'code' ? 'wrong-code' : e?.code === 4403 ? 'wrong-host' : 'unreachable'));
    ws.onmessage = (ev: any) => {
      if (settled && !up) return;
      try {
        if (!ch) {
          try { if (typeof ev.data !== 'string') throw new Error('binary'); hs.read(ev.data); } catch { return fail(new LinkError('wrong-host')); } // only the right host can answer
          if (hello.t === 'code') ws.send(hs.write({ name: hello.name }));
          ch = hs.channel();
          if (hello.t !== 'code') send(hello);
          if (pairing) { // now a person at the host decides; give them time
            o.onWords?.(hs.words);
            clearTimeout(timer);
            timer = later(6 * 60_000, () => fail(new LinkError('timeout')));
          }
          return;
        }
        const m = ch.open(typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data)); // throws unless it is the host's next authentic frame
        if (m === undefined) return;
        if (!up && m.t === 'refused') return fail(new LinkError(problem(m.why), true));
        if (!up && m.t === 'ready') {
          up = true;
          settled = true;
          binary = m.binary === 1;
          clearTimeout(timer);
          return resolve({ ready: m, hostKey: hs.remoteKey, send, data, close: () => { up = false; ws.close(); } });
        }
        if (up) on.message(m);
      } catch {
        fail(new LinkError('unreachable'));
      }
    };
  });
}

function granted(me: KeyPair, hostKey: string, url: string, urls: string[], ready: any): DeviceGrant {
  return { v: 1, secretKey: b64url(me.secretKey), host: hostKey, hostName: cleanName(ready.host?.name, 'your computer'), urls: [url, ...urls.filter((u) => u !== url)],
    device: ready.device };
}

type PairOptions = Dial & { name: string; onWords: (w: string) => void; key?: KeyPair };

/** The grant a scanned code will become, to keep in secure storage *before* pairing. If the app dies while the person
 *  at the host decides, a `DeviceLink` made from it later connects once the host has said yes (or learns it said no),
 *  instead of leaving the host holding a grant for a key nobody has. Pass its key to `pairWithOffer`. */
export function pendingGrant(scanned: string, o: { name: string; key?: KeyPair }): DeviceGrant {
  const offer = parseOffer(scanned);
  const me = o.key ?? keyPair();
  return { v: 1, secretKey: b64url(me.secretKey), pendingUntil: offer.expires + 300_000, host: offer.host, hostName: offer.name, urls: offer.urls,
    device: { id: '', name: cleanName(o.name, 'Device'), role: offer.role ?? 'view' } };
}

/** A scanned QR (or opened pairing link) in, a grant out, once the person at the host says yes. `onWords` gets the
 *  two words to show while they decide. Tries each address in the code until one answers. */
export async function pairWithOffer(scanned: string, o: PairOptions): Promise<DeviceGrant> {
  const offer = parseOffer(scanned);
  const me = o.key ?? keyPair();
  let last = new LinkError('unreachable');
  for (const url of offer.urls) {
    try {
      const l = await dial(url, me, { key: unb64url(offer.host) }, { t: 'pair', ticket: offer.ticket, name: o.name }, o);
      l.close();
      return granted(me, offer.host, url, offer.urls, l.ready);
    } catch (e: any) {
      last = e instanceof LinkError ? e : new LinkError('unreachable');
      if (last.code !== 'unreachable' && last.code !== 'timeout' && last.code !== 'wrong-host') break;
    }
  }
  throw last;
}

/** A typed code in, a grant out. `url` is where the host is (a page served by the host knows its own address). */
export async function pairWithCode(url: string, typed: string, o: PairOptions): Promise<DeviceGrant> {
  if (!normalizeCode(typed)) throw new LinkError('wrong-code');
  const me = o.key ?? keyPair();
  const l = await dial(url, me, { psk: codeKey(typed) }, { t: 'code', name: o.name }, o);
  const hostKey = b64url(l.hostKey);
  l.close();
  return granted(me, hostKey, url, [url], l.ready);
}

type Pending = { msg: any; resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: any };
export type LinkOptions = Dial & {
  store?: DeviceStore; onEvent?: (e: unknown) => void; onStatus?: (s: LinkStatus) => void; onError?: (e: unknown) => void;
  /** How often to check a quiet connection is still there (default 20 s); it is dropped after two silent rounds. */
  pingMs?: number;
  /** Requests waiting at once before new ones are refused as busy (default 1000, what a host keeps per device). */
  maxPending?: number;
};
export type RequestOptions = {
  /** Give up waiting after this long. The host may still have done it; a retry is a new request. */
  timeoutMs?: number;
  /** A clock time (ms) after which the host must not start it. */
  notValidAfter?: number;
};

/** The device's live link: connects, reconnects forever with backoff, resends unanswered requests after a reconnect. */
export class DeviceLink {
  grant: DeviceGrant;
  status: LinkStatus = 'connecting';
  private o: LinkOptions;
  private conn: Open | null = null;
  private streams: Streams | null = null;
  private features: string[] = [];
  private pending = new Map<number, Pending>();
  private n = 0;
  private tries = 0;
  private stopped = false;
  private wake: any;
  private connecting: Promise<void> | null = null;
  private readonly session = b64url(random(12));
  private fresh = true;
  private ack = 0;
  private received = new Set<number>();
  private storing: Promise<void> = Promise.resolve();
  private waiting = new Map<string, () => void>(); // 'rekeyed' and 'unpaired'
  private heard = 0;

  constructor(grant: DeviceGrant, o: LinkOptions = {}) {
    this.grant = grant;
    this.o = o;
    void this.connect();
  }

  private set(s: LinkStatus) { if (s !== this.status) { this.status = s; this.o.onStatus?.(s); } }
  private report(e: unknown) { try { (this.o.onError ?? console.error)(e); } catch {} }
  private persist(action: () => void | Promise<void>): Promise<void> {
    const next = this.storing.then(action);
    this.storing = next.catch((e) => this.report(e));
    return next;
  }
  private receivedReply(id: number) {
    this.received.add(id);
    while (this.received.delete(this.ack + 1)) this.ack++;
  }

  private connect(): Promise<void> {
    if (this.stopped || this.conn) return Promise.resolve();
    // The status is set after the attempt is over, so an app can call retry() from onStatus.
    this.connecting ??= this.attempt().then((after) => { this.connecting = null; after(); }, (e) => { this.connecting = null; this.report(e); });
    return this.connecting;
  }

  private async attempt(): Promise<() => void> {
    let wrongHosts = 0;
    let online = false;
    // Mid-rekey, the new key goes first; if the host never took it, the old one still works.
    const keys = [this.grant.nextSecretKey, this.grant.secretKey].filter((k): k is string => !!k);
    urls: for (const url of this.grant.urls) {
      for (const secret of keys) {
        try {
          let active: Open;
          const l = await dial(url, keyPairFrom(unb64url(secret)), { key: unb64url(this.grant.host) }, { t: 'auth', session: this.session, ack: this.ack, fresh: this.fresh }, this.o, {
            message: (m) => { if (this.conn === active) { this.heard = Date.now(); this.message(m); } },
            close: () => { if (this.conn === active) this.lost(); },
          });
          active = l;
          if (this.stopped) { l.close(); return () => {}; }
          this.fresh = false;
          this.conn = l;
          this.streams = l.ready.streams === 1 ? new Streams({ send: l.send, data: l.data, reason: (e) => { this.report(e); return 'failed'; }, report: (e) => this.report(e) }) : null;
          this.heard = Date.now();
          this.features = Array.isArray(l.ready.features) ? l.ready.features : [];
          this.tries = 0;
          const { nextSecretKey, pendingUntil, ...rest } = this.grant;
          this.grant = { ...rest, secretKey: secret, urls: [url, ...this.grant.urls.filter((u) => u !== url)], device: l.ready.device }; // what worked goes first
          const current = this.grant;
          void this.persist(() => this.o.store?.save(current)).catch(() => {});
          for (const [id, p] of this.pending) this.sendPending(l, id, p);
          if (this.features.includes('ping')) this.ping(l);
          online = true;
          break urls;
        } catch (e: any) {
          if (e?.sealed && (e.code === 'not-paired' || e.code === 'ended')) {
            if (secret !== this.grant.secretKey) continue; // the new key was never taken: try the old one
            if (this.grant.pendingUntil && Date.now() < this.grant.pendingUntil) break;
            return () => this.removed();
          }
          if (e?.code === 'wrong-host') wrongHosts++;
          break; // this address is the problem, not the key
        }
      }
    }
    return () => {
      if (this.stopped) return;
      if (online && this.conn) this.set('online');
      else if (wrongHosts > 0 && wrongHosts === this.grant.urls.length) { this.stopped = true; this.set('refused'); }
      else { this.again(); this.set('offline'); }
    };
  }

  private lost() {
    this.drop('unreachable');
    if (!this.stopped && !this.connecting) { this.again(); this.set('offline'); }
  }

  /** A half-open socket (the phone changed networks) looks alive forever; a ping it never answers shows it isn't. */
  private ping(l: Open) {
    const every = this.o.pingMs ?? 20_000;
    let n = 0;
    const tick = () => {
      if (this.conn !== l) return;
      if (Date.now() - this.heard > 2 * every) { l.close(); return this.lost(); }
      try { l.send({ t: 'ping', n: ++n }); } catch {}
      later(every, tick);
    };
    later(every, tick);
  }

  private sendPending(l: Open, id: number, p: Pending) {
    try { l.send(p.msg); } catch {
      this.settle(id);
      p.reject(new Error('Your device could not send that request.'));
    }
  }

  private settle(id: number) {
    const p = this.pending.get(id);
    clearTimeout(p?.timer);
    this.pending.delete(id);
    this.receivedReply(id);
    return p;
  }

  private again() {
    const ms = Math.min(30_000, 1000 * 2 ** this.tries++) * (0.5 + Math.random() / 2);
    this.wake = later(ms, () => void this.connect());
  }

  /** The socket is gone: so are its streams. */
  private drop(why: string) {
    this.conn = null;
    this.streams?.closeAll(why);
    this.streams = null;
  }

  private message(m: any) {
    if (m.t === 'revoked') return this.removed(); // sealed by the host, so it is really the host saying it
    if (this.streams?.message(m)) return;
    if (m.t === 'event') return this.o.onEvent?.(m.e);
    if (m.t === 'rekeyed' || m.t === 'unpaired') return this.waiting.get(m.t)?.();
    const p = m.t === 'res' && this.pending.has(m.id) ? this.settle(m.id) : undefined;
    if (!p) return;
    if (m.ok) p.resolve(m.value);
    else p.reject(m.error === 'public' ? new PublicLinkError(String(m.message)) : new LinkError(problem(m.error), true));
  }

  private removed() {
    this.stopped = true;
    this.conn?.close();
    this.drop('removed');
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(new LinkError('removed', true));
    void this.persist(() => this.o.store?.clear()).catch(() => {});
    this.set('removed');
  }

  /** Asks the host to do `op`. Waits through reconnects (or until `timeoutMs`); resolves only with the host's answer. */
  request(op: string, args?: unknown, o: RequestOptions = {}): Promise<unknown> {
    if (this.status === 'removed') return Promise.reject(new LinkError('removed', true));
    if (this.stopped) return Promise.reject(new LinkError('stopped'));
    if (this.pending.size >= (this.o.maxPending ?? 1000)) return Promise.reject(new LinkError('busy'));
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      const msg = { t: 'req', id, op, args, key: b64url(random(12)), session: this.session, ack: this.ack,
        ...(o.notValidAfter === undefined ? {} : { notValidAfter: o.notValidAfter }) };
      const p: Pending = { msg, resolve, reject };
      if (o.timeoutMs !== undefined) p.timer = later(o.timeoutMs, () => { if (this.pending.get(id) === p) { this.settle(id); reject(new LinkError('timeout')); } });
      this.pending.set(id, p);
      if (this.conn) this.sendPending(this.conn, id, p);
    });
  }

  /** Opens a duplex stream that the host's `stream` handler takes: a terminal pane, a tunnelled connection, a call.
   *  Only while `online`. A stream ends when its connection drops (`onEnd('unreachable')`); open it again on the next
   *  `online`. Host permission refusals reject; errors from the app handler end an opened stream via `onEnd`. */
  async stream(op: string, args?: unknown): Promise<LinkStream> {
    if (this.status === 'removed') throw new LinkError('removed', true);
    if (this.stopped) throw new LinkError('stopped');
    if (!this.conn) throw new LinkError('unreachable');
    if (!this.streams) throw new LinkError('not-supported', true);
    try {
      return await this.streams.open(op, args);
    } catch (e) {
      if (e instanceof Error) throw e;
      if (!known(e)) throw new PublicLinkError(String(e)); // the host app's own words for why not
      throw new LinkError(e, e !== 'unreachable' && e !== 'stopped');
    }
  }

  /** Another address to try, e.g. one found on the home network. A wrong host there simply fails its handshake. */
  addUrl(url: string) {
    if (this.grant.urls.includes(url)) return;
    this.grant = { ...this.grant, urls: [...this.grant.urls, url] };
    const current = this.grant;
    void this.persist(() => this.o.store?.save(current)).catch(() => {});
    if (this.status === 'offline') this.retry();
  }

  private answer(what: 'rekeyed' | 'unpaired', send: () => void, ms = 10_000): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = later(ms, () => { this.waiting.delete(what); resolve(false); });
      this.waiting.set(what, () => { clearTimeout(timer); this.waiting.delete(what); resolve(true); });
      try { send(); } catch { clearTimeout(timer); this.waiting.delete(what); resolve(false); }
    });
  }

  /** Moves this device to a fresh key. The new key is stored before the host hears of it, and the old one keeps working
   *  until the new one has connected, so a crash at any point leaves a key that works. */
  async rekey(): Promise<void> {
    const l = this.conn;
    if (!l) throw new LinkError('unreachable');
    if (!this.features.includes('rekey')) throw new LinkError('unsupported');
    const next = keyPair();
    this.grant = { ...this.grant, nextSecretKey: b64url(next.secretKey) };
    const staged = this.grant;
    await this.persist(() => this.o.store?.save(staged));
    if (!(await this.answer('rekeyed', () => l.send({ t: 'rekey', key: b64url(next.publicKey) })))) throw new LinkError('timeout');
    if (this.conn === l) { this.conn = null; l.close(); }
    await this.connect();
    if (this.grant.nextSecretKey || this.grant.secretKey !== b64url(next.secretKey)) throw new LinkError('failed');
  }

  /** Forgets this computer, and asks it to forget this device. Offline (or with an older computer), only this device
   *  forgets; the computer keeps listing it until someone removes it there. */
  async unpair(): Promise<void> {
    const l = this.conn;
    if (l && this.features.includes('unpair')) await this.answer('unpaired', () => l.send({ t: 'unpair' }));
    this.removed();
    await this.storing;
  }

  /** After `refused` or `offline`: try again now. */
  retry() {
    if (this.status === 'removed' || this.conn) return;
    clearTimeout(this.wake);
    this.stopped = false;
    this.tries = 0;
    this.set('connecting');
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.fresh = true;
    this.ack = this.n;
    this.received.clear();
    clearTimeout(this.wake);
    const conn = this.conn;
    this.drop('stopped');
    conn?.close();
    for (const [id, p] of [...this.pending]) { clearTimeout(p.timer); this.pending.delete(id); p.reject(new LinkError('stopped')); }
  }
}
