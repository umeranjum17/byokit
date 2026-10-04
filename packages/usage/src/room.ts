import type { Reading, Room } from './types.ts';
/** Figures retain their observation age; poll failure does not imply exhaustion. */
export function roomOf(reading: Reading, nowMs: number): Room {
  const at = reading.at;
  const ageMs = at !== undefined && Number.isFinite(at) && Number.isFinite(nowMs) && nowMs >= at ? nowMs - at : undefined;
  const freshness = at === undefined || !Number.isFinite(at) || !Number.isFinite(nowMs) ? 'unknown' : nowMs < at ? 'future' : ageMs! > 86_400_000 ? 'stale' : 'fresh';
  const meta = { ...(at !== undefined ? { at } : {}), ...(ageMs !== undefined ? { ageMs } : {}), freshness,
    ...(reading.poll ? { poll: reading.poll } : {}) } as const;
  const blocked = reading.windows.find((w) => w.limited === true);
  // A reset prediction never clears an authoritative block, even in an old reading.
  if (reading.limited || blocked) return { ...meta, left: 0, span: 'tightest', limited: true,
    ...(blocked?.scope ? { scope: blocked.scope } : {}), ...(blocked?.resetsAt !== undefined ? { resetsAt: blocked.resetsAt } : {}) };
  if (freshness !== 'fresh' || ['not-connected', 'expired', 'auth', 'no-plan'].includes(reading.code ?? '')) return { ...meta, left: 'unknown' };
  const tight = reading.windows.reduce<Reading['windows'][number] | undefined>((worst, w) =>
    typeof w.usedPercent === 'number' && Number.isFinite(w.usedPercent) && (!worst || w.usedPercent > worst.usedPercent!) ? w : worst, undefined);
  if (!tight) return { ...meta, left: 'unknown' };
  const span = tight.kind === 'weekly' ? 'week' : tight.kind === 'monthly' ? 'month' : tight.kind === 'session' ? 'session' : 'tightest';
  const left = Math.max(0, Math.min(100, 100 - tight.usedPercent!));
  // Incomplete applicable windows cannot establish available room. Known exhaustion still stands.
  if (left > 0 && reading.windows.some((w) => w.usedPercent === undefined)) return { ...meta, left: 'unknown' };
  return { ...meta, left, span, ...(tight.scope ? { scope: tight.scope } : {}),
    ...(Number.isFinite(tight.resetsAt) ? { resetsAt: tight.resetsAt } : {}) };
}
