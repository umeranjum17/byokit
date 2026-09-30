import { accessSync, constants, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { claudeAuth, claudeUsage, codexUsage, customClaude, providerGet, type Answer } from './providers.ts';
import { fingerprint, readJson, store, memoryUsageStore, safeWindows } from './store.ts';
import { claudeWindows, codexWindows, goWindows, record, zaiWindows, type CodexRateLimitResult } from './windows.ts';
import { codexTokenWindows, copilotWindows, grokWindows, minimaxWindows, geminiWindows, kimiWindows } from './quota.ts';
import { UsageError, type Reading, type ReadOptions, type Source, type Usage, type UsageOptions } from './types.ts';
export * from './types.ts';
export { tokenLedger, memoryTokenLedgerStore, TokenLedgerError, type TokenLedger, type TokenLedgerStore, type TokenLedgerOptions, type TokenEntry, type TokenQuery } from './ledger.ts';
export { roomOf } from './room.ts';
export { memoryUsageStore } from './store.ts';
export { claudeWindows, codexWindows, goWindows, zaiWindows, type CodexRateLimitResult } from './windows.ts';
export { codexTokenWindows, copilotWindows, grokWindows, minimaxWindows, geminiWindows, kimiWindows } from './quota.ts';
export { WORDS, words, usageWords, type WordKey } from './words.ts';
const providers = ['claude', 'codex', 'opencode', 'zai', 'copilot', 'grok', 'minimax', 'gemini', 'kimi'];
const validText = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0') && !/[\r\n]/.test(v) && v.length <= 16384;
function validate(source: Source): void {
  if (!record(source) || !providers.includes(source.provider)) throw new UsageError();
  if ('credentialsFile' in source) {
    if (source.provider !== 'claude' || ![source.credentialsFile, ...[source.configFile, source.statuslineFile].filter((v) => v !== undefined)].every((v) => validText(v) && isAbsolute(v))) throw new UsageError();
  } else if ('read' in source) {
    if (source.provider !== 'claude' || typeof source.read !== 'function' || !validText(source.accountUuid) || !source.accountUuid || source.connected !== undefined && typeof source.connected !== 'function') throw new UsageError();
  } else if ('bin' in source) {
    if (source.provider !== 'codex' || !validText(source.bin) || !isAbsolute(source.bin) || !validText(source.home) || !isAbsolute(source.home)) throw new UsageError();
    if (source.env !== undefined && (!record(source.env) || Object.entries(source.env).some(([k, v]) => !k || k.includes('=') || !validText(k) || !validText(v)))) throw new UsageError();
  } else {
    if ('key' in source && !['opencode', 'zai'].includes(source.provider) || 'access' in source && ['opencode', 'zai'].includes(source.provider)) throw new UsageError();
    const credential = 'access' in source ? source.access : 'key' in source ? source.key : undefined;
    if (!validText(credential)) throw new UsageError();
    if ('access' in source && source.provider === 'codex' && (!validText(source.accountId) || !source.accountId)) throw new UsageError();
  }
  const fields = source as unknown as Record<string, unknown>;
  for (const field of ['accountId', 'accountUuid', 'project']) if (fields[field] !== undefined && (!validText(fields[field]) || !fields[field])) throw new UsageError();
}
/** Claims provide a cache identity only; this does not authenticate or trust a token. */
function subject(access: string): string | undefined {
  try {
    const encoded = access.split('.')[1]; if (!encoded) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    return record(claims) && validText(claims.sub) && claims.sub ? claims.sub : undefined;
  } catch { return undefined; }
}
/** One reader owns per-account backoff and concurrent-read deduplication. */
export function usage(options: UsageOptions): Usage {
  if (options.stateDir !== undefined && (!validText(options.stateDir) || !isAbsolute(options.stateDir))) throw new UsageError();
  const disk = options.store ?? (options.stateDir ? store(options.stateDir) : memoryUsageStore());
  const transient = memoryUsageStore(); const fp = fingerprint(options.salt ?? 'byokit/usage/account');
  const backoffs = new Map<string, number>(); const inFlight = new Map<string, Promise<Reading>>();
  const attempts = new Map<string, { at: number; code?: Reading['code'] }>();
  const now = (opts?: ReadOptions) => opts?.nowMs ?? (options.now ?? Date.now)();
  function connected(source: Source): boolean {
    validate(source);
    if ('credentialsFile' in source) return claudeAuth(source) !== undefined;
    if ('read' in source) { try { return source.connected?.() ?? true; } catch { return false; } }
    if ('bin' in source) { try { accessSync(source.bin, constants.X_OK); return statSync(source.bin).isFile(); } catch { return false; } }
    return ('access' in source ? source.access : source.key).trim() !== '';
  }
  function account(source: Source): string | undefined {
    validate(source);
    let id: string | undefined;
    if ('credentialsFile' in source) id = claudeAuth(source)?.account;
    else if ('read' in source) id = source.accountUuid;
    else if ('bin' in source) {
      const raw = readJson(join(source.home, 'auth.json'), 64 * 1024);
      const tokens = record(raw) && record(raw.tokens) ? raw.tokens : undefined;
      id = typeof tokens?.account_id === 'string' ? tokens.account_id : `codex-home\0${source.home}`;
    } else id = source.accountId ?? (source.provider === 'claude' ? source.accountUuid : undefined) ?? ('access' in source ? subject(source.access) : undefined);
    return id && id.length <= 16384 ? fp(source.provider, id) : undefined;
  }
  function identity(source: Source): { key: string; stable: boolean } {
    const stable = account(source); if (stable) return { key: stable, stable: true };
    // Opaque credentials without an identity can be read, but never reach an app/disk store.
    const credential = 'access' in source ? source.access : 'key' in source ? source.key : '';
    return { key: createHash('sha256').update(`${source.provider}\0${credential}`).digest('hex'), stable: false };
  }
  function windows(source: Source, raw: unknown, clock: number): Reading['windows'] {
    switch (source.provider) {
      case 'claude': return claudeWindows(raw);
      case 'codex': return 'bin' in source ? codexWindows(raw as CodexRateLimitResult | undefined) : codexTokenWindows(raw);
      case 'opencode': return goWindows(record(raw) ? raw.usage : undefined);
      case 'zai': return zaiWindows(record(raw) && record(raw.data) ? raw.data.limits : undefined);
      case 'copilot': return copilotWindows(raw);
      case 'grok': return grokWindows(raw);
      case 'minimax': return minimaxWindows(raw);
      case 'gemini': return geminiWindows(raw);
      case 'kimi': return kimiWindows(raw, clock);
    }
  }
  function lastKnown(source: Source, opts?: ReadOptions): Reading | undefined {
    if (!connected(source)) return undefined;
    const id = identity(source); const clock = now(opts);
    try {
      const stored = (id.stable ? disk : transient).get(source.provider, id.key);
      if (!stored || !Number.isFinite(stored.at) || clock < stored.at || clock - stored.at > 86_400_000) return undefined;
      const rows = safeWindows(source.provider, stored.windows);
      return rows.length ? { provider: source.provider, windows: rows, at: stored.at } : undefined;
    } catch { return undefined; }
  }
  async function read(source: Source, opts?: ReadOptions): Promise<Reading> {
    validate(source); const clock = now(opts);
    const empty = (code: Reading['code']): Reading => ({ provider: source.provider, windows: [], at: clock, code });
    if (!connected(source)) return empty('not-connected');
    const id = identity(source); const key = `${source.provider}\0${id.key}`;
    const previous = lastKnown(source, { nowMs: clock });
    if (previous && clock - previous.at < 60_000) return previous;
    let until = backoffs.get(key) ?? 0;
    try { if (id.stable) until = Math.max(until, options.backoff?.get(source.provider, id.key) ?? 0); } catch { /* keep internal backoff */ }
    if (until > clock) return previous ? { ...previous, code: 'rate-limited' } : empty('rate-limited');
    const pending = inFlight.get(key); if (pending) return pending;
    const attempt = attempts.get(key);
    if (attempt && clock >= attempt.at && clock - attempt.at < 60_000) return previous ? { ...previous, code: attempt.code } : empty(attempt.code ?? 'unavailable');
    const task = (async () => {
      let answer: Answer;
      try {
        answer = 'read' in source ? await customClaude(source, clock) : 'credentialsFile' in source ? await claudeUsage(source, options.fetch ?? globalThis.fetch, clock)
          : 'bin' in source ? await codexUsage(source) : await providerGet(source, options.fetch ?? globalThis.fetch, clock);
      } catch { answer = { code: 'unavailable' }; }
      if (answer.code === 'rate-limited') {
        let delay = Math.max(300_000, Number.isFinite(answer.retryAfterMs) ? answer.retryAfterMs! : 0);
        try { const selected = options.backoff?.delayMs?.(answer.retryAfterMs); if (selected !== undefined && Number.isFinite(selected) && selected >= 0) delay = selected; } catch { /* default */ }
        backoffs.set(key, clock + delay);
        try { if (id.stable) options.backoff?.set(source.provider, id.key, clock + delay); } catch { /* internal backoff stands */ }
      }
      const rows = safeWindows(source.provider, windows(source, answer.raw, clock));
      if (!answer.code && !rows.length) answer = { code: 'incomplete' };
      attempts.set(key, { at: clock, code: answer.code });
      if (rows.length && !answer.code) {
        try { (id.stable ? disk : transient).put(source.provider, id.key, { at: clock, windows: rows }); } catch { /* reads survive a store failure */ }
        return { provider: source.provider, windows: rows, at: clock };
      }
      return previous ? { ...previous, code: answer.code } : empty(answer.code ?? 'unavailable');
    })();
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  }
  return { read, lastKnown, connected, account };
}
