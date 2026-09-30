import type { BackoffPolicy } from './types.ts';

/** Parse Retry-After seconds or HTTP-date into a duration in milliseconds. */
export function retryAfterMs(header: string | null | undefined, nowMs: number): number | undefined {
  if (!header?.trim()) return undefined;
  const value = header.trim();
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - nowMs;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
/** Default quota rest: honor a longer server delay, otherwise wait five minutes. */
export function backoffDelayMs(retryAfter: number | undefined): number {
  return Math.max(300_000, typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : 0);
}
/** Share this policy between readers to preserve per-account 429 rests in memory. */
export function memoryBackoffPolicy(): BackoffPolicy {
  const rests = new Map<string, number>();
  return {
    get: (provider, account) => rests.get(`${provider}\0${account}`),
    set: (provider, account, untilMs) => {
      if (!Number.isFinite(untilMs)) return;
      const key = `${provider}\0${account}`;
      rests.set(key, Math.max(rests.get(key) ?? 0, untilMs));
    },
    delayMs: backoffDelayMs,
  };
}
