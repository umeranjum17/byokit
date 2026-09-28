// `herdr <args>` with the kit's own env, one argv entry per argument, no environment read
// (docs/runtime-kits.md 6.5, D13). The env comes from the supervisor (6.3) in `own` mode or is the
// fixed adopt env in 6.5; this module passes it through verbatim and never touches `process.env`.

import { spawn } from 'node:child_process';

export type CliResult = { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean };

// The doc's ceiling: an 8 MB cap per stream, timeouts clamped to 1 s–5 min (docs/runtime-kits.md §11.3 H4).
const MAX_BUFFER = 8 * 1024 * 1024;
const MIN_TIMEOUT = 1_000;
const MAX_TIMEOUT = 5 * 60_000;
export const DEFAULT_CLI_TIMEOUT = 15_000; // same default as a socket call (6.3)

/** ENOENT and friends carry the kit's `missing/binary` code (6.3/6.5), message per the 6.3 error shape. */
export function missingBinary(bin: string, cause = 'spawn failed'): Error {
  const e = new Error(`herdr: missing/binary: ${cause}: ${bin}`) as Error & { code?: string };
  e.code = 'missing/binary';
  return e;
}

/** argv goes one entry per execve argument (spaces and quotes survive); reject anything execve would mangle. */
function checkArgs(args: string[]): void {
  if (!Array.isArray(args) || args.length === 0) throw new Error('herdr: args must be a non-empty array of strings');
  for (const a of args) {
    if (typeof a !== 'string') throw new Error('herdr: every arg must be a string');
    if (a.includes('\0')) throw new Error('herdr: args must not contain NUL');
  }
}

function clampTimeout(timeoutMs: number | undefined): number {
  return Math.min(Math.max(timeoutMs ?? DEFAULT_CLI_TIMEOUT, MIN_TIMEOUT), MAX_TIMEOUT);
}

export function runCli(bin: string, env: Record<string, string>, args: string[], timeoutMs?: number):
  Promise<CliResult> {
  if (typeof bin !== 'string' || bin.length === 0) throw new Error('herdr: bin must be a non-empty string');
  checkArgs(args);
  const timeout = clampTimeout(timeoutMs);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      settle({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
               exitCode: null, timedOut: true });
    }, timeout);
    const settle = (r?: CliResult, e?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e !== undefined) reject(e); else resolve(r!);
    };
    child.on('error', (e: NodeJS.ErrnoException) => {
      settle(undefined, e.code === 'ENOENT' ? missingBinary(bin, 'no executable') : e);
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      outLen += chunk.length;
      if (outLen > MAX_BUFFER) { child.kill(); settle(undefined, new Error('herdr: stdout exceeded the 8 MB buffer')); return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (settled) return;
      errLen += chunk.length;
      if (errLen > MAX_BUFFER) { child.kill(); settle(undefined, new Error('herdr: stderr exceeded the 8 MB buffer')); return; }
      err.push(chunk);
    });
    child.on('close', (code) => {
      settle({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'),
               exitCode: code, timedOut });
    });
  });
}
