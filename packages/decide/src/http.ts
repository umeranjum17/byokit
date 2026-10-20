import type { Usage } from './core.ts';

export type RetryOptions = {
  /** 429 retries after the first attempt (default 2). Other statuses never retry. */
  maxRetries?: number;
  /** Exponential backoff when Retry-After is missing (default 1000 ms). */
  retryBaseMs?: number;
  /** Cap on each wait (default 2000 ms). Total wait <= maxRetries * retryMaxMs. */
  retryMaxMs?: number;
};

/** The same codes as @byokit/accounts' `KeyRouteError` refusals, matched by value so neither kit imports the other. */
export type RefusalCode = 'key_refused' | 'out_of_credit' | 'rate_limited';
/** Why an answer failed. A refusal is the provider turning the key or account away; `bad_reply` is a model that
 * answered but not in the asked shape (not JSON, or JSON that does not fit), so the app retries rather than signs in. */
export type FailureCode = RefusalCode | 'bad_reply';

/** The provider turned the key or account away. Only its code and HTTP status: never its body or the credential. */
export class BackendRefusedError extends Error {
  readonly code: RefusalCode;
  readonly status?: number;
  constructor(code: RefusalCode, status?: number) {
    super(status ? `http ${status}` : code);
    this.name = 'BackendRefusedError';
    this.code = code;
    if (status) this.status = status;
  }
}

/** A provider's HTTP 429 exhausted its retry budget. Provider messages and credentials are never retained. */
export class RateLimitError extends BackendRefusedError {
  readonly status = 429;
  readonly retries: number;
  constructor(retries: number) {
    super('rate_limited', 429);
    this.name = 'RateLimitError';
    this.retries = retries;
  }
}

/** A non-ok response as decide reports it: a refusal keeps its code (the accounts kit's own status table), anything
 * else only its status. */
export function httpError(status: number): Error {
  const code = status === 402 ? 'out_of_credit' : status === 401 || status === 403 ? 'key_refused' : undefined;
  return code ? new BackendRefusedError(code, status) : new Error(`http ${status}`);
}

/** A callback's refusal, read by its accounts `KeyRouteError` refusal code. A bare HTTP status is not a refusal. */
export function refusalOf(e: unknown): BackendRefusedError | undefined {
  const { code, status } = (e ?? {}) as { code?: unknown; status?: unknown };
  if (code !== 'key_refused' && code !== 'out_of_credit' && code !== 'rate_limited') return undefined;
  return new BackendRefusedError(code, typeof status === 'number' ? status : undefined);
}

/** A backend's failure as `Answer.failure` reports it: a refusal, or a reply that was not valid JSON or did not fit the
 * schema (the `invalid_json`/`invalid_output` codes of the Claude Code, Codex and Pi backends' own errors). */
export function failureOf(e: unknown): { code: FailureCode; status?: number } | undefined {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return code === 'invalid_json' || code === 'invalid_output' ? { code: 'bad_reply' } : refusalOf(e);
}

function retryPolicy(name: string, o: RetryOptions) {
  const { maxRetries = 2, retryBaseMs = 1000, retryMaxMs = 2000 } = o;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error(`${name} maxRetries must be a safe non-negative integer`);
  for (const [key, ms] of [['retryBaseMs', retryBaseMs], ['retryMaxMs', retryMaxMs]] as const) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`${name} ${key} must be a finite number >= 0`);
  }
  return { maxRetries, wait: (attempt: number, retryAfter: string | null, signal: AbortSignal) =>
    pause(Math.min(Math.max(0, parseRetryAfter(retryAfter) ?? retryBaseMs * 2 ** attempt), retryMaxMs), signal) };
}

export function retryFetch(name: string, f: typeof fetch, o: RetryOptions) {
  const policy = retryPolicy(name, o);
  return async (url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
      if (init.signal.aborted) throw abortError(init.signal);
      const res = await f(url, init);
      if (res.status !== 429) return res;
      await res.body?.cancel();
      if (attempt >= policy.maxRetries) throw new RateLimitError(attempt);
      await policy.wait(attempt, res.headers.get('retry-after'), init.signal);
    }
  };
}

/** Callback equivalent of retryFetch. accounts.respond exposes status/retryAfter; SDKs may expose headers. */
export function retryCall(name: string, o: RetryOptions) {
  const policy = retryPolicy(name, o);
  return async <T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw abortError(signal);
      try { return await call(); } catch (e) {
        const http = e as { status?: number; retryAfter?: string; headers?: { get?: (name: string) => string | null } } | null;
        if (http?.status !== 429) throw e;
        if (attempt >= policy.maxRetries) throw refusalOf(e)?.code === 'rate_limited' ? new RateLimitError(attempt) : new Error('http 429');
        await policy.wait(attempt, http.retryAfter ?? http.headers?.get?.('retry-after') ?? null, signal);
      }
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
