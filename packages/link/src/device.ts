// A device's end of the link: a phone app, a browser page or another computer. It holds its own key and a grant, never
// the host's credentials. It pairs once (scan or typed code), then keeps one socket open, reconnecting on its own, and
// its requests survive a reconnect: each carries a key, so a retried tap runs once. Uses only the platform's
// WebSocket, so the same code runs in browsers, React Native and Node.
import { Handshake, b64url, keyPair, keyPairFrom, random, unb64url, type KeyPair, type Mode } from './channel.ts';
import { cleanName, codeKey, normalizeCode, parseOffer } from './pairing.ts';
import type { Role } from './host.ts';

/** What a device keeps (in secure storage: it holds the device's secret key). */
export type DeviceGrant = { v: 1; secretKey: string; host: string; hostName: string; urls: string[]; device: { id: string; name: string; role: Role } };
export type DeviceStore = { save(g: DeviceGrant): void | Promise<void>; clear(): void | Promise<void> };
export type LinkStatus = 'connecting' | 'online' | 'offline' | 'refused' | 'removed';
type WebSocketLike = {
  send(data: string): void; close(code?: number, reason?: string): void;
  onopen: any; onmessage: any; onclose: any; onerror: any;
};
export type Dial = { WebSocket?: new (url: string) => WebSocketLike; timeoutMs?: number };

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

const known = (why: unknown): why is LinkProblem => typeof why === 'string' && Object.hasOwn(LINK_WORDS, why);
const problem = (why: unknown): LinkProblem => (known(why) ? why : 'unreachable');
const later = (ms: number, fn: () => void) => { const t: any = setTimeout(fn, ms); t.unref?.(); return t; };

type Open = { ready: any; hostKey: Uint8Array; send: (m: unknown) => void; close: () => void };
type Hello = { t: 'auth' } | { t: 'pair'; ticket: string; name: string } | { t: 'code'; name: string };

/** One socket: the handshake, the first request (`auth` or `pair`), and the host's `ready`. */
function dial(url: string, me: KeyPair, host: { key?: Uint8Array; psk?: Uint8Array }, hello: Hello, o: Dial & { onWords?: (w: string) => void },
  on: { message: (m: any) => void; close: (e: LinkError) => void } = { message: () => {}, close: () => {} }): Promise<Open> {
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
    try { ws = new WS(url); } catch { return fail(new LinkError('unreachable')); }
    const send = (m: unknown) => { for (const f of ch!.seal(m)) ws.send(f); };
    ws.onopen = () => ws.send(hs.write(mode === 'ik' ? { v: 1 } : {}));
    ws.onerror = () => fail(new LinkError('unreachable'));
    // Before the handshake finishes nothing is authenticated, so these only choose what to say, never what to forget.
    ws.onclose = (e: any) => fail(new LinkError(ch ? 'unreachable' : e?.code === 4401 && mode === 'code' ? 'wrong-code' : e?.code === 4403 ? 'wrong-host' : 'unreachable'));
    ws.onmessage = (ev: any) => {
      if (settled && !up) return;
      try {
        if (!ch) {
          try { hs.read(String(ev.data)); } catch { return fail(new LinkError('wrong-host')); } // only the right host can answer
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
        const m = ch.open(String(ev.data)); // throws unless it is the host's next authentic frame
        if (m === undefined) return;
        if (!up && m.t === 'refused') return fail(new LinkError(problem(m.why), true));
        if (!up && m.t === 'ready') {
          up = true;
          settled = true;
          clearTimeout(timer);
          return resolve({ ready: m, hostKey: hs.remoteKey, send, close: () => { up = false; ws.close(); } });
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

/** A scanned QR (or opened pairing link) in, a grant out, once the person at the host says yes. `onWords` gets the
 *  two words to show while they decide. Tries each address in the code until one answers. */
export async function pairWithOffer(scanned: string, o: Dial & { name: string; onWords: (w: string) => void }): Promise<DeviceGrant> {
  const offer = parseOffer(scanned);
  const me = keyPair();
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
export async function pairWithCode(url: string, typed: string, o: Dial & { name: string; onWords: (w: string) => void }): Promise<DeviceGrant> {
  if (!normalizeCode(typed)) throw new LinkError('wrong-code');
  const me = keyPair();
  const l = await dial(url, me, { psk: codeKey(typed) }, { t: 'code', name: o.name }, o);
  const hostKey = b64url(l.hostKey);
  l.close();
  return granted(me, hostKey, url, [url], l.ready);
}

type Pending = { msg: any; resolve: (v: unknown) => void; reject: (e: Error) => void };

/** The device's live link: connects, reconnects forever with backoff, resends unanswered requests after a reconnect. */
export class DeviceLink {
  grant: DeviceGrant;
  status: LinkStatus = 'connecting';
  private o: Dial & { store?: DeviceStore; onEvent?: (e: unknown) => void; onStatus?: (s: LinkStatus) => void };
  private conn: Open | null = null;
  private pending = new Map<number, Pending>();
  private n = 0;
  private tries = 0;
  private stopped = false;
  private wake: any;
  private connecting = false;
  private acked: string[] = [];

  constructor(grant: DeviceGrant, o: Dial & { store?: DeviceStore; onEvent?: (e: unknown) => void; onStatus?: (s: LinkStatus) => void } = {}) {
    this.grant = grant;
    this.o = o;
    void this.connect();
  }

  private set(s: LinkStatus) { if (s !== this.status) { this.status = s; this.o.onStatus?.(s); } }

  private async connect() {
    if (this.stopped || this.connecting || this.conn) return;
    this.connecting = true;
    try {
      const me = keyPairFrom(unb64url(this.grant.secretKey));
      let wrongHost = false;
      for (const url of this.grant.urls) {
        try {
          let active: Open;
          const l = await dial(url, me, { key: unb64url(this.grant.host) }, { t: 'auth' }, this.o, {
            message: (m) => { if (this.conn === active) this.message(m); },
            close: () => { if (this.conn !== active) return; this.conn = null; if (!this.stopped) { this.set('offline'); this.again(); } },
          });
          active = l;
          if (this.stopped) return l.close();
          this.conn = l;
          this.tries = 0;
          this.grant = { ...this.grant, urls: [url, ...this.grant.urls.filter((u) => u !== url)], device: l.ready.device }; // the one that worked goes first
          void this.o.store?.save(this.grant);
          this.set('online');
          for (const p of this.pending.values()) l.send(p.msg); // same keys: the host runs each once
          return;
        } catch (e: any) {
          if (e?.sealed && e.code === 'not-paired') return this.removed();
          if (e?.code === 'wrong-host') wrongHost = true;
        }
      }
      if (wrongHost) { this.stopped = true; this.set('refused'); }
      else { this.set('offline'); this.again(); }
    } finally { this.connecting = false; }
  }

  private again() {
    const ms = Math.min(30_000, 1000 * 2 ** this.tries++) * (0.5 + Math.random() / 2);
    this.wake = later(ms, () => void this.connect());
  }

  private message(m: any) {
    if (m.t === 'revoked') return this.removed(); // sealed by the host, so it is really the host saying it
    if (m.t === 'event') return this.o.onEvent?.(m.e);
    const p = m.t === 'res' ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id);
    this.acked.push(p.msg.key);
    if (this.acked.length > 64) this.acked.shift();
    if (m.ok) p.resolve(m.value);
    else p.reject(known(m.error) ? new LinkError(m.error, true) : new Error(String(m.error)));
  }

  private removed() {
    this.stopped = true;
    this.conn?.close();
    for (const p of this.pending.values()) p.reject(new LinkError('removed', true));
    this.pending.clear();
    void this.o.store?.clear();
    this.set('removed');
  }

  /** Asks the host to do `op`. Waits through reconnects; resolves only with the host's answer. */
  request(op: string, args?: unknown): Promise<unknown> {
    if (this.status === 'removed') return Promise.reject(new LinkError('removed', true));
    return new Promise((resolve, reject) => {
      const id = ++this.n;
      const msg = { t: 'req', id, op, args, key: b64url(random(12)), acked: this.acked.splice(0, 64) };
      this.pending.set(id, { msg, resolve, reject });
      this.conn?.send(msg);
    });
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

  stop() { this.stopped = true; clearTimeout(this.wake); this.conn?.close(); }
}
