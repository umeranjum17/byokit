// Jev, TypeSafe's decision model, over its own API or OpenRouter's copy of it (the same request and answers).
// The key is the host's: the app reads it from its own environment or config and hands it here. The kit never reads
// an environment variable, never ships a key and never puts it anywhere but the one request header.
import type { Backend, Question, Raw, Usage } from './index.ts';

const BASE = { typesafe: 'https://api.typesafe.ai', openrouter: 'https://openrouter.ai/api' };

export function jev(opts: {
  key: string;
  via?: 'typesafe' | 'openrouter';
  fetch?: typeof fetch;
  /** 429 retries after the first attempt (default 2). Only 429 retries, never other 4xx. */
  maxRetries?: number;
  /** Wait when a 429 carries no usable Retry-After (default 1000 ms); attempt n waits baseMs * 2^n. */
  retryBaseMs?: number;
  /** Each backoff wait is capped here (default 2000 ms), so the total wait stays under maxRetries * retryMaxMs. */
  retryMaxMs?: number;
}): Backend {
  const { key, via = 'typesafe', fetch: f = globalThis.fetch, maxRetries = 2, retryBaseMs = 1000, retryMaxMs = 2000 } = opts;
  if (!key) throw new Error('jev needs a key');
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new Error('jev maxRetries must be a safe non-negative integer');
  for (const [name, ms] of [['retryBaseMs', retryBaseMs], ['retryMaxMs', retryMaxMs]] as const) {
    if (!Number.isFinite(ms) || ms < 0) throw new Error(`jev ${name} must be a finite number >= 0`);
  }
  return {
    name: 'jev',
    leaves: true,
    async ask(state, questions, signal) {
      const body = JSON.stringify({ model: 'jev-latest', state, questions: Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, wire(q)])) });
      for (let attempt = 0; ; attempt++) {
        if (signal.aborted) throw abortError(signal);
        const res = await f(`${BASE[via]}/v1/systemone`, {
          method: 'POST',
          signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body,
        });
        if (res.status === 429 && attempt < maxRetries) {
          const wait = Math.min(Math.max(0, parseRetryAfter(res.headers.get('retry-after')) ?? retryBaseMs * 2 ** attempt), retryMaxMs);
          await pause(wait, signal);
          continue;
        }
        if (!res.ok) throw new Error(`http ${res.status}`);
        const json: unknown = await res.json();
        const answers = json !== null && typeof json === 'object' ? (json as { answers?: unknown }).answers : undefined;
        const usage = parseUsage(json !== null && typeof json === 'object' ? (json as { usage?: unknown }).usage : undefined);
        const map = answers !== null && typeof answers === 'object' ? answers as Record<string, unknown> : {};
        return Object.fromEntries(Object.entries(questions).map(([k, q]) => {
          if (!Object.hasOwn(map, k)) return [k, undefined];
          const r = raw(q, map[k]);
          // A per-question response that is off-shape still carries usage/raw: the floors abstain on it.
          if (r) return [k, { ...r, ...(usage && { usage }), raw: json }];
          return [k, { probabilities: {}, ...(usage && { usage }), raw: json } satisfies Raw];
        }));
      }
    },
  };
}

/** Seconds ("120", "1.5") or an HTTP date; undefined when absent or unparsable. */
function parseRetryAfter(header: string | null): number | undefined {
  const h = header?.trim();
  if (!h) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(h)) return Number(h) * 1000;
  const date = Date.parse(h);
  if (!Number.isNaN(date)) return date - Date.now();
  return undefined;
}

/** The counts the backend reported, when it sent valid ones; anything else is absent, never an error. */
function parseUsage(u: unknown): Usage | undefined {
  if (u === null || typeof u !== 'object') return undefined;
  const out: Usage = {};
  for (const k of ['input_tokens', 'output_tokens'] as const) {
    const v = (u as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (Number.isSafeInteger(v) && (v as number) >= 0) out[k] = v as number;
  }
  return out.input_tokens !== undefined || out.output_tokens !== undefined ? out : undefined;
}

/** Sleep that settles promptly when the caller's signal fires, so a decide() timeout is never outwaited. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The caller's abort reason, or a plain error when it carries none. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(typeof signal.reason === 'string' && signal.reason ? signal.reason : 'aborted');
}

function wire(q: Question) {
  if (q.kind === 'choice') return { type: 'choice', instructions: q.instructions ?? 'Which option fits the state?', criteria: q.options };
  if (q.kind === 'yesno') return { type: 'noul', instructions: q.question, ...(q.yes && q.no && { criteria: { true: q.yes, false: q.no } }) };
  return { type: 'score', instructions: q.instructions ?? 'Where does the state fall on this scale?', criteria: q.levels };
}

/** Jev's answer as a Raw; anything off-shape is undefined, which the floors treat as an abstain. */
export function raw(q: Question, a: any): Raw | undefined {
  if (!a || typeof a !== 'object') return undefined;
  if (q.kind === 'yesno') return typeof a.noul === 'number' ? { probabilities: { true: a.noul, false: 1 - a.noul } } : undefined;
  if (typeof a.probabilities !== 'object' || typeof a.confidence !== 'number') return undefined;
  if (q.kind === 'choice') return typeof a.choice === 'string' ? { probabilities: a.probabilities, confidence: a.confidence, pick: a.choice } : undefined;
  return { probabilities: a.probabilities, confidence: a.confidence };
}
