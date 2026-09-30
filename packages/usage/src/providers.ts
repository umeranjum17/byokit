import { spawn } from 'node:child_process';
import type { Code, Source } from './types.ts';
import { record, type CodexRateLimitResult } from './windows.ts';
export interface Answer { raw?: unknown; code?: Code; until?: number }
export async function providerGet(source: Extract<Source, { key: string }>, fetcher: typeof fetch, nowMs: number): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const url = source.provider === 'opencode' ? 'https://opencode.ai/zen/go/v1/usage' : 'https://api.z.ai/api/monitor/usage/quota/limit';
    const response = await fetcher(url, { headers: { accept: 'application/json', authorization: `Bearer ${source.key}` }, redirect: 'error', signal: controller.signal });
    if (response.status === 429) {
      const retry = response.headers.get('retry-after'); const seconds = Number(retry);
      const delay = retry !== null && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retry ?? '') - nowMs;
      controller.abort();
      return { code: 'rate-limited', until: nowMs + Math.max(300_000, Number.isFinite(delay) ? delay : 0) };
    }
    if (response.status !== 200) { controller.abort(); return { code: response.status === 401 ? 'auth' : response.status === 403 ? 'no-plan' : 'unavailable' }; }
    if (!response.body) return { code: 'incomplete' };
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      size += chunk.byteLength;
      if (size > 64 * 1024) { controller.abort(); return { code: 'incomplete' }; }
      chunks.push(chunk);
    }
    let raw: unknown;
    try { raw = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { code: 'incomplete' }; }
    if (!record(raw)) return { code: 'incomplete' };
    if (source.provider === 'zai' && raw.success === false) return { code: 'no-plan' };
    return { raw: source.provider === 'opencode' ? raw.usage : record(raw.data) ? raw.data.limits : undefined };
  } catch { return { code: 'unavailable' }; } finally { clearTimeout(timer); }
}
export function codexUsage(source: Extract<Source, { provider: 'codex' }>): Promise<Answer> {
  return new Promise((resolve) => {
    const child = spawn(source.bin, ['app-server'], { env: { ...source.env, CODEX_HOME: source.home }, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = ''; let bytes = 0; let settled = false; let escalation: NodeJS.Timeout | undefined;
    const finish = (answer: Answer) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        escalation = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 1000);
      }
      resolve(answer);
    };
    const timer = setTimeout(() => finish({ code: 'unavailable' }), 20_000);
    child.once('error', () => finish({ code: 'unavailable' }));
    child.once('close', () => { clearTimeout(escalation); finish({ code: 'unavailable' }); });
    child.stdin.on('error', () => finish({ code: 'unavailable' }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk); buffer += chunk;
      if (bytes > 64 * 1024) { finish({ code: 'incomplete' }); return; }
      for (;;) {
        const newline = buffer.indexOf('\n'); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (!record(message)) continue;
          if (message.id === 1) child.stdin.write(`${JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} })}\n`);
          if (message.id === 2) finish(record(message.result) ? { raw: message.result as CodexRateLimitResult } : { code: 'incomplete' });
        } catch { /* Non-JSON output is bounded and ignored. */ }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'byokit', version: '1' } } })}\n`);
  });
}
