// `herdr terminal session <control|observe> <paneId>`: Herdr's own NDJSON terminal frames passed through untouched
// (docs/runtime-kits.md 6.5). Frames arrive byte-identical (split on `\n` only, no trimming); `send` writes one line
// plus `\n`. `pause`/`resume` stop and restart reading stdout, so a slow consumer holds Herdr back instead of
// buffering in the host. The env comes from the caller per 6.5 — never `process.env`.

import { spawn } from 'node:child_process';
import type { TerminalSession } from './types.ts';
import { missingBinary } from './cli.ts';

const STDERR_TAIL_BYTES = 4 * 1024;

export function openTerminal(bin: string, env: Record<string, string>, paneId: string,
  o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession {
  if (typeof bin !== 'string' || bin.length === 0) throw new Error('herdr: bin must be a non-empty string');
  if (typeof paneId !== 'string' || paneId.length === 0 || paneId.includes('\0')) {
    throw new Error('herdr: paneId must be a non-empty string without NUL');
  }
  const args = ['terminal', 'session', o.mode, paneId];
  if (o.mode === 'control') args.push('--takeover');       // takeover is a control-only flag (6.5)
  args.push('--cols', String(o.cols), '--rows', String(o.rows));
  const child = spawn(bin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });

  const frames = new Set<(line: string) => void>();
  let readyResolve: (() => void) | undefined;
  let readyReject: ((e: Error) => void) | undefined;
  let firstFrame = false;
  let stderrTail = Buffer.alloc(0);
  let pending = Buffer.alloc(0);
  let exitedSettled = false;
  let paused = false;

  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const exited = new Promise<{ code: number | null; stderrTail: string }>((resolve) => {
    const settle = (code: number | null) => {
      if (exitedSettled) return;
      exitedSettled = true;
      resolve({ code, stderrTail: stderrTail.toString('utf8') });
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      settle(null);
      readyReject?.(e.code === 'ENOENT' ? missingBinary(bin, 'no executable') : e);
    });
    child.on('close', (code) => settle(code));
  });

  child.on('close', () => {
    if (!firstFrame) readyReject?.(new Error(`herdr terminal exited before output: ${stderrTail.toString('utf8')}`));
  });

  // While paused, lines already read stay in `pending` and stdout stops reading, so the pipe fills and Herdr blocks.
  // A resume() from inside a handler must not deliver the next frame before this one reaches every handler.
  let delivering = false;
  const deliver = () => {
    if (delivering) return;
    delivering = true;
    try {
      for (let i = pending.indexOf(0x0a); i !== -1 && !paused; i = pending.indexOf(0x0a)) {
        const line = pending.subarray(0, i).toString('utf8');   // bytes between newlines, unmodified
        pending = pending.subarray(i + 1);
        if (!firstFrame) { firstFrame = true; readyResolve?.(); }
        for (const fn of frames) fn(line);
      }
    } finally { delivering = false; }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    deliver();
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = stderrTail.length + chunk.length > STDERR_TAIL_BYTES
      ? Buffer.concat([stderrTail, chunk]).subarray(-STDERR_TAIL_BYTES)
      : Buffer.concat([stderrTail, chunk]);
  });

  child.stdin.on('error', () => {});   // a send after the child died must not crash the host

  return {
    ready,
    onFrame(fn: (line: string) => void): () => void {
      frames.add(fn);
      return () => frames.delete(fn);
    },
    send(line: string): void {
      if (child.stdin.writable) child.stdin.write(line + '\n');
    },
    pause(): void {
      paused = true;
      child.stdout.pause();
    },
    resume(): void {
      paused = false;
      deliver();
      if (!paused) child.stdout.resume();   // a frame handler may have paused again
    },
    close(): void {
      child.kill();
      if (paused) child.stdout.removeAllListeners('data').resume();   // drain unread output so `exited` settles
    },
    exited,
  };
}
