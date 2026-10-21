// One setup detection per agent, shared by every reader (5.7): the engine's probe asks the installed CLI itself and
// takes seconds, so a poll that reads readiness and the account list must pay for it once, not once per reader. The
// answer is reused for a short window and one probe per agent is in flight at a time; a sign-in, a sign-out, an account
// change or an engine change drops it, so a fresh login is never read from the cache.
import type { GatewayTransport } from './types.ts';

export type Detection = { candidates?: { kind?: string; credentials?: boolean }[] };
export type DetectOptions = { timeoutMs?: number; signal?: AbortSignal; fresh?: boolean };
export type Detector = {
  /** The engine's setup detection for one agent. `fresh` skips the cache and the in-flight probe: a sign-in that
   *  verifies what the person just did must read the engine, not an earlier answer. */
  detect(agentId: string, o?: DetectOptions): Promise<Detection>;
  /** Drops the cached answer (one agent, or every agent). */
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
  const cache = new Map<string, { until: number; value: Detection }>();
  const inflight = new Map<string, Promise<Detection>>();
  const detect = (agentId: string, options: DetectOptions = {}): Promise<Detection> => {
    const hit = cache.get(agentId);
    if (!options.fresh && hit && hit.until > Date.now()) return Promise.resolve(hit.value);
    const running = options.fresh ? undefined : inflight.get(agentId);
    if (running) return running;
    const call = (request('openclaw.setup.detect', { agentId },
      { timeoutMs: options.timeoutMs ?? 20_000, ...(options.signal ? { signal: options.signal } : {}) }) as Promise<Detection>)
      .then((value) => { cache.set(agentId, { until: Date.now() + ttl, value }); return value; })
      .finally(() => { if (inflight.get(agentId) === call) inflight.delete(agentId); });
    inflight.set(agentId, call);
    return call;
  };
  return {
    detect,
    invalidate: (agentId?: string) => {
      if (agentId === undefined) { cache.clear(); inflight.clear(); return; }
      cache.delete(agentId);
      inflight.delete(agentId);
    },
  };
}
