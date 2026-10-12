// Duplex named streams inside one link connection: a terminal pane, a preview tunnel's TCP connection, a voice call.
// Each direction has a window of bytes: a side sends only what the other has granted, and grants more as its app takes
// what arrived, so a slow reader slows the writer instead of filling memory at either end.
//
// Inner messages, sealed like every other: the device sends {t:'open', s, op, args, credit}; the host answers
// {t:'opened', s, credit} or {t:'end', s, error}. Then {t:'credit', s, n} grants n more bytes, {t:'end', s, error?}
// from either side closes the stream both ways, and the bytes themselves travel as binary inner messages
// (`Channel.sealData`). Streams live and die with their connection: after a reconnect the device opens them again.

/** Bytes each side may have in flight on one stream before the other has taken them. */
export const WINDOW = 256 * 1024;
const PIECE = 32 * 1024; // the most one data message carries
export const MAX_STREAMS = 64; // open at once on one connection

const text = new TextEncoder();

/** How a stream reaches the socket. `reason` turns an error thrown in `onData` into what the other side is told. */
export type StreamWire = { send(m: object): void; data(s: number, bytes: Uint8Array): void; reason?: (e: unknown) => string; report?: (e: unknown) => void };

export class LinkStream {
  readonly id: number;
  /** What the device asked for, e.g. `terminal` with `{ pane }`. */
  readonly op: string;
  readonly args: unknown;
  private wire: StreamWire;
  private gone: () => void;
  private credit = 0; // bytes this side may still send
  private owed = 0; // bytes our app has taken that the other side hasn't been told about
  private allowance = WINDOW; // bytes the other side may still send us
  private inbox: (Uint8Array | { end?: string })[] = [];
  private reader?: (chunk: Uint8Array) => void | Promise<void>;
  private ender?: (error?: string) => void | Promise<void>;
  private pumping = false;
  private wake?: () => void;
  private tail: Promise<void> = Promise.resolve();
  private ending = false;
  private closed = false;
  private settle?: { resolve: (s: LinkStream) => void; reject: (error: string) => void };

  constructor(id: number, op: string, args: unknown, wire: StreamWire, gone: () => void) {
    this.id = id;
    this.op = op;
    this.args = args;
    this.wire = wire;
    this.gone = gone;
  }

  /** Each chunk that arrives, in order. Return a promise to hold the other side back until it settles. Chunks that
   *  arrive before this is set wait for it. */
  set onData(fn: (chunk: Uint8Array) => void | Promise<void>) { this.reader = fn; void this.pump(); }
  /** Once, when the stream is over: `error` is unset when either side ended it cleanly. */
  set onEnd(fn: (error?: string) => void | Promise<void>) { this.ender = fn; this.notifyEnd(); void this.pump(); }

  /** Sends bytes (a string goes as UTF-8). Resolves once they're on the socket, which waits while the other side's
   *  window is full: await each write to move bulk data at the reader's pace. Rejects if the stream ends first. */
  write(chunk: Uint8Array | string): Promise<void> {
    if (this.closed || this.ending) return Promise.reject(new Error('stream ended'));
    const bytes = typeof chunk === 'string' ? text.encode(chunk) : chunk;
    const p = this.tail.then(() => this.push(bytes));
    this.tail = p.catch(() => {});
    return p;
  }

  /** Ends the stream both ways. Without an error it goes after the writes already made; with one, at once. */
  end(error?: string) {
    if (error !== undefined) return this.finish(error, true);
    this.ending = true;
    void this.tail.then(() => this.finish(undefined, true));
  }

  private async push(bytes: Uint8Array) {
    for (let at = 0; at < bytes.byteLength;) {
      if (this.closed) throw new Error('stream ended');
      if (!this.credit) { await new Promise<void>((r) => { this.wake = r; }); continue; }
      const n = Math.min(this.credit, PIECE, bytes.byteLength - at);
      this.credit -= n;
      this.wire.data(this.id, bytes.subarray(at, at + n));
      at += n;
    }
  }

  private finish(error: string | undefined, tell: boolean) {
    if (this.closed) return;
    this.closed = true;
    this.gone();
    this.wake?.();
    if (tell) this.wire.send({ t: 'end', s: this.id, ...(error === undefined ? {} : { error }) });
    if (tell || error !== undefined) this.inbox = [];
    this.settle?.reject(error ?? 'ended');
    this.inbox.push({ end: error });
    this.notifyEnd();
    void this.pump();
  }

  private notifyEnd() {
    const next = this.inbox.at(-1);
    if (!this.ender || !next || next instanceof Uint8Array || next.end === undefined) return;
    this.inbox = [];
    const ender = this.ender;
    void Promise.resolve().then(() => this.deliverEnd(ender, next.end));
  }

  private async deliverEnd(ender: (error?: string) => void | Promise<void>, error?: string) {
    try { await ender(error); } catch (e) { this.report(e); }
  }

  private report(e: unknown) { try { this.wire.report?.(e); } catch {} }

  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    while (this.inbox.length) {
      const next = this.inbox[0];
      if (!(next instanceof Uint8Array)) {
        if (!this.ender) break;
        this.inbox.shift();
        void this.deliverEnd(this.ender, next.end);
        continue;
      }
      if (!this.reader) {
        if (!this.closed || !this.ender) break;
        this.inbox.shift();
        continue;
      }
      this.inbox.shift();
      try { await this.reader(next); } catch (e) {
        if (this.closed) this.report(e);
        else this.end(this.wire.reason?.(e) ?? 'failed');
      }
      this.took(next.byteLength);
    }
    this.pumping = false;
  }

  private took(n: number) {
    if (this.closed) return;
    this.owed += n;
    if (this.owed < WINDOW / 4) return;
    this.wire.send({ t: 'credit', s: this.id, n: this.owed });
    this.allowance += this.owed;
    this.owed = 0;
  }

  /** The host's side: tells the device the stream is open, with `credit` (the device's window) to send into. */
  accept(credit: number) {
    this.wire.send({ t: 'opened', s: this.id, credit: WINDOW });
    this.opened(credit);
  }

  // From the other side, through `Streams`.
  opened(credit: number) {
    this.credit = credit;
    this.settle?.resolve(this);
    this.settle = undefined;
    this.wake?.();
  }
  granted(n: number) { this.credit += n; this.wake?.(); }
  received(bytes: Uint8Array) {
    if (bytes.byteLength > this.allowance) throw new Error('stream went past its window');
    this.allowance -= bytes.byteLength;
    if (this.closed) return;
    this.inbox.push(bytes);
    void this.pump();
  }
  ended(error?: string) { this.finish(error, false); }
  waitOpened(): Promise<LinkStream> {
    return new Promise((resolve, reject) => { this.settle = { resolve, reject: (e) => reject(e) }; });
  }
}

/** The longest one JSON line `ndjson` buffers, in bytes (a line is its UTF-8 bytes up to `\n`). */
export const NDJSON_MAX_LINE = 1024 * 1024;
/** The stream error an `ndjson` reader ends its stream with when a line runs past its cap. Both sides see it. */
export const NDJSON_LINE_TOO_LONG = 'line-too-long';

export type NdjsonOptions = {
  /** The longest one line buffered before the stream ends with `NDJSON_LINE_TOO_LONG`. Defaults to `NDJSON_MAX_LINE`. */
  maxLine?: number;
};

export type NdjsonStream = {
  /** The byte stream underneath, for `onEnd`, `end` and anything else not about JSON. */
  readonly stream: LinkStream;
  /** Sends one JSON message (`JSON.stringify` plus `\n`) through the stream's credit window. */
  send(message: unknown): Promise<void>;
  /** Each whole JSON message, in order. Returning a promise holds the sender back until it settles. */
  onMessage(fn: (message: unknown) => void | Promise<void>): void;
  /** Ends the stream both ways: after the sends already made, or at once with an error. */
  end(error?: string): void;
};

/** Whole JSON messages over a byte `LinkStream`, one `\n`-terminated line each. Chunks split at any byte
 *  boundary reassemble before decoding, so a multi-byte character split across two chunks still arrives whole.
 *  A line past the cap ends the stream with `NDJSON_LINE_TOO_LONG` and is never delivered, so nothing is buffered
 *  without bound; a line that is not JSON ends it with `failed` through the stream's usual handler-error path. */
export function ndjson(stream: LinkStream, opts: NdjsonOptions = {}): NdjsonStream {
  const maxLine = opts.maxLine ?? NDJSON_MAX_LINE;
  if (!Number.isInteger(maxLine) || maxLine < 1) throw new Error('bad ndjson maxLine');
  const decode = new TextDecoder();
  let parts: Uint8Array[] = [];
  let buffered = 0;
  let failed = false;

  const untilNewline = (): number => {
    let at = 0;
    for (const p of parts) {
      const i = p.indexOf(10);
      if (i !== -1) return at + i;
      at += p.byteLength;
    }
    return -1;
  };
  const take = (n: number): Uint8Array => {
    const out = new Uint8Array(n);
    for (let at = 0; at < n;) {
      const p = parts[0];
      const k = Math.min(p.byteLength, n - at);
      out.set(p.subarray(0, k), at);
      at += k;
      parts = k === p.byteLength ? parts.slice(1) : [p.subarray(k), ...parts.slice(1)];
    }
    return out;
  };

  return {
    stream,
    send(message: unknown) {
      const line = JSON.stringify(message);
      if (line === undefined) throw new Error('ndjson cannot send undefined');
      return stream.write(`${line}\n`);
    },
    onMessage(fn: (message: unknown) => void | Promise<void>) {
      stream.onData = async (chunk: Uint8Array) => {
        if (failed) return;
        parts.push(chunk);
        buffered += chunk.byteLength;
        for (;;) {
          const at = untilNewline();
          if (at === -1) {
            if (buffered > maxLine) {
              failed = true;
              parts = [];
              buffered = 0;
              stream.end(NDJSON_LINE_TOO_LONG);
            }
            return;
          }
          const line = decode.decode(take(at));
          take(1); // the '\n'
          buffered -= at + 1;
          if (line.length > 0) await fn(JSON.parse(line));
        }
      };
    },
    end(error?: string) { stream.end(error); },
  };
}

const count = (n: unknown, max: number) => {
  if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > max) throw new Error('bad stream message');
  return n as number;
};

/** One connection's streams. */
export class Streams {
  private all = new Map<number, LinkStream>();
  private wire: StreamWire;
  private next = 1;

  constructor(wire: StreamWire) { this.wire = wire; }

  get size() { return this.all.size; }
  has(id: number) { return this.all.has(id); }

  /** Registers a stream under `id` (a device picks its own ids; the host takes the device's). */
  add(id: number, op: string, args: unknown): LinkStream {
    const s = new LinkStream(id, op, args, this.wire, () => this.all.delete(id));
    this.all.set(id, s);
    return s;
  }

  /** The device's side: asks the host for a stream; rejects with the host's reason if it says no. */
  open(op: string, args: unknown): Promise<LinkStream> {
    const s = this.add(this.next++, op, args);
    const opened = s.waitOpened();
    try { this.wire.send({ t: 'open', s: s.id, op, args, credit: WINDOW }); }
    catch (e) { s.ended('failed'); return opened.catch(() => { throw e; }); }
    return opened;
  }

  /** Handles `m` if it belongs to a stream (false if not). Throws on one that breaks the rules, so the caller drops
   *  the socket. Messages for a stream already ended here are late, not wrong, and are dropped. */
  message(m: any): boolean {
    if (!['data', 'credit', 'end', 'opened'].includes(m?.t)) return false;
    const s = this.all.get(count(m.s, 2 ** 32 - 1));
    if (m.t === 'data') {
      if (!(m.d instanceof Uint8Array)) throw new Error('bad stream message');
      s?.received(m.d);
    } else if (m.t === 'credit') s?.granted(count(m.n, 2 ** 31));
    else if (m.t === 'opened') s?.opened(count(m.credit, 2 ** 31));
    else s?.ended(typeof m.error === 'string' ? m.error.slice(0, 200) : undefined);
    return true;
  }

  /** The connection is gone: every stream ends with `error`. */
  closeAll(error: string) { for (const s of [...this.all.values()]) s.ended(error); }
}
