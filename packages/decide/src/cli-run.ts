// Node-only: one bounded run of a host-named CLI binary, shared by the Claude and Codex seams.
import { spawn } from 'node:child_process';

export type CliRunFailure = 'process' | 'invalid_output' | 'timeout' | 'aborted';
export type CliRun = { cwd: string; env: Record<string, string | undefined>; deadline: number; signal?: AbortSignal; stdin?: string };

/** Resolves with the exit code and output; `stderr` is for the caller's own status parsing, never for an error message. */
export function runCli(bin: string, args: string[], o: CliRun, fail: (code: CliRunFailure) => Error): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(bin, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let size = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (code: CliRunFailure) => {
      failure ??= fail(code);
      child.kill();
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 250);
    };
    const abort = () => stop('aborted');
    const timer = setTimeout(() => stop('timeout'), Math.max(0, o.deadline - Date.now()));
    o.signal?.addEventListener('abort', abort, { once: true });
    if (o.signal?.aborted) abort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) stop('invalid_output');
      else stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { if (stderr.length < 64 * 1024) stderr += chunk; });
    child.on('error', () => { failure ??= fail('process'); });
    child.stdin.on('error', () => { failure ??= fail('process'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      o.signal?.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else resolveOutput({ code, stdout, stderr });
    });
    child.stdin.end(o.stdin);
  });
}
