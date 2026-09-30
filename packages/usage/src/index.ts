import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { codexUsage, providerGet, type Answer } from './providers.ts';
import { fingerprint, readJson, store } from './store.ts';
import { codexWindows, goWindows, record, zaiWindows, type CodexRateLimitResult } from './windows.ts';
import { UsageError, type Reading, type ReadOptions, type Source, type Usage, type UsageOptions } from './types.ts';
export * from './types.ts';
export { claudeWindows, codexWindows, goWindows, zaiWindows, type CodexRateLimitResult } from './windows.ts';
export { WORDS, words, usageWords, type WordKey } from './words.ts';
const validText = (v: unknown): v is string => typeof v === 'string' && !v.includes('\0');
function validate(source: Source): void {
  if (!record(source)) throw new UsageError();
  if (source.provider === 'codex') {
    if (!validText(source.bin) || !isAbsolute(source.bin) || !validText(source.home) || !isAbsolute(source.home)) throw new UsageError();
    if (source.env !== undefined && (!record(source.env) || Object.entries(source.env).some(([k, v]) => !k || k.includes('=') || !validText(k) || !validText(v)))) throw new UsageError();
  } else if (!['opencode', 'zai'].includes(source.provider) || !validText(source.key) || source.key.length > 16384) throw new UsageError();
}
/** One reader owns per-account backoff and concurrent-read deduplication. */
export function usage(options: UsageOptions): Usage {
  if (!validText(options.stateDir) || !isAbsolute(options.stateDir)) throw new UsageError();
  const disk = store(options.stateDir); const fp = fingerprint(options.salt ?? 'byokit/usage/account');
  const backoff = new Map<string, number>(); const inFlight = new Map<string, Promise<Reading>>();
  const attempts = new Map<string, { at: number; answer: Answer }>();
  const now = (opts?: ReadOptions) => opts?.nowMs ?? (options.now ?? Date.now)();
  function connected(source: Source): boolean {
    validate(source);
    if (source.provider !== 'codex') return source.key.trim() !== '';
    try { accessSync(source.bin, constants.X_OK); return statSync(source.bin).isFile(); } catch { return false; }
  }
  function account(source: Source): string | undefined {
    validate(source);
    if (source.provider !== 'codex') return source.key.trim() ? fp(source.provider, source.key) : undefined;
    const raw = readJson(join(source.home, 'auth.json'), 64 * 1024);
    const tokens = record(raw) && record(raw.tokens) ? raw.tokens : undefined;
    const value = typeof tokens?.account_id === 'string' ? tokens.account_id : `codex-home\0${source.home}`;
    return value !== '' && value.length <= 16384 ? fp('codex', value) : undefined;
  }
  const windows = (source: Source, raw: unknown) => source.provider === 'codex' ? codexWindows(raw as CodexRateLimitResult | undefined) : source.provider === 'opencode' ? goWindows(raw) : zaiWindows(raw);
  function lastKnown(source: Source, opts?: ReadOptions): Reading | undefined {
    if (!connected(source)) return undefined;
    const key = account(source); if (!key) return undefined;
    const stored = disk.get(source.provider, key); const clock = now(opts);
    if (!stored || clock < stored.at || clock - stored.at > 86_400_000) return undefined;
    const rows = windows(source, stored.raw);
    return rows.length ? { provider: source.provider, windows: rows, at: stored.at } : undefined;
  }
  async function read(source: Source, opts?: ReadOptions): Promise<Reading> {
    validate(source); const clock = now(opts);
    const empty = (code: Reading['code']): Reading => ({ provider: source.provider, windows: [], at: clock, code });
    if (!connected(source)) return empty('not-connected');
    const key = account(source); if (!key) return empty('not-connected');
    const identity = `${source.provider}\0${key}`;
    const previous = lastKnown(source, { nowMs: clock });
    if (previous && clock - previous.at < 60_000) return previous;
    if ((backoff.get(identity) ?? 0) > clock) return previous ? { ...previous, code: 'rate-limited' } : empty('rate-limited');
    const pending = inFlight.get(identity); if (pending) return pending;
    const attempt = attempts.get(identity);
    if (attempt && clock >= attempt.at && clock - attempt.at < 60_000) return previous ? { ...previous, code: attempt.answer.code } : empty(attempt.answer.code ?? 'unavailable');
    const task = (async () => {
      let answer: Answer;
      try { answer = source.provider === 'codex' ? await codexUsage(source) : await providerGet(source, options.fetch ?? globalThis.fetch, clock); }
      catch { answer = { code: 'unavailable' }; }
      if (answer.until !== undefined) backoff.set(identity, answer.until);
      const rows = windows(source, answer.raw);
      if (!answer.code && !rows.length) answer = { code: 'incomplete' };
      // Do not keep a source key or a raw payload in a retry map.
      attempts.set(identity, { at: clock, answer: { code: answer.code } });
      if (rows.length && !answer.code) {
        disk.put(source.provider, key, { at: clock, raw: answer.raw });
        return { provider: source.provider, windows: rows, at: clock };
      }
      return previous ? { ...previous, code: answer.code } : empty(answer.code ?? 'unavailable');
    })();
    inFlight.set(identity, task);
    try { return await task; } finally { inFlight.delete(identity); }
  }
  return { read, lastKnown, connected, account };
}
