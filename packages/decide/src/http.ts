import type { Usage } from './index.ts';

export type RetryOptions = {
  /** 429 retries after the first attempt (default 2). Other statuses never retry. */
  maxRetries?: number;
  /** Exponential backoff when Retry-After is missing (default 1000 ms). */
  retryBaseMs?: number;
  /** Cap on each wait (default 2000 ms). Total wait <= maxRetries * retryMaxMs. */
  retryMaxMs?: number;
};

export function retryFetch(name: string, f: typeof fetch, o: RetryOptions) {
  const { maxRetries = 2, retryBaseMs = 1000, retryMaxMs = 2000 } = o;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${name} maxRetries must be a safe non-negative integer`);
  for (const [key, ms] of [['retryBaseMs', retryBaseMs], ['retryMaxMs', retryMaxMs]] as const) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} ${key} must be a finite number >= 0`);
  }
  return async (url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      if (init.signal.aborted) throw abortError(init.signal);
      const res = await f(url, init);
      if (res.status !== 429 || attempt >= maxRetries) return res;
      const wait = Math.min(Math.max(0, parseRetryAfter(res.headers.get('retry-after')) ?? retryBaseMs * 2 ** attempt), retryMaxMs);
      await res.body?.cancel();
      await pause(wait, init.signal);
    }
  };
}

function parseRetryAfter(header: string | null): number | undefined {
  const h = header?.trim();
  if (!h) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(h)) return Number(h) * 1000;
  const date = Date.parse(h);
  return Number.isNaN(date) ? undefined : date - Date.now();
}

/** Only valid backend-reported counts; absent is never guessed to be zero. */
export function parseUsage(u: unknown): Usage | undefined {
  if (u === null || typeof u !== 'object') return undefined;
  const out: Usage = {};
  for (const k of ['input_tokens', 'output_tokens'] as const) {
    const v = (u as Record<string, unknown>)[k];
    if (Number.isSafeInteger(v) && (v as number) >= 0) out[k] = v as number;
  }
  return out.input_tokens !== undefined || out.output_tokens !== undefined ? out : undefined;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(abortError(signal)); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : 'aborted');
}
