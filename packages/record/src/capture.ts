// The client (docs/capability-kits.md 5.3): hello gate, record as an async iterator, stop, make, over supervise.ts
// (5.4) and protocol.ts (BK-C1).
import { bundledRecorder } from './recorder-path.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { DISPLAY_VARS } from './constants.ts';
import { CaptureError } from './errors.ts';
import { parseError, parseEvent, parseHello, parseMake, toCaptureError } from './protocol.ts';
import { recordGuardMs, recorderArgv, recorderEnv, runRecorder, streamRecorder, type Spawned } from './supervise.ts';
import type { CaptureOptions, MakeOptions, MakeResult, RecordEvent, RecordOptions, RecorderHello, SourceKind } from './types.ts';

const QUICK_MS = 10_000;
const STOP_GRACE_MS = 10_000;
const KILL_AFTER_MS = 5_000;
const SET_KEY = /^[a-z][a-z0-9_.-]{0,63}$/;
const X11_DISPLAY = /^:\d{1,4}(\.\d{1,2})?$/;
const ANDROID_SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;

type Running = { stream: ReturnType<typeof streamRecorder>; exited: boolean; stopTimers: NodeJS.Timeout[] };

const hasNul = (s: unknown): boolean => typeof s === 'string' && s.includes('\0');

/** The fallback when the recorder does not end by itself: SIGTERM to its group after 10 s, SIGKILL 5 s later. */
function armKill(running: Running): void {
  if (running.exited || running.stopTimers.length > 0) return;
  running.stopTimers.push(setTimeout(() => {
    running.stream.kill('SIGTERM');
    running.stopTimers.push(setTimeout(() => running.stream.kill('SIGKILL'), KILL_AFTER_MS));
  }, STOP_GRACE_MS));
}

function sourceKind(source: unknown): SourceKind | undefined {
  if (source === 'screen') return 'screen';
  if (typeof source !== 'string') return undefined;
  if (source.startsWith('x11:') && X11_DISPLAY.test(source.slice(4))) return 'x11';
  if (source.startsWith('android:') && ANDROID_SERIAL.test(source.slice(8))) return 'android';
  return undefined;
}

/** The one line a hello, stop or make answered, or the rejection its exit and envelope stand for (6.7). */
function answer(s: Spawned): string {
  if (s.timedOut) throw new CaptureError('timeout', 'the recorder did not answer in time');
  const line = s.stdout.trimEnd().split('\n').pop() ?? '';
  if (s.exitCode === 0) {
    if (line === '') throw new CaptureError('protocol', 'the recorder answered nothing');
    return line;
  }
  throw exitError(line === '' ? null : parseError(line), s.exitCode, s.stderr);
}

function exitError(err: ReturnType<typeof parseError>, exitCode: number | null, stderr: string): CaptureError {
  const stderrTail = stderr.slice(-2048);
  if (err) {
    const e = toCaptureError(err);
    if (e.code !== 'failed') return e;
    return new CaptureError('failed', e.message, { ...(e.hint === undefined ? {} : { hint: e.hint }), detail: { ...e.detail, stderrTail } });
  }
  if (exitCode === 0) return new CaptureError('protocol', 'the recorder ended without finishing the recording');
  return new CaptureError('failed', `the recorder exited with ${exitCode}`, { detail: { stderrTail } });
}

export class Capture {
  private readonly o: CaptureOptions & { bin: string };
  private greeting?: RecorderHello;
  private running?: Running;
  /** Validates only; spawns nothing and touches no disk. */
  constructor(o: CaptureOptions) {
    if (typeof o.stateDir !== 'string' || !isAbsolute(o.stateDir) || hasNul(o.stateDir)) {
      throw new CaptureError('invalid', 'stateDir must be an absolute path');
    }
    if (o.bin !== undefined && (typeof o.bin !== 'string' || !isAbsolute(o.bin) || hasNul(o.bin))) {
      throw new CaptureError('missing', 'bin must be an absolute path');
    }
    if (o.timeoutMs !== undefined && (typeof o.timeoutMs !== 'number' || !Number.isFinite(o.timeoutMs))) {
      throw new CaptureError('invalid', 'timeoutMs must be a finite number');
    }
    for (const [k, v] of Object.entries(o.display ?? {})) {
      if (!(DISPLAY_VARS as readonly string[]).includes(k) || typeof v !== 'string' || hasNul(v)) {
        throw new CaptureError('invalid', `display.${k} is not a display variable this kit passes`);
      }
    }
    this.o = { ...o, bin: o.bin ?? bundledRecorder };
  }

  /** join(stateDir, 'capture') and its home/, recorder/ and tmp/, mode 0700 (5.4). */
  private layout(): string {
    const root = join(this.o.stateDir, 'capture');
    for (const dir of ['home', 'recorder', 'tmp']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
    return root;
  }

  async hello(): Promise<RecorderHello> {
    if (this.greeting) return this.greeting;
    this.layout();
    const s = await runRecorder(this.o.bin, recorderEnv({ stateDir: this.o.stateDir }), recorderArgv(this.o.stateDir, { verb: 'hello' }), { timeoutMs: QUICK_MS });
    this.greeting = parseHello(answer(s));
    return this.greeting;
  }

  record(o: RecordOptions): AsyncIterableIterator<RecordEvent> {
    return this.recording(o);
  }

  private async *recording(o: RecordOptions): AsyncGenerator<RecordEvent, void, undefined> {
    const hello = await this.hello();
    const kind = sourceKind(o.source);
    if (kind === undefined) throw new CaptureError('invalid', 'the source does not match the recorder protocol grammar');
    const events = o.events ?? 'none';
    if (!hello.sources.includes(kind) || !hello.events.includes(events)) {
      throw new CaptureError('unsupported', 'the recorder does not offer that source or events mode');
    }
    if (typeof o.root !== 'string' || !isAbsolute(o.root) || hasNul(o.root)) throw new CaptureError('invalid', 'root must be an absolute path');
    if (!Number.isInteger(o.maxSeconds) || o.maxSeconds < 1 || o.maxSeconds > 3600) {
      throw new CaptureError('invalid', 'maxSeconds must be an integer from 1 to 3600');
    }
    if (this.running) throw new CaptureError('already-recording', 'this Capture already has a recording running');
    if (o.signal?.aborted) throw new CaptureError('stopped', 'the recording was stopped before it started');

    this.layout();
    const stream = streamRecorder(
      this.o.bin,
      recorderEnv({ stateDir: this.o.stateDir, source: o.source, display: this.o.display }),
      recorderArgv(this.o.stateDir, { verb: 'record', o: { ...o, events } }),
      { guardMs: recordGuardMs(o.maxSeconds) },
    );
    const running: Running = { stream, exited: false, stopTimers: [] };
    this.running = running;
    const exited = stream.exited.then((r) => {
      running.exited = true;
      for (const t of running.stopTimers) clearTimeout(t);
      return r;
    });
    let stopping: Promise<unknown> | undefined;
    const stopOnce = () => { stopping ??= this.stop().catch(() => {}); };
    let sawDone = false;
    o.signal?.addEventListener('abort', stopOnce, { once: true });
    try {
      let recorderError: CaptureError | undefined;
      for await (const line of stream.lines) {
        const err = parseError(line);
        if (err) { recorderError = toCaptureError(err); armKill(running); break; }
        const event = parseEvent(line);
        if (event === null) continue;
        if (event.event === 'done') { sawDone = true; o.signal?.removeEventListener('abort', stopOnce); }
        yield event;
        if (sawDone) {
          if ((await exited).guarded) throw new CaptureError('timeout', 'the recording ran past its wall-clock guard');
          return;
        }
      }
      const r = await exited;
      if (recorderError) throw recorderError;
      if (r.guarded) throw new CaptureError('timeout', 'the recording ran past its wall-clock guard');
      throw exitError(null, r.exitCode, r.stderr);
    } finally {
      o.signal?.removeEventListener('abort', stopOnce);
      // Ending early (return(), a thrown parse error): stop the recorder and resolve only once it has exited. After
      // `done` the recording is already over, so no `capture stop` goes out that a next recording could receive.
      if (!running.exited) {
        if (sawDone) armKill(running);
        else stopOnce();
      }
      await exited;
      await stopping;
      if (this.running === running) this.running = undefined;
    }
  }

  async stop(): Promise<'stopping' | 'not-recording'> {
    const running = this.running;
    if (running) armKill(running);
    this.layout();
    const s = await runRecorder(this.o.bin, recorderEnv({ stateDir: this.o.stateDir }), recorderArgv(this.o.stateDir, { verb: 'stop' }), { timeoutMs: QUICK_MS });
    let line: string;
    try {
      line = answer(s);
    } catch (e) {
      if (e instanceof CaptureError && e.detail?.['recorderCode'] === 'not-recording') return 'not-recording';
      throw e;
    }
    let value: unknown;
    try { value = JSON.parse(line); } catch { value = undefined; }
    if (typeof value !== 'object' || value === null || (value as { stopping?: unknown }).stopping !== true) {
      throw new CaptureError('protocol', 'the recorder answered an unexpected stop shape');
    }
    return 'stopping';
  }

  async make(o: MakeOptions): Promise<MakeResult> {
    const hello = await this.hello();
    if (o.plannerKey !== undefined && !hello.planner.available) {
      throw new CaptureError('unsupported', 'the recorder cannot plan a video');
    }
    if (typeof o.take !== 'string' || !isAbsolute(o.take)) throw new CaptureError('invalid', 'take must be an absolute path');
    const strings = [o.take, o.title, o.plannerKey, ...(o.captions ?? []).map((c) => c.text), ...Object.entries(o.set ?? {}).flat()];
    if (strings.some(hasNul)) throw new CaptureError('invalid', 'make options must not contain NUL');
    if (o.plannerKey !== undefined && (!Number.isInteger(o.maxTokens) || (o.maxTokens as number) < 1)) {
      throw new CaptureError('invalid', 'maxTokens must be a positive integer');
    }
    for (const k of Object.keys(o.set ?? {})) {
      if (!SET_KEY.test(k)) throw new CaptureError('invalid', 'a render setting has an unexpected name');
    }
    for (const c of o.captions ?? []) {
      if (typeof c.t !== 'number' || !Number.isFinite(c.t) || c.t < 0 || typeof c.text !== 'string') {
        throw new CaptureError('invalid', 'a caption needs a text and a start that is not negative');
      }
    }
    o.signal?.throwIfAborted();

    const root = this.layout();
    let captionsFile: string | undefined;
    try {
      if (o.captions !== undefined) {
        captionsFile = join(root, 'tmp', `${randomUUID()}.json`);
        writeFileSync(captionsFile, JSON.stringify(o.captions), { mode: 0o600, flag: 'wx' });
      }
      const timeoutMs = Math.min(Math.max(this.o.timeoutMs ?? 600_000, 1_000), 30 * 60_000);
      const s = await runRecorder(
        this.o.bin,
        recorderEnv({ stateDir: this.o.stateDir }),
        recorderArgv(this.o.stateDir, { verb: 'make', o, ...(captionsFile === undefined ? {} : { captionsFile }) }),
        { timeoutMs, ...(o.plannerKey === undefined ? {} : { key: o.plannerKey }), ...(o.signal ? { signal: o.signal } : {}) },
      );
      if (s.aborted) throw o.signal!.reason;
      return parseMake(answer(s));
    } finally {
      if (captionsFile !== undefined) rmSync(captionsFile, { force: true });
    }
  }
}
