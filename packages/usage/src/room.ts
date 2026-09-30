import type { Reading, Room } from './types.ts';
/** Tightest known quota, valid for 24 hours. Refused/authless sources report unknown room. */
export function roomOf(reading: Reading, nowMs: number): Room {
  if (!Number.isFinite(reading.at) || !Number.isFinite(nowMs) || nowMs < reading.at || nowMs - reading.at > 86_400_000 || ['not-connected', 'expired', 'auth', 'no-plan'].includes(reading.code ?? '')) return { left: 'unknown', at: reading.at };
  const tight = reading.windows.reduce<Reading['windows'][number] | undefined>((worst, window) =>
    Number.isFinite(window.usedPercent) && (!worst || window.usedPercent > worst.usedPercent) ? window : worst, undefined);
  if (!tight) return { left: 'unknown', at: reading.at };
  const span = tight.kind === 'weekly' ? 'week' : tight.kind === 'monthly' ? 'month' : tight.kind === 'session' ? 'session' : 'tightest';
  return { left: Math.max(0, Math.min(100, 100 - tight.usedPercent)), span, at: reading.at,
    ...(Number.isFinite(tight.resetsAt) ? { resetsAt: tight.resetsAt } : {}) };
}
