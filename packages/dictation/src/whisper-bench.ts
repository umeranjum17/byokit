import { spawn } from 'node:child_process';
import type { WhisperRnResult } from './whisper.ts';

/** Desktop-only protocol for the matching whisper.rn vendored engine. */
export type BenchOptions = { language?: string; maxThreads?: number; audioCtx?: number; tokenTimestamps?: boolean; maxLen?: number;
  beamSize?: number; bestOf?: number; temperature?: number; temperatureInc?: number; prompt?: string };
export type BenchResult = WhisperRnResult & { ms: number };
export type WhisperBench = { read(pcm: Int16Array, options: BenchOptions): Promise<BenchResult>; close(): Promise<void> };

export async function openWhisperBench(binary: string, model: string, timeoutMs: number): Promise<WhisperBench> {
  const child = spawn(binary, [model], { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '', stderr = '', failure: Error | undefined;
  let pending: { accept(value: { ready?: boolean; code?: number; ms?: number; segments?: WhisperRnResult['segments'] }): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const closed = new Promise<void>(resolve => child.once('close', () => { clearTimeout(kill); resolve(); }));
  const fail = (error: Error) => {
    failure = error;
    if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = undefined; }
    child.kill('SIGTERM'); kill ??= setTimeout(() => child.kill('SIGKILL'), 1000);
  };
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
  child.once('error', fail);
  child.once('close', code => { if (pending) fail(new Error(`Whisper bench exited ${code}: ${stderr}`)); });
  child.stdin.on('error', fail);
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    if (buffer.length > 8 * 1024 * 1024) { fail(new Error('Whisper bench reply too large')); return; }
    let end: number;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!pending) { fail(new Error('Unexpected Whisper bench reply')); return; }
      try {
        const value = JSON.parse(line);
        const current = pending; pending = undefined; clearTimeout(current.timer); current.accept(value);
      } catch { fail(new Error('Invalid Whisper bench reply')); }
    }
  });
  const next = () => new Promise<{ ready?: boolean; code?: number; ms?: number; segments?: WhisperRnResult['segments'] }>((accept, reject) => {
    if (failure) { reject(failure); return; }
    if (pending) { reject(new Error('Whisper bench accepts one reading at a time')); return; }
    pending = { accept, reject, timer: setTimeout(() => fail(new Error('Whisper bench timed out')), timeoutMs) };
  });
  try { if (!(await next()).ready) throw new Error('Whisper bench did not become ready'); }
  catch (error) { fail(error as Error); await closed; throw error; }
  return {
    async read(pcm, options) {
      const response = next();
      const fields = Object.entries(options).filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(typeof v === 'boolean' ? Number(v) : v!)}`);
      const bytes = Buffer.alloc(pcm.length * 2);
      for (let i = 0; i < pcm.length; i++) bytes.writeInt16LE(pcm[i], i * 2);
      child.stdin.write(`${fields.join(' ')} bytes=${bytes.length}\n`); child.stdin.write(bytes);
      const value = await response;
      if (value.code !== 0 || !Number.isFinite(value.ms) || !Array.isArray(value.segments)) throw new Error('Whisper bench inference failed');
      return { result: value.segments.map(s => s.text).join('').trim(), segments: value.segments, ms: value.ms! };
    },
    async close() {
      child.stdin.end(); kill ??= setTimeout(() => child.kill('SIGKILL'), 1000);
      await closed;
    },
  };
}
