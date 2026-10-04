import { customClaude } from './providers.ts';
import { safeWindows } from './safe-windows.ts';
import { claudeWindows } from './windows.ts';
import type { EphemeralClaudeSource, Poll, Reading, ReadOptions, UsageOptions } from './types.ts';

type State = { poll?: Poll; failures: number; pending?: Promise<Reading> };
/** Only retry/concurrency metadata survives a call; source objects are weakly held. */
export function ephemeralClaude(options: UsageOptions) {
  const states = new WeakMap<EphemeralClaudeSource, State>();
  return async (source: EphemeralClaudeSource, clock: number, opts?: ReadOptions): Promise<Reading> => {
    const empty = (poll: Poll): Reading => ({ provider: 'claude', windows: [], code: poll.outcome === 'ok' ? 'unavailable' : poll.outcome, poll });
    let connected = true;
    try { connected = source.connected?.() ?? true; } catch { connected = false; }
    if (!connected) {
      states.delete(source);
      return empty({ at: clock, outcome: 'not-connected' });
    }
    let state = states.get(source);
    if (!state) { state = { failures: 0 }; states.set(source, state); }
    if (state.pending) return state.pending;
    if (state.poll?.retryAt !== undefined && clock < state.poll.retryAt) return empty(state.poll);
    const current = state;
    const task = (async (): Promise<Reading> => {
      const answer = await customClaude(source, clock, { signal: opts?.signal });
      const rows = safeWindows('claude', claudeWindows(answer.raw));
      const limited = !answer.code && answer.limited === true;
      const code = answer.code ?? (!rows.length && !limited ? 'incomplete' : undefined);
      const poll: Poll = { at: clock, outcome: code ?? 'ok' };
      if (code && ['rate-limited', 'refresh-failed', 'unavailable', 'incomplete'].includes(code)) {
        current.failures = current.poll?.outcome === code ? current.failures + 1 : 1;
        const retry = typeof answer.retryAfterMs === 'number' && Number.isFinite(answer.retryAfterMs) && answer.retryAfterMs >= 0 ? answer.retryAfterMs : undefined;
        let delay = code === 'rate-limited' ? 300_000 : Math.min(3_600_000, 60_000 * 2 ** Math.min(current.failures - 1, 6));
        try {
          const selected = options.backoff?.delayMs?.(retry, { outcome: code, failures: current.failures });
          if (selected !== undefined && Number.isFinite(selected) && selected >= 0) delay = selected;
        } catch { /* internal retry policy stands */ }
        poll.retryAt = clock + Math.max(60_000, delay, retry ?? 0);
      } else current.failures = 0;
      current.poll = poll;
      if (code) return empty(poll);
      const at = typeof answer.at === 'number' && Number.isFinite(answer.at) ? answer.at : undefined;
      return { provider: 'claude', windows: rows, ...(at !== undefined ? { at } : {}), ...(limited ? { limited: true } : {}), poll };
    })();
    current.pending = task;
    try { return await task; } finally { current.pending = undefined; }
  };
}
