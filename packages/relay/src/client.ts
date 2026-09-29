// The host's side of the relay: one outbound socket that stays up. It proves the host's key, hands the socket to link's
// `host.relay`, and reconnects with backoff when it drops. Requests to the relay itself (a short code, push
// subscriptions, notifications) wait in a queue of 64 while the socket is down and go out once it is back. A revoked
// device's unsubscribe is kept apart, in `store`: it is resent on every socket until the relay confirms it.
import type { Host, Socket } from '@byokit/link';
import { CLOSE, prove, type Challenge } from './proof.ts';
import type { Notification, Subscription } from './push.ts';

/** `replaced`: another copy of this host registered, so this one stopped. `refused`: the relay does not allow this
 *  host (not enrolled, enrolment used or expired, revoked); it stopped too. */
export type RelayStatus = 'connecting' | 'online' | 'offline' | 'replaced' | 'refused';
/** A button pressed on a notification, from device `device` (its grant id). */
export type PushAction = { device: string; event: string; action: string };
/** Where the client keeps the devices whose push addresses the relay has not yet confirmed removing (grant ids). Pass a
 *  durable one (a file or a database row): the default keeps them in memory, so a restart before the relay confirms
 *  would forget them and the removed device could keep getting notifications. */
export type RelayClientStore = { load(): string[] | undefined | Promise<string[] | undefined>; save(devices: string[]): void | Promise<void> };

export type RelayClientOptions = {
  /** The relay's host address, e.g. `wss://relay.example/relay/v1/host`. */
  url: string;
  /** A token from the relay owner's `enrolment()`, needed only on the first connection. */
  enrol?: string;
  /** This host's name on the relay's list, if the enrolment did not set one. */
  name?: string;
  onStatus?: (s: RelayStatus, why?: string) => void;
  /** Answers a notification button; the value goes back to the device. Throw to refuse. */
  onAction?: (a: PushAction) => unknown;
  WebSocket?: new (url: string) => Socket & { readyState: number };
  /** Revoked devices still to unsubscribe. Default: in memory only. */
  store?: RelayClientStore;
  /** The relay confirmed a revoked device has no push addresses left, so it gets no more notifications. */
  onRevoked?: (device: string) => void;
};

type Call = { msg: object; resolve: (v: any) => void; reject: (e: Error) => void };
type Linked = Pick<Host, 'keys' | 'relay' | 'revoke'>;

const QUEUE = 64;
const later = (ms: number, fn: () => void) => { const t: any = setTimeout(fn, ms); t.unref?.(); return t; };
// The relay's answers that prove a device can have no push address left: the host is not registered (its addresses
// went with it), or the device id is one no subscription can use.
const GONE = new Set(['host revoked', 'bad device']);
const STOPS: Record<number, RelayStatus> = {
  [CLOSE.replaced]: 'replaced', [CLOSE.notEnrolled]: 'refused', [CLOSE.badProof]: 'refused', [CLOSE.enrolment]: 'refused', [CLOSE.revoked]: 'refused',
};

export class RelayClient {
  status: RelayStatus = 'connecting';
  /** The relay's Web Push key, for a browser's `pushManager.subscribe` (send it to the device over the link). */
  vapidKey?: string;
  /** This host's address on the relay; devices dial `<relay>/link/v1/<id>`. */
  id?: string;
  private host: Linked;
  private opts: RelayClientOptions;
  private ws?: Socket & { readyState: number };
  private queue: Call[] = [];
  private inflight = new Map<string, Call>();
  private seq = 0;
  private tries = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setTimeout>;
  private store: RelayClientStore;
  private loaded: Promise<void>;
  private saves: Promise<void>;
  private revoking: string[] = [];
  private removing = new Map<string, string>(); // request id -> device, one per device on the current socket
  private retries = new Map<string, { tries: number; timer?: ReturnType<typeof setTimeout> }>();
  private waiters = new Map<string, { resolve: () => void; reject: (e: Error) => void }[]>();

  constructor(host: Linked, opts: RelayClientOptions) {
    this.host = host;
    this.opts = opts;
    let kept: string[] | undefined;
    this.store = opts.store ?? { load: () => kept, save: (d) => { kept = d; } };
    this.loaded = Promise.resolve().then(() => this.store.load()).then((d) => { this.revoking = [...new Set(d ?? [])]; });
    this.saves = this.loaded.catch(() => {});
    this.connect();
  }

  /** A short code (six characters, five minutes) a device can type to find this host on the relay; the person types
   *  it with link's pairing code from `host.code()`. The relay learns only which host it points to. */
  code(): Promise<{ code: string; expires: number }> { return this.call({ t: 'code' }); }

  /** Stores device `device`'s push address (a device sends it over the link; `device` is its grant id). Refused for a
   *  device still being revoked. */
  async subscribe(device: string, sub: Subscription): Promise<void> {
    await this.loaded;
    if (this.revoking.includes(device)) throw new Error('device revoked');
    await this.call({ t: 'push.subscribe', device, sub });
  }

  /** Drops one push address of a device, or all of them. */
  async unsubscribe(device: string, sub?: Subscription): Promise<void> { await this.call({ t: 'push.remove', device, ...(sub && { sub }) }); }

  /** Sends a notification to the devices' phones and browsers, even asleep. The same `id` is sent once. */
  notify(n: Notification, options: { includeContent?: boolean } = {}): Promise<{ sent: number; duplicate?: true }> {
    const generic = { ...n };
    if (!options.includeContent) { delete generic.body; delete generic.data; }
    return this.call({ t: 'push.notify', n: generic });
  }

  /** Removes a device: link's revoke, and all its push subscriptions on the relay. The unsubscribe is saved to `store`
   *  first, then resent on every connection (and retried with backoff if the relay fails it) until the relay confirms;
   *  this resolves then. It rejects if the client stops first, but the saved unsubscribe goes on with the next client
   *  that opens the same store. */
  async revoke(device: string): Promise<void> {
    if (this.stopped) throw new Error('relay client stopped');
    const done = new Promise<void>((resolve, reject) => this.waiters.set(device, [...(this.waiters.get(device) ?? []), { resolve, reject }]));
    done.catch(() => {}); // reported below, or by the await
    try {
      await this.change((d) => d.includes(device) ? d : [...d, device]);
      await this.host.revoke(device);
    } catch (e) {
      this.settle(device, e as Error);
      this.unsubscribing(device); // saved but the grant stayed: its push addresses still go, failing closed
      throw e;
    }
    this.unsubscribing(device);
    return done;
  }

  /** Revoked devices whose push addresses the relay has not yet confirmed removing. */
  async pending(): Promise<string[]> {
    await this.loaded;
    return [...this.revoking];
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'host stopping');
    this.fail(new Error('relay client stopped'));
  }

  private change(update: (devices: string[]) => string[]): Promise<void> {
    const work = this.saves.then(async () => {
      await this.loaded;
      const next = update([...this.revoking]);
      await this.store.save(next);
      this.revoking = next;
    });
    this.saves = work.catch(() => {});
    return work;
  }

  private settle(device: string, e?: Error) {
    for (const w of this.waiters.get(device) ?? []) e ? w.reject(e) : w.resolve();
    this.waiters.delete(device);
  }

  private unsubscribing(device: string) {
    if (this.stopped || !this.ws || this.status !== 'online' || !this.revoking.includes(device) || [...this.removing.values()].includes(device)) return;
    clearTimeout(this.retries.get(device)?.timer);
    const id = String(++this.seq);
    this.removing.set(id, device);
    this.ws.send(JSON.stringify({ t: 'push.remove', device, id }));
  }

  private removed(device: string, ok: boolean, error: string) {
    if (!ok && !GONE.has(error)) {
      // ponytail: backoff per device; a relay that keeps failing is also retried on every reconnect.
      const r = this.retries.get(device) ?? { tries: 0 };
      this.retries.set(device, r);
      r.timer = later(Math.min(30_000, 1000 * 2 ** r.tries++) * (0.5 + Math.random() / 2), () => this.unsubscribing(device));
      return;
    }
    this.gone(device);
  }

  private gone(device: string) {
    clearTimeout(this.retries.get(device)?.timer);
    this.retries.delete(device);
    if (!this.revoking.includes(device)) return;
    // If this save fails the entry comes back on the next start and is sent again: the relay's remove is idempotent.
    void this.change((d) => d.filter((x) => x !== device)).catch(() => {});
    this.revoking = this.revoking.filter((x) => x !== device);
    this.settle(device);
    this.opts.onRevoked?.(device);
  }

  private set(s: RelayStatus, why?: string) {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s, why);
  }

  private call(msg: object): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('relay client stopped'));
    return new Promise((resolve, reject) => {
      const c: Call = { msg, resolve, reject };
      if (this.status === 'online') return this.send(c);
      if (this.queue.length >= QUEUE) this.queue.shift()!.reject(new Error('relay queue full'));
      this.queue.push(c);
    });
  }

  private send(c: Call) {
    const id = String(++this.seq);
    this.inflight.set(id, c);
    this.ws!.send(JSON.stringify({ ...c.msg, id }));
  }

  private fail(e: Error) {
    for (const c of [...this.inflight.values(), ...this.queue]) c.reject(e);
    this.inflight.clear();
    this.queue = [];
    this.removing.clear();
    for (const r of this.retries.values()) clearTimeout(r.timer);
    this.retries.clear();
    for (const device of [...this.waiters.keys()]) this.settle(device, e);
  }

  private connect() {
    if (this.stopped) return;
    this.set('connecting');
    const WS = this.opts.WebSocket ?? (globalThis as any).WebSocket;
    const ws: Socket & { readyState: number } = new WS(this.opts.url);
    this.ws = ws;
    ws.addEventListener('message', (e) => {
      if (this.ws !== ws) return;
      let m: any;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (typeof m?.c === 'string') return; // a device's frame: link's `host.relay` has it
      if (m?.t === 'challenge') {
        const hello = { t: 'hello', key: Buffer.from(this.host.keys.publicKey).toString('base64url'), proof: Buffer.from(prove(this.host.keys, m as Challenge)).toString('base64url'),
          ...(this.opts.enrol && { enrol: this.opts.enrol }), ...(this.opts.name && { name: this.opts.name }) };
        return ws.send(JSON.stringify(hello));
      }
      if (m?.t === 'ready') {
        this.id = m.id;
        this.vapidKey = m.vapid;
        this.tries = 0;
        this.host.relay(ws);
        this.set('online');
        for (const c of this.queue.splice(0)) this.send(c);
        void this.loaded.then(() => { if (this.ws === ws) for (const d of this.revoking) this.unsubscribing(d); }, () => {});
        return;
      }
      if (m?.t === 'res') {
        const device = this.removing.get(String(m.id));
        if (device !== undefined) {
          this.removing.delete(String(m.id));
          return this.removed(device, m.ok === true, String(m.error));
        }
        const c = this.inflight.get(String(m.id));
        this.inflight.delete(String(m.id));
        if (!c) return;
        const { t, id, ok, error, ...value } = m;
        return ok ? c.resolve(value) : c.reject(new Error(String(error ?? 'relay refused')));
      }
      if (m?.t === 'push.action') {
        const a: PushAction = { device: String(m.device), event: String(m.event), action: String(m.action) };
        void Promise.resolve().then(() => {
          if (!this.opts.onAction) throw new Error('no action handler');
          return this.opts.onAction(a);
        }).then(
          (value) => ws.send(JSON.stringify({ t: 'answer', id: m.id, ok: true, value })),
          (err) => ws.send(JSON.stringify({ t: 'answer', id: m.id, ok: false, error: String(err?.message ?? err) })),
        ).catch(() => {}); // the socket went: the relay answers the device with a timeout
      }
    });
    // A failed connect fires 'close' after 'error' on Node 24+, but only 'error' on Node 22: either one ends the socket,
    // once (the first clears `this.ws`), and schedules the next try.
    const down = (e?: { code?: number; reason?: string }) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      // Whatever the relay had not answered goes again on the next socket: each of these is safe to repeat.
      this.queue.unshift(...this.inflight.values());
      this.inflight.clear();
      this.removing.clear(); // resent on the next socket
      while (this.queue.length > QUEUE) this.queue.pop()!.reject(new Error('relay queue full'));
      const stop = STOPS[e?.code ?? 0];
      if (stop) {
        // Not registered on the relay means it holds no push address for this host: nothing is left to unsubscribe.
        if (e!.code === CLOSE.revoked || e!.code === CLOSE.notEnrolled) for (const d of [...this.revoking]) this.gone(d);
        this.stopped = true;
        this.set(stop, e?.reason);
        return this.fail(new Error(`relay: ${e?.reason || stop}`));
      }
      if (this.stopped) return;
      this.set('offline', e?.reason);
      const ms = Math.min(30_000, 1000 * 2 ** this.tries++) * (0.5 + Math.random() / 2);
      this.timer = later(ms, () => this.connect());
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', () => { if (ws.readyState === 0) down(); else if (ws.readyState === 1) ws.close(); });
  }
}
