// @byokit/outbox: a durable queue for outbound messages the app may still take back. Every mutation is
// revision-checked and fsync-persisted; cancellation wins until the real send — the invocation of the
// sender — because the last pre-send check and the invocation are one serialized critical section, and a
// cancel that loses past that point says so instead of claiming otherwise.
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

/** Where one message stands. `sending` after a crash means the outcome is unknown, not "in progress". */
export type OutboxState = 'queued' | 'sending' | 'sent' | 'cancelled' | 'failed';
export type OutboxErrorCode = 'invalid' | 'io' | 'not-found' | 'stale-revision' | 'unavailable';

export class OutboxError extends Error {
  readonly code: OutboxErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: OutboxErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'OutboxError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

/** One message: what to send, where it stands, and the revision every change must be checked against. */
export type OutboxEntry = {
  id: string;
  /** The app's own kind word, e.g. `email-reply`. The kit never reads it. */
  kind: string;
  /** The app's JSON payload. Stored as its JSON round-trip; the kit never reads it. */
  payload: unknown;
  state: OutboxState;
  /** Bumped on every persisted change; mutations carry the revision they observed. Starts at 1. */
  revision: number;
  /** Enqueue order; sends leave in this order. */
  seq: number;
  createdAt: number;
  updatedAt: number;
  /** Set when the sender resolved. A send that resolved is not a delivery claim. */
  sentAt?: number;
  /** Whatever the sender resolved with, when it is JSON. */
  receipt?: unknown;
  /** The sender's failure text, when it rejected. */
  failure?: string;
};

/** What the kit hands the sender: exactly what was enqueued, nothing about the queue itself. */
export type OutboxSendJob = { id: string; kind: string; payload: unknown; seq: number };
/** The transport the app owns. The invocation of `send` is the irreversible boundary. */
export type OutboxSender = { send(job: OutboxSendJob): Promise<unknown> };

export type OutboxOptions = {
  /** Absolute. The kit writes only `stateDir/outbox/` (0700, files 0600, atomic fsynced writes). */
  stateDir: string;
  /** The sender `flush` hands messages to. Without it the queue parks: enqueue and cancel only. */
  sender?: OutboxSender;
  /** The clock, epoch ms. */
  now?: () => number;
  log?: (line: string) => void;
};

/** Cancel of a message the sender has not been invoked for wins; past the invocation it loses and says so.
 * `too-late` means the sender was invoked (or the message settled); `unknown` means an interrupted send whose
 * outcome the kit cannot know — take it to `resolve`, never to another cancel. */
export type CancelResult = { ok: true; entry: OutboxEntry } | { ok: false; code: 'too-late' | 'unknown'; entry: OutboxEntry };
/** What one drain produced. Entries carry their own final state. */
export type FlushResult = { sent: OutboxEntry[]; failed: OutboxEntry[] };

type Stored = { v: 1; nextSeq: number; entries: OutboxEntry[] };
/** A settled sender outcome, carried out of the arm step so the chain never awaits user code. */
type ArmedOutcome = { ok: true; receipt: unknown } | { ok: false; failure: string };

const failureOf = (cause: unknown): string => {
  const text = cause instanceof Error ? cause.message : String(cause);
  return text.length > 4096 ? text.slice(0, 4096) : text;
};

const storePath = (stateDir: string) => join(stateDir, 'outbox', 'entries.json');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const integer = (v: unknown): v is number => count(v) && Number.isSafeInteger(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATES: readonly OutboxState[] = ['queued', 'sending', 'sent', 'cancelled', 'failed'];

// Same durability contract as packages/secrets/src/atomic.ts writeFileAtomic and openclaw's auth-store `put`:
// neither exported writer fsyncs, and a queue that lost a durable 'sending' claim to a crash after the sender
// was invoked would redispatch a message it may already have sent. The fsynced writer lives here instead.
let tempCounter = 0;
function put(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.tmp-${process.pid}-${tempCounter++}`;
  try {
    writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
    const file = openSync(temp, 'r');
    try { fsyncSync(file); } finally { closeSync(file); }
    renameSync(temp, path);
    if (process.platform === 'win32') return; // Windows does not expose directory fsync through Node.
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    rmSync(temp, { force: true });
  }
}

/** JSON-round-trip a value or reject: what is stored is exactly what the sender later receives. */
function storable(value: unknown, what: string): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { /* rejected below */ }
  if (encoded === undefined) throw new OutboxError('invalid', `${what} must be JSON`);
  return JSON.parse(encoded);
}

/** A stored entry is read back exactly as it was validated in memory; anything else refuses the whole store. */
function entryOf(raw: unknown): OutboxEntry | null {
  if (!object(raw) || raw.v !== undefined) return null;
  if (!text(raw.id) || !ID.test(raw.id) || !text(raw.kind) || typeof raw.state !== 'string' || !STATES.includes(raw.state as OutboxState) ||
    !integer(raw.revision) || raw.revision < 1 || !integer(raw.seq) || raw.seq < 1 || !count(raw.createdAt) || !count(raw.updatedAt)) return null;
  if (raw.sentAt !== undefined && !count(raw.sentAt)) return null;
  if (raw.failure !== undefined && (typeof raw.failure !== 'string' || raw.failure.length > 4096)) return null;
  const entry = { id: raw.id, kind: raw.kind, payload: raw.payload, state: raw.state as OutboxState, revision: raw.revision,
    seq: raw.seq, createdAt: raw.createdAt, updatedAt: raw.updatedAt } as OutboxEntry;
  if (raw.receipt !== undefined) entry.receipt = raw.receipt;
  if (raw.sentAt !== undefined) entry.sentAt = raw.sentAt;
  if (raw.failure !== undefined) entry.failure = raw.failure;
  return entry;
}

function stored(entries: Iterable<OutboxEntry>, nextSeq: number): string {
  return JSON.stringify({ v: 1, nextSeq, entries: [...entries].sort((a, b) => a.seq - b.seq) } satisfies Stored);
}

/**
 * The outbound queue. One process at a time owns a `stateDir`: nothing here coordinates two live queues on the
 * same files (last writer wins), so a second `Outbox.open` on the same store is the app's bug, not the kit's.
 */
export class Outbox {
  #entries = new Map<string, OutboxEntry>();
  #nextSeq = 1;
  #path: string;
  #sender?: OutboxSender;
  #now: () => number;
  #log?: (line: string) => void;
  #closed = false;
  /** Dispatch state of entries this instance claimed: 'claimed' = claimed but the sender not yet invoked,
   * 'invoked' = the sender was called. Entries left 'sending' by an earlier life are absent: unknown. */
  #claims = new Map<string, 'claimed' | 'invoked'>();
  #chain: Promise<unknown> = Promise.resolve();

  private constructor(options: Required<Pick<OutboxOptions, 'stateDir'>> & Pick<OutboxOptions, 'sender' | 'now' | 'log'>) {
    this.#path = storePath(options.stateDir);
    this.#sender = options.sender;
    this.#now = options.now ?? Date.now;
    this.#log = options.log;
  }

  /** Open (or create) the store under `stateDir`. A malformed store rejects `invalid`; it is never reset. */
  static async open(options: OutboxOptions): Promise<Outbox> {
    if (!object(options) || typeof options.stateDir !== 'string' || !isAbsolute(options.stateDir)) {
      throw new TypeError('Outbox.open: stateDir must be an absolute path');
    }
    if (options.sender !== undefined && (!object(options.sender) || typeof options.sender.send !== 'function')) {
      throw new TypeError('Outbox.open: sender must have a send(job) function');
    }
    if (options.now !== undefined && typeof options.now !== 'function') throw new TypeError('Outbox.open: now must be a function');
    if (options.log !== undefined && typeof options.log !== 'function') throw new TypeError('Outbox.open: log must be a function');
    const made = new Outbox(options);
    mkdirSync(dirname(made.#path), { recursive: true, mode: 0o700 });
    if (!existsSync(made.#path)) return made;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(made.#path, 'utf8'));
    } catch (cause) {
      throw new OutboxError('invalid', 'the outbox store is not valid JSON', { cause });
    }
    if (!object(raw) || raw.v !== 1 || !integer(raw.nextSeq) || raw.nextSeq < 1 || !Array.isArray(raw.entries)) {
      throw new OutboxError('invalid', 'the outbox store has an unknown shape');
    }
    const nextSeq: number = raw.nextSeq;
    const entries: OutboxEntry[] = [];
    for (const item of raw.entries) {
      const entry = entryOf(item);
      if (!entry) throw new OutboxError('invalid', 'the outbox store holds a malformed message');
      if (entries.some((other) => other.id === entry.id || other.seq === entry.seq)) {
        throw new OutboxError('invalid', 'the outbox store holds duplicate messages');
      }
      entries.push(entry);
    }
    if (entries.some((entry) => entry.seq >= nextSeq)) throw new OutboxError('invalid', 'the outbox store has a bad next sequence');
    made.#entries = new Map(entries.map((entry) => [entry.id, entry]));
    made.#nextSeq = nextSeq;
    return made;
  }

  /** Queue a message. It leaves only through `flush`, unless it is cancelled first. */
  async enqueue(input: { kind: string; payload: unknown }, o: { signal?: AbortSignal } = {}): Promise<OutboxEntry> {
    o.signal?.throwIfAborted();
    this.#live('enqueue');
    if (!object(input) || !text(input.kind)) throw new TypeError('enqueue: kind must be a non-empty string of at most 512 characters');
    const payload = storable(input.payload, 'enqueue: payload');
    return this.#run(() => {
      const now = this.#now();
      const entry: OutboxEntry = { id: randomUUID(), kind: input.kind, payload, state: 'queued', revision: 1, seq: this.#nextSeq, createdAt: now, updatedAt: now };
      this.#write([...this.#entries.values(), entry], this.#nextSeq + 1);
      this.#entries.set(entry.id, entry);
      this.#nextSeq += 1;
      return { ...entry };
    });
  }

  /** The entry as last persisted, or undefined. A snapshot: later mutations do not change it. */
  get(id: string): OutboxEntry | undefined {
    if (typeof id !== 'string') throw new TypeError('get: id must be a string');
    const entry = this.#entries.get(id);
    return entry === undefined ? undefined : { ...entry };
  }

  /** Every entry in enqueue order. */
  list(): OutboxEntry[] {
    return [...this.#entries.values()].sort((a, b) => a.seq - b.seq).map((entry) => ({ ...entry }));
  }

  /**
   * Take a message back. `revision` must be the entry's current revision; an older one rejects
   * `stale-revision` so a screen never cancels what it is no longer showing. The cancel wins until the
   * real send — the invocation of the sender — not until the durable claim: a cancel accepted while the
   * message is still queued, or after the claim but before the sender is invoked, means the sender is
   * **never invoked** for it. Once the sender has been invoked (or the message settled) the cancel loses
   * and returns `too-late`; a message left `sending` by an interrupted process returns `unknown` (the kit
   * cannot know whether it went) — never a false success and never a fabricated boundary.
   */
  async cancel(id: string, o: { revision: number }): Promise<CancelResult> {
    this.#live('cancel');
    if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('cancel: id must be a message id');
    if (!integer(o?.revision)) throw new TypeError('cancel: revision must be an integer');
    return this.#run(() => {
      const current = this.#required(id);
      if (o.revision !== current.revision) {
        throw new OutboxError('stale-revision', 'the message changed since that revision', { detail: { current: current.revision } });
      }
      // The winning window: still queued, or claimed by this process but the sender not yet invoked.
      if (current.state === 'queued' || (current.state === 'sending' && this.#claims.get(id) === 'claimed')) {
        const entry = this.#set(current, { state: 'cancelled' as const });
        return { ok: true as const, entry: { ...entry } };
      }
      if (current.state === 'sending') {
        // Invoked by this process: the send truly started. No claim here: an interrupted earlier life — unknown.
        return { ok: false as const, code: this.#claims.get(id) === 'invoked' ? 'too-late' as const : 'unknown' as const, entry: { ...current } };
      }
      if (current.state === 'cancelled') return { ok: true as const, entry: { ...current } }; // already taken back; still true that it will not be sent
      return { ok: false as const, code: 'too-late' as const, entry: { ...current } };
    });
  }

  /**
   * Send every queued message, in enqueue order, one claim at a time. Each send is two serialized steps:
   * the claim (`queued` → `sending`, fsync-durable), then the arm step, which re-checks the entry at the
   * claimed revision and invokes the sender **in the same critical section** — nothing can interleave
   * between that last check and the invocation. A cancel processed before the arm step wins even though
   * the claim is already durable; after it, the sender has truly been invoked. The outcome is persisted
   * when the sender settles; a sender that rejects is recorded `failed` (never retried here). `signal`
   * stops further claims; an in-flight send still records its outcome first. Returns once no message is
   * queued. Because the sender is invoked inside a serialized step, a `send` that does slow synchronous
   * work before returning its promise holds up other queue operations for that time.
   */
  async flush(o: { signal?: AbortSignal } = {}): Promise<FlushResult> {
    this.#live('flush');
    if (this.#sender === undefined) throw new OutboxError('unavailable', 'this outbox has no sender');
    const sent: OutboxEntry[] = [];
    const failed: OutboxEntry[] = [];
    for (;;) {
      o.signal?.throwIfAborted();
      const claimed = await this.#run(() => {
        this.#live('flush');
        const next = [...this.#entries.values()].filter((entry) => entry.state === 'queued').sort((a, b) => a.seq - b.seq)[0];
        if (next === undefined) return undefined;
        const entry = this.#set(next, { state: 'sending' as const });
        this.#claims.set(entry.id, 'claimed');
        return { ...entry };
      });
      if (claimed === undefined) break;
      // The arm step: the last revision-checked look and the invocation itself are one critical section,
      // so the irreversible boundary is the real send, not the durable claim.
      const armed = await this.#run(() => {
        const current = this.#entries.get(claimed.id);
        if (current === undefined || current.state !== 'sending' || current.revision !== claimed.revision) {
          this.#claims.delete(claimed.id); // a cancel (or resolve) won the window: the sender is never invoked.
          return undefined;
        }
        const job = { id: claimed.id, kind: claimed.kind, payload: claimed.payload, seq: claimed.seq };
        let settled: Promise<ArmedOutcome>;
        try {
          const receipt = this.#sender!.send(job); // the real send: this call is the boundary
          settled = Promise.resolve(receipt).then(
            (receipt) => ({ ok: true as const, receipt }),
            (cause: unknown) => ({ ok: false as const, failure: failureOf(cause) }));
        } catch (cause) {
          settled = Promise.resolve({ ok: false as const, failure: failureOf(cause) });
        }
        this.#claims.set(claimed.id, 'invoked');
        return { settled }; // boxed: the chain advances without awaiting the sender
      });
      if (armed === undefined) continue; // cancelled in the window before invocation
      const outcome = await armed.settled;
      const recorded = await this.#record(claimed, outcome);
      this.#claims.delete(claimed.id);
      if (recorded.state === 'failed') failed.push(recorded); else sent.push(recorded);
      o.signal?.throwIfAborted();
    }
    return { sent, failed };
  }

  /**
   * Record what a person or app learned about a message whose send was interrupted (state `sending` after a
   * crash: whether it was really sent is unknown, and the kit never guesses). Only `sending` entries accept
   * it, revision-checked like every mutation.
   */
  async resolve(id: string, o: { revision: number; outcome: 'sent' | 'failed'; receipt?: unknown; failure?: string }): Promise<OutboxEntry> {
    this.#live('resolve');
    if (typeof id !== 'string' || !ID.test(id)) throw new TypeError('resolve: id must be a message id');
    if (!object(o) || !integer(o.revision) || (o.outcome !== 'sent' && o.outcome !== 'failed')) {
      throw new TypeError('resolve: revision must be an integer and outcome must be sent or failed');
    }
    if (o.failure !== undefined && typeof o.failure !== 'string') throw new TypeError('resolve: failure must be a string');
    return this.#run(() => {
      const current = this.#required(id);
      if (o.revision !== current.revision) {
        throw new OutboxError('stale-revision', 'the message changed since that revision', { detail: { current: current.revision } });
      }
      if (current.state !== 'sending') throw new OutboxError('invalid', 'only a message whose send was interrupted can be resolved');
      const entry = o.outcome === 'sent'
        ? this.#set(current, { state: 'sent' as const, sentAt: this.#now(), ...(o.receipt === undefined ? {} : { receipt: storable(o.receipt, 'resolve: receipt') }) })
        : this.#set(current, { state: 'failed' as const, ...(o.failure === undefined ? {} : { failure: o.failure }) });
      return { ...entry };
    });
  }

  /** Stop accepting work. A send already handed to the sender still records its outcome afterwards. */
  async close(): Promise<void> {
    await this.#run(() => {
      this.#closed = true;
    });
  }

  #live(what: string): void {
    if (this.#closed) throw new OutboxError('unavailable', `${what}: the outbox is closed`);
  }

  #required(id: string): OutboxEntry {
    const current = this.#entries.get(id);
    if (current === undefined) throw new OutboxError('not-found', 'no message with that id');
    return current;
  }

  /** Apply a change to one entry, fsync-persist the whole store, then commit it to memory. */
  #set(current: OutboxEntry, change: Partial<Pick<OutboxEntry, 'state' | 'sentAt' | 'receipt' | 'failure'>>): OutboxEntry {
    const entry: OutboxEntry = { ...current, ...change, revision: current.revision + 1, updatedAt: this.#now() };
    this.#write([...this.#entries.values()].map((other) => (other.id === entry.id ? entry : other)), this.#nextSeq);
    this.#entries.set(entry.id, entry);
    return entry;
  }

  #record(claimed: OutboxEntry, outcome: ArmedOutcome): Promise<OutboxEntry> {
    return this.#run(() => {
      const current = this.#entries.get(claimed.id);
      if (current === undefined || current.state !== 'sending' || current.revision !== claimed.revision) {
        // Resolved by someone else while the send was in flight: their record stands.
        return current === undefined ? claimed : { ...current };
      }
      if (outcome.ok) {
        let receipt: unknown;
        try {
          receipt = outcome.receipt === undefined ? undefined : storable(outcome.receipt, 'receipt');
        } catch {
          this.#log?.('outbox: dropped a receipt that is not JSON');
          receipt = undefined;
        }
        return { ...this.#set(current, { state: 'sent', sentAt: this.#now(), ...(receipt === undefined ? {} : { receipt }) }) };
      }
      return { ...this.#set(current, { state: 'failed', failure: outcome.failure }) };
    });
  }

  #write(entries: OutboxEntry[], nextSeq: number): void {
    // ponytail: one ledger file rewritten per change; fine for thousands of small messages, append log if volume grows.
    try {
      put(this.#path, stored(entries, nextSeq));
    } catch (cause) {
      throw new OutboxError('io', 'the outbox store could not be saved', { cause });
    }
  }

  /** Serialize critical sections: state checks, persistence and memory commits never interleave. */
  #run<T>(step: () => T | Promise<T>): Promise<T> {
    const next = this.#chain.then(step, step);
    this.#chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
