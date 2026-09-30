// Env from nothing, argv, spawn, caps and the wall-clock guard (docs/capability-kits.md 5.4, D-G, D-K). Nothing here
// reads `process.env`, searches the PATH or runs a shell; every signal goes to the recorder's process group, as
// packages/herdr/src/supervise.ts does.
import { bundledRecorder } from './recorder-path.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { CONSENT_WINDOW_S } from './constants.ts';
import { CaptureError } from './errors.ts';
import type { CaptureOptions, MakeOptions, RecordOptions, Source } from './types.ts';

export type Spawned = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; aborted: boolean };
export type RecorderCall =
  | { verb: 'hello' }
  | { verb: 'stop' }
  | { verb: 'record'; o: RecordOptions }
  | { verb: 'make'; o: MakeOptions; captionsFile?: string };

const STREAM_CAP = 8 * 1024 * 1024;
const LINE_CAP = 64 * 1024;
const TAIL = 2048;
const KILL_AFTER_MS = 5_000;

/** HOME/XDG under join(stateDir, 'capture', 'home'), PATH=/usr/bin:/bin, LANG, plus display vars by source. */
export function recorderEnv(o: { stateDir: string; source?: Source; display?: CaptureOptions['display'] }): Record<string, string> {
  const home = join(o.stateDir, 'capture', 'home');
  const env: Record<string, string> = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_STATE_HOME: join(home, '.local/state'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local/share'),
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
  };
  const display = o.display ?? {};
  if (o.source === 'screen') {
    for (const k of ['WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE'] as const) {
      if (display[k] !== undefined) env[k] = display[k];
    }
  } else if (o.source?.startsWith('x11:')) {
    env['DISPLAY'] = o.source.slice('x11:'.length);
    if (display.XAUTHORITY !== undefined) env['XAUTHORITY'] = display.XAUTHORITY;
  }
  return env;
}

function checkArgs(args: string[]): void {
  for (const a of args) {
    if (typeof a !== 'string' || a.includes('\0')) throw new CaptureError('invalid', 'every recorder argument must be a string without NUL');
  }
}

/** Starts ['capture', verb, …]; every element a string without NUL. */
export function recorderArgv(stateDir: string, call: RecorderCall): string[] {
  const recorderDir = join(stateDir, 'capture', 'recorder');
  let args: string[];
  if (call.verb === 'hello') args = ['capture', 'hello'];
  else if (call.verb === 'stop') args = ['capture', 'stop', '--state-dir', recorderDir];
  else if (call.verb === 'record') {
    const o = call.o;
    args = ['capture', 'record', '--source', o.source, '--root', o.root, '--state-dir', recorderDir,
      '--events', o.events ?? 'none', '--max-seconds', String(o.maxSeconds)];
  } else {
    const o = call.o;
    args = ['capture', 'make', o.take];
    if (o.planOnly) args.push('--plan-only');
    if (o.plannerKey !== undefined) args.push('--planner-key-fd', '3', '--max-tokens', String(o.maxTokens));
    else args.push('--no-planner');
    if (o.title !== undefined) args.push('--title', o.title);
    if (call.captionsFile !== undefined) args.push('--captions', call.captionsFile);
    for (const [k, v] of Object.entries(o.set ?? {})) args.push('--set', `${k}=${v}`);
  }
  checkArgs(args);
  return args;
}

/** Explicit bins are absolute executable files; the bundled entry runs through the current Node. */
function checkBin(bin: string): void {
  if (typeof bin !== 'string' || !isAbsolute(bin)) throw new CaptureError('missing', 'the recorder must be an absolute path');
  try {
    if (!statSync(bin).isFile()) throw new Error('not a file');
    if (bin !== bundledRecorder) accessSync(bin, constants.X_OK);
  } catch {
    throw new CaptureError('missing', 'the recorder is not an executable file');
  }
}

const spawnFailed = (e: NodeJS.ErrnoException): CaptureError =>
  e.code === 'ENOENT' || e.code === 'EACCES'
    ? new CaptureError('missing', 'the recorder could not be started')
    : new CaptureError('failed', 'the recorder could not be started', { detail: { recorderCode: e.code } });

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
}
/** SIGTERM to the group now and SIGKILL 5 s later; the caller clears the returned timer once the process closed. */
function terminate(child: ChildProcess): NodeJS.Timeout {
  killGroup(child, 'SIGTERM');
  return setTimeout(() => killGroup(child, 'SIGKILL'), KILL_AFTER_MS);
}

/** One call to completion: timeout (SIGTERM, SIGKILL 5 s later), 8 MB per stream, key on fd 3 only. */
export async function runRecorder(
  bin: string, env: Record<string, string>, args: string[],
  o: { timeoutMs: number; key?: string; signal?: AbortSignal },
): Promise<Spawned> {
  checkBin(bin);
  checkArgs(args);
  if (o.signal?.aborted) return { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true };
  const withKey = o.key !== undefined;
  const child = spawn(bin === bundledRecorder ? process.execPath : bin, bin === bundledRecorder ? [bin, ...args] : args, { env, detached: true, stdio: withKey ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  if (withKey) {
    const fd3 = child.stdio[3] as NodeJS.WritableStream;
    fd3.on('error', () => { /* the recorder closed fd 3 early; its answer says what happened */ });
    fd3.end(o.key as string);
  }
  return new Promise<Spawned>((resolve, reject) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let aborted = false;
    let fault: CaptureError | undefined;
    let killer: NodeJS.Timeout | undefined;
    const stopWith = (mark: () => void) => {
      if (killer !== undefined || fault !== undefined || timedOut || aborted) return;
      mark();
      killer = terminate(child);
    };
    const timer = setTimeout(() => stopWith(() => { timedOut = true; }), o.timeoutMs);
    const onAbort = () => stopWith(() => { aborted = true; });
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const collect = (chunks: Buffer[], chunk: Buffer, len: number): number => {
      if (killer !== undefined) return len;
      if (len + chunk.length > STREAM_CAP) {
        stopWith(() => { fault = new CaptureError('too-much-output', 'the recorder wrote more than 8 MB'); });
        return len;
      }
      chunks.push(chunk);
      return len + chunk.length;
    };
    child.stdout!.on('data', (chunk: Buffer) => { outLen = collect(out, chunk, outLen); });
    child.stderr!.on('data', (chunk: Buffer) => { errLen = collect(err, chunk, errLen); });
    const done = () => {
      clearTimeout(timer);
      clearTimeout(killer);
      o.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e: NodeJS.ErrnoException) => { done(); reject(spawnFailed(e)); });
    child.on('close', (code) => {
      done();
      if (fault) { reject(fault); return; }
      resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), exitCode: code, timedOut, aborted });
    });
  });
}

/** A record process as lines; past `guardMs` it stops itself and `exited` reports guarded: true. */
export function streamRecorder(
  bin: string, env: Record<string, string>, args: string[], o: { guardMs: number },
): { lines: AsyncIterable<string>; exited: Promise<Spawned & { guarded: boolean }>; kill(signal: NodeJS.Signals): void } {
  checkBin(bin);
  checkArgs(args);
  const child = spawn(bin === bundledRecorder ? process.execPath : bin, bin === bundledRecorder ? [bin, ...args] : args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const queue: string[] = [];
  const waiters: Array<{ resolve: (r: IteratorResult<string>) => void; reject: (e: unknown) => void }> = [];
  let ended = false;
  let fault: unknown;
  let guarded = false;
  let killer: NodeJS.Timeout | undefined;
  let partial = Buffer.alloc(0);
  let outLen = 0;
  let tail = '';

  const flush = () => {
    while (waiters.length > 0 && (queue.length > 0 || ended)) {
      const w = waiters.shift()!;
      if (queue.length > 0) w.resolve({ value: queue.shift()!, done: false });
      else if (fault !== undefined) w.reject(fault);
      else w.resolve({ value: undefined, done: true });
    }
  };
  const end = (why?: unknown) => {
    if (ended) return;
    ended = true;
    if (why !== undefined) { fault = why; queue.length = 0; }
    flush();
  };
  const stopSelf = (why?: unknown) => {
    end(why);
    if (killer === undefined) killer = terminate(child);
  };
  // The guard: after it fires nothing more is read, so a `done` printed on the way down is dropped (5.3).
  const guard = setTimeout(() => { guarded = true; stopSelf(); }, o.guardMs);

  child.stdout!.on('data', (chunk: Buffer) => {
    if (ended) return;
    outLen += chunk.length;
    if (outLen > STREAM_CAP) { stopSelf(new CaptureError('too-much-output', 'the recorder wrote more than 8 MB')); return; }
    partial = Buffer.concat([partial, chunk]);
    let nl: number;
    while ((nl = partial.indexOf(0x0a)) >= 0 && nl <= LINE_CAP) {
      queue.push(partial.subarray(0, nl).toString('utf8'));
      partial = partial.subarray(nl + 1);
    }
    if (nl > LINE_CAP || (nl < 0 && partial.length > LINE_CAP)) {
      stopSelf(new CaptureError('protocol', 'the recorder wrote a line over 64 KB'));
      return;
    }
    flush();
  });
  child.stdout!.on('end', () => {
    if (!ended && partial.length > 0) queue.push(partial.toString('utf8'));
    end();
  });
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => { tail = (tail + chunk).slice(-TAIL); });

  const exited = new Promise<Spawned & { guarded: boolean }>((resolve) => {
    const settle = (exitCode: number | null) => {
      clearTimeout(guard);
      clearTimeout(killer);
      end();
      resolve({ stdout: '', stderr: tail, exitCode, timedOut: guarded, aborted: false, guarded });
    };
    child.on('error', (e: NodeJS.ErrnoException) => { end(spawnFailed(e)); settle(null); });
    child.on('close', (code) => settle(code));
  });

  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<string>>((resolve, reject) => { waiters.push({ resolve, reject }); flush(); }),
      return: async () => { end(); return { value: undefined, done: true }; },
    }),
  };
  return { lines, exited, kill: (signal) => { if (child.pid !== undefined) killGroup(child, signal); } };
}

/** (maxSeconds + CONSENT_WINDOW_S + 30) * 1000. */
export function recordGuardMs(maxSeconds: number): number {
  return (maxSeconds + CONSENT_WINDOW_S + 30) * 1000;
}
