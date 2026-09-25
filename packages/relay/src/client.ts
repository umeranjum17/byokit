// The host's side of the relay: one outbound socket that stays up. It proves the host's key, hands the socket to link's
// `host.relay`, and reconnects with backoff when it drops. Requests to the relay itself (a short code, push
// subscriptions, notifications) wait in a queue of 64 while the socket is down and go out once it is back.
import type { Host, Socket } from '@byokit/link';
import { CLOSE, prove, type Challenge } from './proof.ts';
import type { Notification, Subscription } from './push.ts';

/** `replaced`: another copy of this host registered, so this one stopped. `refused`: the relay does not allow this
 *  host (not enrolled, enrolment used or expired, revoked); it stopped too. */
export type RelayStatus = 'connecting' | 'online' | 'offline' | 'replaced' | 'refused';
/** A button pressed on a notification, from device `device` (its grant id). */
export type PushAction = { device: string; event: string; action: string };

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
};

type Call = { msg: object; resolve: (v: any) => void; reject: (e: Error) => void };
type Linked = Pick<Host, 'keys' | 'relay' | 'revoke'>;

const QUEUE = 64;
const later = (ms: number, fn: () => void) => { const t: any = setTimeout(fn, ms); t.unref?.(); return t; };
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

  constructor(host: Linked, opts: RelayClientOptions) {
    this.host = host;
    this.opts = opts;
    this.connect();
  }

  /** A short code (six characters, five minutes) a device can type to find this host on the relay; the person types
   *  it with link's pairing code from `host.code()`. The relay learns only which host it points to. */
  code(): Promise<{ code: string; expires: number }> { return this.call({ t: 'code' }); }

  /** Stores device `device`'s push address (a device sends it over the link; `device` is its grant id). */
  async subscribe(device: string, sub: Subscription): Promise<void> { await this.call({ t: 'push.subscribe', device, sub }); }

  /** Drops one push address of a device, or all of them. */
  async unsubscribe(device: string, sub?: Subscription): Promise<void> { await this.call({ t: 'push.remove', device, ...(sub && { sub }) }); }

  /** Sends a notification to the devices' phones and browsers, even asleep. The same `id` is sent once. */
  notify(n: Notification, options: { includeContent?: boolean } = {}): Promise<{ sent: number; duplicate?: true }> {
    const generic = { ...n };
    if (!options.includeContent) { delete generic.body; delete generic.data; }
    return this.call({ t: 'push.notify', n: generic });
  }

  /** Removes a device: link's revoke, and its push subscriptions on the relay. */
  async revoke(device: string) {
    await this.host.revoke(device);
    await this.unsubscribe(device);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close(1000, 'host stopping');
    this.fail(new Error('relay client stopped'));
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
        return;
      }
      if (m?.t === 'res') {
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
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      // Whatever the relay had not answered goes again on the next socket: each of these is safe to repeat.
      this.queue.unshift(...this.inflight.values());
      this.inflight.clear();
      while (this.queue.length > QUEUE) this.queue.pop()!.reject(new Error('relay queue full'));
      const stop = STOPS[e?.code];
      if (stop) {
        this.stopped = true;
        this.set(stop, e?.reason);
        return this.fail(new Error(`relay: ${e?.reason || stop}`));
      }
      if (this.stopped) return;
      this.set('offline', e?.reason);
      const ms = Math.min(30_000, 1000 * 2 ** this.tries++) * (0.5 + Math.random() / 2);
      this.timer = later(ms, () => this.connect());
    });
    ws.addEventListener('error', () => { if (ws.readyState === 1) ws.close(); });
  }
}
