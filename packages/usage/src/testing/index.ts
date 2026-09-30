import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export { usageContract, type UsageContractBench, type UsageContractTestFn } from './contract.ts';
export interface FakeAnswer { status?: number; body?: unknown; retryAfter?: string; text?: string }
/** Deterministic HTTP responses, never an endpoint. Calls preserve the exact request. */
export function fakeFetch(initial: FakeAnswer[] = []) {
  const queue = [...initial]; const calls: { url: string; init?: RequestInit }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = queue.shift() ?? { status: 503 };
    return new Response(answer.text ?? JSON.stringify(answer.body ?? {}), { status: answer.status ?? 200,
      headers: answer.retryAfter === undefined ? {} : { 'retry-after': answer.retryAfter } });
  };
  return { fetch, calls, push: (...answers: FakeAnswer[]) => { queue.push(...answers); } };
}
export interface FakeCodexScript { raw?: unknown; corrupt?: boolean; flood?: boolean; hang?: boolean; ignoreTerm?: boolean }
export interface FakeCodex {
  bin: string;
  script(value: FakeCodexScript): void;
  invocations(): { argv: string[]; env: Record<string, string>; requests: unknown[] }[];
}
/** Writes a fake app-server only under the caller's scratch directory. */
export function fakeCodex(options: { dir: string; raw?: unknown }): FakeCodex {
  mkdirSync(options.dir, { recursive: true });
  const bin = join(options.dir, 'codex'); const script = join(options.dir, 'script.json'); const log = join(options.dir, 'calls.jsonl');
  writeFileSync(script, JSON.stringify({ raw: options.raw })); writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(${JSON.stringify(script)}, 'utf8'));
const call = { argv: process.argv.slice(2), env: process.env, requests: [] };
if (config.ignoreTerm) process.on('SIGTERM', () => {});
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const i = buffer.indexOf('\\n'); if (i < 0) break;
    const request = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    call.requests.push(request);
    if (request.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));
    if (request.id === 2) {
      fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
      if (config.hang) continue;
      if (config.flood) { console.log('x'.repeat(65537)); continue; }
      console.log(config.corrupt ? JSON.stringify({ id: 2, result: null }) : JSON.stringify({ id: 2, result: config.raw }));
    }
  }
});
`, { mode: 0o755 });
  return { bin, script: (value) => writeFileSync(script, JSON.stringify(value)), invocations: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((s) => JSON.parse(s) as ReturnType<FakeCodex['invocations']>[number]) };
}
