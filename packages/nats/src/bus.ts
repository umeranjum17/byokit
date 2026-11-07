// Publish and durable readers over one NATS JetStream connection. The kit knows no subjects and no policy: the app
// names its streams, subjects and durables.
import { AckPolicy, DiscardPolicy, jetstream, jetstreamManager, StorageType, type JetStreamClient, type JetStreamManager, type JsMsg } from '@nats-io/jetstream';
import { connect, type NatsConnection } from '@nats-io/transport-node';
import { NatsError } from './error.ts';

const MS = 1_000_000; // JetStream counts time in nanoseconds
const DAY = 86_400_000;
const STOP_GRACE_MS = 5000;

export type StreamOptions = {
  name: string;
  /** Subjects the stream keeps, for example `app.>`. */
  subjects: string[];
  /** How long a message is kept. Default 7 days. The duplicate window may not exceed it. */
  maxAgeMs?: number;
  /** A repeated message id inside this window is refused. Default 2 minutes. */
  duplicateWindowMs?: number;
  /** A blunt backstop: at most this many messages per subject, the newest refused. Default none. */
  perSubjectCap?: number;
};
export type NatsBusOptions = {
  /** From `ensureNats()`. */
  url: string;
  token: string;
};
export type BusMessage = {
  subject: string;
  data: Uint8Array;
  /** The stream sequence, the same on every redelivery. */
  seq: number;
  /** 1 on the first delivery. */
  deliveries: number;
  /** Confirmed ack: resolves once the server has the ack. */
  ack(): Promise<void>;
  /** Hand it back for another try, after `delayMs` when given. */
  nak(delayMs?: number): void;
  /** Never deliver it again. */
  term(): void;
};
export type ReaderOptions = {
  /** Subject filter, for example `app.mention.>`. */
  filter: string;
  /** Sent again after this long unacked. Default 30 s. */
  ackWaitMs?: number;
  /** Deliveries before the server gives up on a message. Default 5. */
  maxDeliver?: number;
  /** Messages out at once. Default 1. */
  maxAckPending?: number;
};
export type BusReader = { stop(): Promise<void> };

export class NatsBus {
  private readonly nc: NatsConnection;
  private readonly js: JetStreamClient;
  private readonly jsm: JetStreamManager;
  private readonly readers = new Set<BusReader>();
  private closed = false;
  private constructor(nc: NatsConnection, js: JetStreamClient, jsm: JetStreamManager) { this.nc = nc; this.js = js; this.jsm = jsm; }

  static async open(o: NatsBusOptions): Promise<NatsBus> {
    const nc = await connect({ servers: o.url.replace(/^nats:\/\//, ''), token: o.token, maxReconnectAttempts: -1, reconnectTimeWait: 200 });
    try { return new NatsBus(nc, jetstream(nc), await jetstreamManager(nc)); } catch (e) { await nc.close(); throw e; }
  }

  private live() { if (this.closed) throw new NatsError('closed', 'nats: the bus is closed'); }

  /** Create the stream, or bring an existing one to this configuration. Safe to call on every start. */
  async ensureStream(s: StreamOptions): Promise<void> {
    this.live();
    const maxAge = s.maxAgeMs ?? 7 * DAY;
    const cfg = { name: s.name, subjects: s.subjects, storage: StorageType.File, max_age: maxAge * MS, duplicate_window: Math.min(s.duplicateWindowMs ?? 120_000, maxAge) * MS, discard: DiscardPolicy.New, ...(s.perSubjectCap ? { max_msgs_per_subject: s.perSubjectCap, discard_new_per_subject: true } : {}) };
    await this.jsm.streams.add(cfg).catch(() => this.jsm.streams.update(s.name, cfg));
  }

  /** Store one message. A repeated `msgId` inside the duplicate window is refused by the server and reported, not stored twice. */
  async publish(subject: string, data: Uint8Array | string, msgId?: string): Promise<{ seq: number; duplicate: boolean }> {
    this.live();
    const ack = await this.js.publish(subject, typeof data === 'string' ? new TextEncoder().encode(data) : data, { ...(msgId ? { msgID: msgId } : {}), timeout: 5000 });
    return { seq: ack.seq, duplicate: ack.duplicate };
  }

  /** A durable reader: it keeps its place across stops and restarts, and each message waits for `ack()` (or is sent again). A handler that throws hands the message back. */
  async reader(stream: string, durable: string, o: ReaderOptions, handler: (m: BusMessage) => void | Promise<void>): Promise<BusReader> {
    this.live();
    const cfg = { durable_name: durable, ack_policy: AckPolicy.Explicit, filter_subject: o.filter, max_deliver: o.maxDeliver ?? 5, max_ack_pending: o.maxAckPending ?? 1, ack_wait: (o.ackWaitMs ?? 30_000) * MS };
    await this.jsm.consumers.add(stream, cfg).catch(() => this.jsm.consumers.update(stream, durable, cfg));
    const messages = await (await this.js.consumers.get(stream, durable)).consume();
    const loop = (async () => {
      for await (const m of messages as AsyncIterable<JsMsg>) {
        const msg: BusMessage = { subject: m.subject, data: m.data, seq: m.seq, deliveries: m.info.deliveryCount, ack: () => m.ackAck({ timeout: 5000 }).then(() => {}), nak: (d) => m.nak(d), term: () => m.term() };
        try { await handler(msg); } catch { m.nak(1000); }
      }
    })().catch(() => {});
    const reader: BusReader = {
      stop: async () => {
        this.readers.delete(reader);
        // A handler stuck on something that never settles, or a server that is gone, must not keep shutdown, or the process, alive.
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([messages.close().catch(() => {}).then(() => loop), new Promise<void>((r) => { timer = setTimeout(r, STOP_GRACE_MS); })]);
        clearTimeout(timer);
      },
    };
    this.readers.add(reader);
    return reader;
  }

  /** Stop every reader, then close the connection. The server keeps running; stop it with `NatsServer.stop()`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.readers].map((r) => r.stop()));
    await this.nc.close();
  }
}
