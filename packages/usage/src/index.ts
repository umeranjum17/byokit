import { accessSync, constants, lstatSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { claudeAuth, claudeUsage, codexUsage, customClaude, providerGet, type Answer } from './providers.ts';
import { fingerprint, store, memoryUsageStore, safeWindows, safePoll } from './store.ts';
import { claudeWindows, codexWindows, goWindows, record, zaiWindows, type CodexRateLimitResult } from './windows.ts';
import { codexHardLimit, codexTokenWindows, copilotWindows, grokWindows, minimaxWindows, geminiWindows, kimiWindows } from './quota.ts';
import { UsageError, type Reading, type ReadOptions, type Source, type Usage, type UsageOptions, type Poll } from './types.ts';
import { codexIdentity, type Identity } from './identity.ts';
import { claudeUsage as managedClaudeUsage, claudeCredential, managedClaudeFolder, defaultLoginPath } from './claude.ts';
import { ephemeralClaude } from './ephemeral.ts';
export * from './types.ts';
export { harnessLog, HarnessLogError, type HarnessLog, type HarnessLogFile, type HarnessLogFormat, type HarnessLogEntry, type HarnessLogOptions, type HarnessLogReadOptions, type HarnessLogPage, type HarnessLogWork } from './log.ts';
export type { Identity } from './identity.ts';
/** Identity runs only the named binary, never opens a credential file. */
export async function identity(source: Extract<Source, { bin: string }>): Promise<Identity> {
  if (!record(source) || !('bin' in source) || 'folder' in source || 'credentialsFile' in source || 'read' in source) throw new UsageError();
  validate(source);
  return codexIdentity(source);
}
export { callLedger, normalizeTokens, priceCall, type CallLedger, type CallInput, type CallRecord, type CallQuery, type RunQuery, type NormalizedTokens, type ModelPrice, type PriceTable, type CallCost } from './calls.ts';
export { tokenLedger, memoryTokenLedgerStore, TokenLedgerError, type TokenLedger, type TokenLedgerStore, type TokenLedgerOptions, type TokenEntry, type TokenQuery } from './ledger.ts';
export { roomOf } from './room.ts';
export { preflight, type Preflight, type PreflightCall, type PreflightUnknown } from './preflight.ts';
export { fingerprint, store as fileUsageStore, memoryUsageStore } from './store.ts';
export { retryAfterMs, backoffDelayMs, memoryBackoffPolicy } from './backoff.ts';
export { claudeWindows, codexWindows, goWindows, zaiWindows, type CodexRateLimitResult } from './windows.ts';
export { codexHardLimit, codexTokenWindows, copilotWindows, grokWindows, minimaxWindows, geminiWindows, kimiWindows } from './quota.ts';
export { WORDS, words, usageWords, type WordKey } from './words.ts';
const providers = ['claude', 'codex', 'opencode', 'zai', 'copilot', 'grok', 'minimax', 'gemini', 'kimi'];
const validText = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0') && !/[\r\n]/.test(v) && v.length <= 16384;
function validate(source: Source, stateDir?: string): void {
  if (!record(source) || !providers.includes(source.provider)) throw new UsageError();
  if ('ephemeral' in source && (source.ephemeral !== true || source.provider !== 'claude' || typeof source.read !== 'function' || ['accountUuid', 'accountId', 'origin', 'folder', 'credentialsFile', 'access', 'key', 'bin', 'home', 'configFile', 'statuslineFile'].some((field) => field in source))) throw new UsageError();
  if ('folder' in source) {
    if (source.provider !== 'claude' || !validText(source.folder) || !isAbsolute(source.folder) || !stateDir || !managedClaudeFolder(source.folder, stateDir)) throw new UsageError();
    if (!record(source.headers) || !['anthropic-beta', 'User-Agent'].every((key) => validText(source.headers[key as keyof typeof source.headers]) && source.headers[key as keyof typeof source.headers].length <= 1024)) throw new UsageError();
  } else if ('credentialsFile' in source) {
    if (source.provider !== 'claude' || ![source.credentialsFile, ...[source.configFile, source.statuslineFile].filter((v) => v !== undefined)].every((v) => validText(v) && isAbsolute(v) && !defaultLoginPath(v))) throw new UsageError();
  } else if ('read' in source) {
    if (source.provider !== 'claude' || typeof source.read !== 'function' || !('ephemeral' in source) && (!validText(source.accountUuid) || !source.accountUuid) || source.connected !== undefined && typeof source.connected !== 'function') throw new UsageError();
  } else if ('bin' in source) {
    if (source.provider !== 'codex' || !validText(source.bin) || !isAbsolute(source.bin) || !validText(source.home) || !isAbsolute(source.home)) throw new UsageError();
    if (source.env !== undefined && (!record(source.env) || Object.entries(source.env).some(([k, v]) => !k || k.includes('=') || !validText(k) || !validText(v)))) throw new UsageError();
  } else {
    if ('key' in source && !['opencode', 'zai'].includes(source.provider) || 'access' in source && ['opencode', 'zai'].includes(source.provider)) throw new UsageError();
    const credential = 'access' in source ? source.access : 'key' in source ? source.key : undefined;
    if (!validText(credential)) throw new UsageError();
    if ('access' in source && source.provider === 'codex' && (!validText(source.accountId) || !source.accountId)) throw new UsageError();
  }
  if ('origin' in source && source.origin !== undefined) {
    try { const url = new URL(source.origin); if (!['https:', 'http:'].includes(url.protocol) || url.origin !== source.origin) throw new Error(); } catch { throw new UsageError(); }
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
/** Metadata only, so a Codex sign-in keys the cache without loading a token. */
function codexCredential(home: string) {
  try {
    const stat = lstatSync(join(home, 'auth.json'));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 ? stat : undefined;
  } catch { return undefined; }
}
/** One reader owns per-account backoff and concurrent-read deduplication. */
export function usage(options: UsageOptions): Usage {
  if (options.stateDir !== undefined && (!validText(options.stateDir) || !isAbsolute(options.stateDir))) throw new UsageError();
  const disk = options.store ?? (options.stateDir ? store(options.stateDir) : memoryUsageStore());
  const transient = memoryUsageStore(); const fp = fingerprint(options.salt ?? 'byokit/usage/account');
  const backoffs = new Map<string, number>(); const inFlight = new Map<string, Promise<Reading>>();
  const attempts = new Map<string, Poll>();
  const failures = new Map<string, number>();
  const now = (opts?: ReadOptions) => opts?.nowMs ?? (options.now ?? Date.now)();
  const readEphemeral = ephemeralClaude(options);
  function connected(source: Source): boolean {
    validate(source, options.stateDir);
    if ('folder' in source) return claudeCredential(source.folder) !== undefined;
    if ('credentialsFile' in source) return claudeAuth(source) !== undefined;
    if ('read' in source) { try { return source.connected?.() ?? true; } catch { return false; } }
    if ('bin' in source) { try { accessSync(source.bin, constants.X_OK); return statSync(source.bin).isFile(); } catch { return false; } }
    return ('access' in source ? source.access : source.key).trim() !== '';
  }
  function account(source: Source): string | undefined {
    validate(source, options.stateDir);
    let id: string | undefined;
    if ('folder' in source) {
      const stat = claudeCredential(source.folder);
      id = stat ? `${source.folder}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : undefined;
    } else if ('credentialsFile' in source) id = claudeAuth(source)?.account;
    else if ('read' in source) id = 'ephemeral' in source ? undefined : source.accountUuid;
    else if ('bin' in source) {
      const stat = codexCredential(source.home);
      id = stat ? `${source.home}\0${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : `codex-home\0${source.home}`;
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
      case 'codex': return 'bin' in source ? codexWindows(raw as CodexRateLimitResult | undefined) : codexTokenWindows(raw, clock);
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
    validate(source, options.stateDir);
    if ('ephemeral' in source) return undefined;
    if (!connected(source)) return undefined;
    const id = identity(source); const clock = now(opts);
    try {
      const stored = (id.stable ? disk : transient).get(source.provider, id.key);
      if (!stored) return undefined;
      if (!stored.limited && !stored.windows.some((w) => w.limited) && stored.at !== undefined && (clock < stored.at || clock - stored.at > 86_400_000)) return undefined;
      const rows = safeWindows(source.provider, stored.windows);
      const poll = attempts.get(`${source.provider}\0${id.key}`) ?? safePoll(stored.poll);
      return rows.length || stored.limited ? { provider: source.provider, windows: rows, ...(stored.at !== undefined ? { at: stored.at } : {}),
        ...(stored.limited ? { limited: true } : {}), ...(poll ? { poll, ...(poll.outcome !== 'ok' ? { code: poll.outcome } : {}) } : {}) } : undefined;
    } catch { return undefined; }
  }
  async function read(source: Source, opts?: ReadOptions): Promise<Reading> {
    validate(source, options.stateDir); const clock = now(opts);
    if ('ephemeral' in source) return readEphemeral(source, clock, opts);
    const empty = (code: Reading['code']): Reading => ({ provider: source.provider, windows: [], code, poll: { at: clock, outcome: code ?? 'unavailable' } });
    if (!connected(source)) return empty('not-connected');
    const id = identity(source); const key = `${source.provider}\0${id.key}`;
    const previous = lastKnown(source, { nowMs: clock });
    if (previous && !previous.code && previous.at !== undefined && clock >= previous.at && clock - previous.at < 60_000) return previous;
    let until = backoffs.get(key) ?? 0;
    try {
      const saved = id.stable ? options.backoff?.get(source.provider, id.key) : undefined;
      if (typeof saved === 'number' && Number.isFinite(saved)) until = Math.max(until, saved);
      else if (saved && typeof saved !== 'number' && Number.isFinite(saved.untilMs) && Number.isFinite(saved.at) && ['rate-limited', 'refresh-failed', 'unavailable', 'incomplete'].includes(saved.outcome)) {
        until = Math.max(until, saved.untilMs);
        if (!attempts.has(key)) attempts.set(key, { at: saved.at, outcome: saved.outcome, retryAt: saved.untilMs });
        if (!failures.has(`${key}\0${saved.outcome}`) && Number.isSafeInteger(saved.failures) && saved.failures > 0) failures.set(`${key}\0${saved.outcome}`, saved.failures);
      }
    } catch { /* keep internal backoff */ }
    if (until > clock) {
      const poll = attempts.get(key) ?? previous?.poll ?? { at: clock, outcome: 'unavailable' as const, retryAt: until };
      return { ...(previous ?? empty(poll.outcome === 'ok' ? 'unavailable' : poll.outcome)), code: poll.outcome === 'ok' ? undefined : poll.outcome, poll };
    }
    const pending = inFlight.get(key); if (pending) return pending;
    const attempt = attempts.get(key) ?? previous?.poll;
    if (attempt && clock >= attempt.at && clock - attempt.at < 60_000) return previous ? { ...previous, code: attempt.outcome === 'ok' ? undefined : attempt.outcome, poll: attempt } : empty(attempt.outcome === 'ok' ? 'unavailable' : attempt.outcome);
    const task = (async (): Promise<Reading> => {
      let answer: Answer;
      const pacing = { hook: options.pace, provider: source.provider, account: id.key, signal: opts?.signal };
      try {
        answer = 'folder' in source ? await managedClaudeUsage(source, options.fetch ?? globalThis.fetch, clock, pacing) : 'read' in source ? await customClaude(source, clock, pacing) : 'credentialsFile' in source ? await claudeUsage(source, options.fetch ?? globalThis.fetch, clock, pacing)
          : 'bin' in source ? await codexUsage(source) : await providerGet(source, options.fetch ?? globalThis.fetch, clock, pacing);
      } catch { answer = { code: 'unavailable' }; }
      const rows = safeWindows(source.provider, windows(source, answer.raw, clock));
      const limited = !answer.code && (answer.limited === true || source.provider === 'codex' && codexHardLimit(answer.raw));
      if (!answer.code && !rows.length && !limited) answer = { code: 'incomplete' };
      const poll: Poll = { at: clock, outcome: answer.code ?? 'ok' };
      if (answer.code) {
        const failureKey = `${key}\0${answer.code}`;
        const count = (failures.get(failureKey) ?? 0) + 1; failures.set(failureKey, count);
        if (['rate-limited', 'refresh-failed', 'unavailable', 'incomplete'].includes(answer.code)) {
          const retry = Number.isFinite(answer.retryAfterMs) && answer.retryAfterMs! >= 0 ? answer.retryAfterMs : undefined;
          let delay = answer.code === 'rate-limited' ? 300_000 : Math.min(3_600_000, 60_000 * 2 ** Math.min(count - 1, 6));
          try { const selected = options.backoff?.delayMs?.(retry, { outcome: answer.code, failures: count });
            if (selected !== undefined && Number.isFinite(selected) && selected >= 0) delay = selected;
          } catch { /* internal policy stands */ }
          delay = Math.max(60_000, delay, retry ?? 0);
          poll.retryAt = clock + delay; backoffs.set(key, poll.retryAt);
          try { if (id.stable) options.backoff?.set(source.provider, id.key, poll.retryAt, { untilMs: poll.retryAt, at: clock, outcome: answer.code, failures: count }); } catch { /* internal backoff stands */ }
        }
      } else {
        for (const outcome of ['rate-limited', 'refresh-failed', 'unavailable', 'incomplete']) failures.delete(`${key}\0${outcome}`);
        backoffs.delete(key);
        try { if (id.stable) options.backoff?.set(source.provider, id.key, 0); } catch { /* expired host policy remains bounded */ }
      }
      attempts.set(key, poll);
      if ((rows.length || limited) && !answer.code) {
        // Explicit host/snapshot time is authoritative, including unknown or future time.
        const observed = 'at' in answer ? answer.at : clock;
        const at = typeof observed === 'number' && Number.isFinite(observed) ? observed : undefined;
        const reading: Reading = { provider: source.provider, windows: rows, ...(at !== undefined ? { at } : {}), ...(limited ? { limited: true } : {}), poll };
        try { (id.stable ? disk : transient).put(source.provider, id.key, { at: reading.at, windows: rows, ...(limited ? { limited: true } : {}), poll }); } catch { /* reads survive a store failure */ }
        return reading;
      }
      if (previous) {
        try { (id.stable ? disk : transient).put(source.provider, id.key, { at: previous.at, windows: previous.windows, ...(previous.limited ? { limited: true } : {}), poll }); } catch { /* last-good remains in memory */ }
      }
      return { ...(previous ?? empty(answer.code ?? 'unavailable')), code: answer.code, poll };
    })();
    inFlight.set(key, task);
    try { return await task; } finally { inFlight.delete(key); }
  }
  return { read, lastKnown, connected, account };
}

export { planView, planLabel, modelLabel, type PlanView, type ActivityCount } from './view.ts';
