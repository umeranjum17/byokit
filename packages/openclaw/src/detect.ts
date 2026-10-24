// One setup detection per agent, shared by every reader (5.7): the engine's probe asks the installed CLI itself and
// takes seconds, so a poll that reads readiness and the account list must pay for it once, not once per reader. The
// answer is reused for a short window and one probe per agent is in flight at a time; a sign-in, a sign-out, an account
// change or an engine change drops it, so a fresh login is never read from the cache.
import type { GatewayTransport, UnknownReason } from './types.ts';

export type Detection = { candidates?: { kind?: string; credentials?: boolean }[] };
/** How long a reader waits before asking again after an unknown answer. */
export const RETRY_AFTER_MS = 5_000;
export const reasonOf = (error: unknown): UnknownReason =>
  /time(d)? ?out/i.test(error instanceof Error ? error.message : String(error)) ? 'timeout' : 'unavailable';
/** An answer that arrived but says nothing: a Claude Code candidate whose `credentials` is neither true nor false. It is
 *  unknown, never signed out, and never kept. */
export const indeterminate = (d: Detection | undefined): boolean =>
  d?.candidates?.some((c) => c.kind === 'claude-cli' && typeof c.credentials !== 'boolean') === true;
export type DetectOptions = { timeoutMs?: number; signal?: AbortSignal; fresh?: boolean };
export type Detector = {
  /** The engine's setup detection for one agent. `fresh` skips the cache and the in-flight probe: a sign-in that
   *  verifies what the person just did must read the engine, not an earlier answer. */
  detect(agentId: string, o?: DetectOptions): Promise<Detection>;
  /** Drops the cached answer and any check in flight (one agent, or every agent): a check that began before it is not kept. */
  invalidate(agentId?: string): void;
};

/** How long a detection answer is reused. The answer is a CLI probe the kit cannot witness (the login lives in the
 *  person's own home), so the window bounds how long an outside sign-in stays unseen; every sign-in, sign-out and
 *  account change the kit sees drops it at once. */
export const DETECT_TTL_MS = 10_000;

/**
 * The shared detection. One probe per agent at a time, its answer reused briefly, a failure never cached (the next
 * reader tries again) and a fresh read never served from the cache.
 */
export function createDetect(request: GatewayTransport['request'], o?: { ttlMs?: number }): Detector {
  const ttl = o?.ttlMs ?? DETECT_TTL_MS;
  // An account's binding generation: bumped by its own invalidate (or every account's), so a check that began under an
  // earlier one is neither shared with a later reader nor kept.
  const generations = new Map<string, number>();
  let all = 0;
  const generationOf = (agentId: string): string => `${all}.${generations.get(agentId) ?? 0}`;
  const cache = new Map<string, { until: number; value: Detection; generation: string }>();
  const inflight = new Map<string, { call: Promise<Detection>; generation: string }>();
  const detect = (agentId: string, options: DetectOptions = {}): Promise<Detection> => {
    const generation = generationOf(agentId);
    const hit = cache.get(agentId);
    if (!options.fresh && hit && hit.generation === generation && hit.until > Date.now()) return Promise.resolve(hit.value);
    const running = options.fresh ? undefined : inflight.get(agentId);
    if (running?.generation === generation) return running.call;
    const call: Promise<Detection> = (request('openclaw.setup.detect', { agentId },
      { timeoutMs: options.timeoutMs ?? 20_000, ...(options.signal ? { signal: options.signal } : {}) }) as Promise<Detection>)
      .then((value) => {
        if (!indeterminate(value) && generationOf(agentId) === generation) cache.set(agentId, { until: Date.now() + ttl, value, generation });
        return value;
      })
      .finally(() => { if (inflight.get(agentId)?.call === call) inflight.delete(agentId); });
    inflight.set(agentId, { call, generation });
    return call;
  };
  return {
    detect,
    invalidate: (agentId?: string) => {
      if (agentId === undefined) { all++; cache.clear(); inflight.clear(); return; }
      generations.set(agentId, (generations.get(agentId) ?? 0) + 1);
      cache.delete(agentId);
      inflight.delete(agentId);
    },
  };
}
