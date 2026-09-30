import { retryAfterMs } from './backoff.ts';
import { spawn } from 'node:child_process';
import type { Code, Source, SourceAnswer } from './types.ts';
import { readJson, readJsonSnapshot } from './store.ts';
import { claudeWindows, record, type CodexRateLimitResult } from './windows.ts';
import { grokWindows } from './quota.ts';
export interface Answer { raw?: unknown; code?: Code; retryAfterMs?: number }
type TokenSource = Extract<Source, { access: string } | { key: string }>;
const USER_AGENT = 'byokit/usage/0.2.0';
/** One bounded request; credentials and response bodies never become errors. */
async function request(url: string, key: string, fetcher: typeof fetch, nowMs: number, extra: { headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetcher(url, { headers: { accept: 'application/json', authorization: `Bearer ${key}`, 'User-Agent': USER_AGENT,
      ...(extra.body !== undefined ? { 'content-type': 'application/json' } : {}), ...extra.headers },
      ...(extra.body !== undefined ? { method: 'POST', body: JSON.stringify(extra.body) } : {}), redirect: 'error', signal: controller.signal });
    if (response.status === 429) {
      const delay = retryAfterMs(response.headers.get('retry-after'), nowMs);
      controller.abort();
      return { code: 'rate-limited', retryAfterMs: delay };
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
    return record(raw) ? { raw } : { code: 'incomplete' };
  } catch { return { code: 'unavailable' }; } finally { clearTimeout(timer); }
}
export async function providerGet(source: TokenSource, fetcher: typeof fetch, nowMs: number): Promise<Answer> {
  const key = 'access' in source ? source.access : source.key;
  const get = (url: string, extra?: { headers?: Record<string, string>; body?: unknown }) => request(url, key, fetcher, nowMs, extra);
  switch (source.provider) {
    case 'claude': return get('https://api.anthropic.com/api/oauth/usage', { headers: { 'anthropic-beta': 'oauth-2025-04-20' } });
    case 'codex': return get('https://chatgpt.com/backend-api/wham/usage', { headers: { 'ChatGPT-Account-Id': source.accountId } });
    case 'copilot': return get('https://api.github.com/copilot_internal/user');
    case 'minimax': {
      const answer = await get('https://api.minimax.io/v1/token_plan/remains');
      return !answer.code && record(answer.raw) && record(answer.raw.base_resp) && answer.raw.base_resp.status_code !== 0 ? { code: 'no-plan' } : answer;
    }
    case 'kimi': return get('https://api.kimi.com/coding/v1/usages');
    case 'grok': {
      const answer = await get('https://cli-chat-proxy.grok.com/v1/billing?format=credits');
      if (answer.code) return answer;
      const config = record(answer.raw) && record(answer.raw.config) ? answer.raw.config : undefined;
      return config?.isUnifiedBillingUser === true || !grokWindows(answer.raw).length ? get('https://cli-chat-proxy.grok.com/v1/billing') : answer;
    }
    case 'gemini': {
      let project = source.project;
      if (!project) {
        const loaded = await get('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', { body: { metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } } });
        if (loaded.code) return loaded;
        const value = record(loaded.raw) ? loaded.raw.cloudaicompanionProject : undefined;
        project = typeof value === 'string' ? value : record(value) && typeof value.id === 'string' ? value.id : undefined;
      }
      return get('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', { body: project ? { project } : {} });
    }
    case 'opencode': return get('https://opencode.ai/zen/go/v1/usage');
    case 'zai': {
      const answer = await get('https://api.z.ai/api/monitor/usage/quota/limit');
      return !answer.code && record(answer.raw) && answer.raw.success === false ? { code: 'no-plan' } : answer;
    }
  }
}
/** A host hook gets the same deadline and failure envelope as built-in sources. */
export async function customClaude(source: Extract<Source, { read: unknown }>, nowMs: number): Promise<Answer> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([source.read({ nowMs, signal: controller.signal }), new Promise<SourceAnswer>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve({ code: 'unavailable' }); }, 10_000);
    })]);
  } catch { return { code: 'unavailable' }; } finally { clearTimeout(timer); }
}
export function codexUsage(source: Extract<Source, { bin: string }>): Promise<Answer> {
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

/** Re-read the tool's credentials so its own renewal is picked up; never renew or write them. */
export function claudeAuth(source: Extract<Source, { credentialsFile: string }>): { token: string; expiresAt?: number; account: string } | undefined {
  const stored = readJson(source.credentialsFile, 64 * 1024);
  const credentials = record(stored) && record(stored.claudeAiOauth) ? stored.claudeAiOauth : undefined;
  const token = credentials?.accessToken;
  if (!credentials || typeof token !== 'string' || !token.trim() || token.length > 16384 || token.includes('\0')) return undefined;
  const config = source.configFile ? readJson(source.configFile, 4 * 1024 * 1024) : undefined;
  const oauthAccount = record(config) && record(config.oauthAccount) ? config.oauthAccount : undefined;
  const identity = typeof credentials.accountUuid === 'string' ? credentials.accountUuid : typeof oauthAccount?.accountUuid === 'string' ? oauthAccount.accountUuid : `claude-file\0${source.credentialsFile}`;
  if (typeof identity !== 'string' || !identity || identity.length > 16384) return undefined;
  return { token, account: identity, ...(typeof credentials.expiresAt === 'number' && Number.isFinite(credentials.expiresAt) ? { expiresAt: credentials.expiresAt } : {}) };
}
export async function claudeUsage(source: Extract<Source, { credentialsFile: string }>, fetcher: typeof fetch, nowMs: number): Promise<Answer> {
  const snapshot = source.statuslineFile ? readJsonSnapshot(source.statuslineFile, 64 * 1024) : undefined;
  if (snapshot && nowMs >= snapshot.modified && nowMs - snapshot.modified < 300_000 && claudeWindows(snapshot.value).length) return { raw: snapshot.value };
  const auth = claudeAuth(source);
  if (!auth) return { code: 'not-connected' };
  if (auth.expiresAt !== undefined && auth.expiresAt <= nowMs) return { code: 'expired' };
  return providerGet({ provider: 'claude', access: auth.token }, fetcher, nowMs);
}
