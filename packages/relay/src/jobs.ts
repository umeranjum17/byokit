// Job history belongs to the host, never the blind relay. Link handles authentication, encryption and backpressure.
import { b64url, unb64url, PublicLinkError, type LinkStream } from '@byokit/pair';

export type JobPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: Uint8Array }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'end'; error?: string };
export type JobFrame = JobPart & { job: string; seq: number };
export type JobCursor = { job: string; after?: number };
export type JobChannelOptions = { maxJobs?: number; maxFrames?: number; maxBytes?: number };
export type JobWriter = { append(part: JobPart): number };

/** Maximum UTF-8 JSON bytes in one frame (image bytes are base64url on the encrypted wire). Split larger images. */
export const MAX_JOB_FRAME_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
const validCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
function limit(n: number | undefined, fallback: number) {
  if (n === undefined) return fallback;
  if (!validCount(n) || n === 0) throw new Error('Invalid job limit.');
  return n;
}

// Hermes need not provide TextDecoder. Keep incomplete UTF-8 as bytes until a full JSON line arrives.
function byteString(bytes: Uint8Array): string {
  let out = '';
  for (let at = 0; at < bytes.length; at += 8192) out += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return out;
}
function utf8(bytes: string): string {
  let out = '';
  for (let at = 0; at < bytes.length;) {
    let point = bytes.charCodeAt(at++);
    if (point < 0x80) { out += String.fromCharCode(point); continue; }
    const more = point >= 0xc2 && point <= 0xdf ? 1 : point >= 0xe0 && point <= 0xef ? 2 : point >= 0xf0 && point <= 0xf4 ? 3 : 0;
    if (!more || at + more > bytes.length) throw new Error('Invalid job text.');
    point &= (1 << (6 - more)) - 1;
    for (let i = 0; i < more; i++) {
      const next = bytes.charCodeAt(at++);
      if (next < 0x80 || next > 0xbf) throw new Error('Invalid job text.');
      point = (point << 6) | (next & 0x3f);
    }
    const minimum = more === 1 ? 0x80 : more === 2 ? 0x800 : 0x10000;
    if (point < minimum || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new Error('Invalid job text.');
    out += String.fromCodePoint(point);
  }
  return out;
}

function decode(value: unknown): JobFrame {
  const f = value as any;
  if (!f || !validId(f.job) || !validCount(f.seq) || f.seq === 0) throw new Error('Invalid job frame.');
  const head = { job: f.job as string, seq: f.seq as number };
  if (f.type === 'text' && typeof f.text === 'string') return { ...head, type: 'text', text: f.text };
  if (f.type === 'image' && typeof f.mime === 'string' && /^image\/[a-zA-Z0-9.+-]+$/.test(f.mime) && typeof f.data === 'string') {
    return { ...head, type: 'image', mime: f.mime, data: new Uint8Array(unb64url(f.data)) };
  }
  if (f.type === 'usage' && f.usage && typeof f.usage === 'object' && !Array.isArray(f.usage)
    && Object.values(f.usage).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) {
    return { ...head, type: 'usage', usage: f.usage };
  }
  if (f.type === 'end' && (f.error === undefined || typeof f.error === 'string')) {
    return { ...head, type: 'end', ...(f.error === undefined ? {} : { error: f.error }) };
  }
  throw new Error('Invalid job frame.');
}

type History = { frames: Uint8Array[]; bytes: number; ended: boolean; wake: Set<() => void> };

/** Bounded, in-memory job history on the host. Retained jobs survive transport reconnects, not process restarts.
 *  The owner is an authenticated link grant id supplied by the host, never by request arguments. */
export class JobChannel {
  private jobs = new Map<string, Map<string, History>>();
  private count = 0;
  private bytes = 0;
  private maxJobs: number;
  private maxFrames: number;
  private maxBytes: number;

  constructor(options: JobChannelOptions = {}) {
    this.maxJobs = limit(options.maxJobs, 64);
    this.maxFrames = limit(options.maxFrames, 4096);
    this.maxBytes = limit(options.maxBytes, 8 * 1024 * 1024);
  }

  /** Create once before starting work. Reusing a retained id for this owner fails instead of running work twice. */
  create(job: string, owner: string): JobWriter {
    if (!validId(job) || !validId(owner)) throw new Error('Invalid job or owner.');
    if (this.jobs.get(owner)?.has(job)) throw new Error('Job already exists.');
    if (this.count >= this.maxJobs) throw new Error('Job history is full.');
    const h: History = { frames: [], bytes: 0, ended: false, wake: new Set() };
    let owned = this.jobs.get(owner);
    if (!owned) { owned = new Map(); this.jobs.set(owner, owned); }
    owned.set(job, h);
    this.count++;
    return { append: (part) => {
      if (this.jobs.get(owner)?.get(job) !== h || h.ended) throw new Error('Job has ended.');
      const seq = h.frames.length + 1;
      const wire = { ...part, job, seq, ...(part.type === 'image' ? { data: b64url(part.data) } : {}) };
      // Serialize now: later caller mutations must never change replayed history.
      const frame = decode(JSON.parse(JSON.stringify(wire)));
      const json = JSON.stringify({ ...frame, ...(frame.type === 'image' ? { data: b64url(frame.data) } : {}) });
      const bytes = encoder.encode(json + '\n');
      if (bytes.byteLength - 1 > MAX_JOB_FRAME_BYTES || h.frames.length >= this.maxFrames || this.bytes + bytes.byteLength > this.maxBytes) {
        throw new Error('Job history is full.');
      }
      h.frames.push(bytes);
      h.bytes += bytes.byteLength;
      this.bytes += bytes.byteLength;
      h.ended = frame.type === 'end';
      for (const wake of h.wake) wake();
      return seq;
    } };
  }

  /** Release history by app policy (retention, cancellation or grant removal). Existing followers are ended. */
  drop(job: string, owner: string): boolean {
    const owned = this.jobs.get(owner), h = owned?.get(job);
    if (!h) return false;
    owned!.delete(job);
    if (!owned!.size) this.jobs.delete(owner);
    this.bytes -= h.bytes;
    this.count--;
    for (const wake of h.wake) wake();
    return true;
  }

  /** Use from Host.stream. Replays after the cursor, then follows live frames until end or socket loss. */
  async follow(stream: LinkStream, cursor: JobCursor, owner: string): Promise<void> {
    const after = cursor?.after ?? 0;
    const h = this.jobs.get(owner)?.get(cursor?.job);
    if (!h || !validCount(after) || after > h.frames.length) throw new PublicLinkError('That job history is unavailable.');
    let closed = false, wake: (() => void) | undefined;
    const notify = () => {
      if (this.jobs.get(owner)?.get(cursor.job) !== h) stream.end('ended');
      wake?.();
    };
    stream.onEnd = () => { closed = true; notify(); };
    // Jobs are host-to-device; reject incoming bytes instead of retaining an unread duplex window.
    stream.onData = () => { stream.end('not-allowed'); };
    h.wake.add(notify);
    try {
      let at = after;
      while (!closed) {
        if (this.jobs.get(owner)?.get(cursor.job) !== h) { stream.end('ended'); return; }
        if (at < h.frames.length) { await stream.write(h.frames[at++]!); continue; }
        if (h.ended) { stream.end(); return; }
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    } catch (error) {
      if (!closed) { stream.end('failed'); throw error; }
    } finally { h.wake.delete(notify); }
  }
}

/** Read ordered job frames. Await onFrame before advancing the cursor; persist it with the applied output.
 *  Resolves with the final cursor on a clean end; rejects on loss so the app can reopen after its saved cursor. */
export function readJobStream(stream: LinkStream, cursor: JobCursor, onFrame: (frame: JobFrame) => void | Promise<void>): Promise<number> {
  if (!validId(cursor.job) || !validCount(cursor.after ?? 0)) return Promise.reject(new Error('Invalid job cursor.'));
  return new Promise((resolve, reject) => {
    let pending = '', seq = cursor.after ?? 0, ended = false, failed = false;
    const fail = (error: unknown) => { failed = true; stream.end('failed'); reject(error); };
    let reading = Promise.resolve();
    const consume = async (bytes: Uint8Array) => {
      if (failed) return;
      try {
        pending += byteString(bytes);
        for (let newline = pending.indexOf('\n'); newline >= 0; newline = pending.indexOf('\n')) {
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          if (line.length > MAX_JOB_FRAME_BYTES) throw new Error('Job frame is too large.');
          const frame = decode(JSON.parse(utf8(line)));
          if (ended || frame.job !== cursor.job || frame.seq !== seq + 1) throw new Error('Job frames are out of order.');
          await onFrame(frame);
          seq = frame.seq;
          ended = frame.type === 'end';
        }
        if (pending.length > MAX_JOB_FRAME_BYTES) throw new Error('Job frame is too large.');
      } catch (error) { fail(error); }
    };
    stream.onData = (bytes) => { reading = consume(bytes); return reading; };
    stream.onEnd = async (error) => {
      await reading;
      if (failed) return;
      if (error) return reject(new Error('Job connection ended. Reconnect to resume.'));
      try {
        if (pending) throw new Error('Incomplete job frame.');
        resolve(seq);
      } catch (error) { reject(error); }
    };
  });
}
