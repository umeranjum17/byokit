import type { Kind, Provider, Window } from './types.ts';
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const obj = (v: unknown): Record<string, unknown> => record(v) ? v : {};
function window(provider: Provider, kind: Kind, used: unknown, minutes?: number, resetsAt?: number, limited = false, limit?: string): Window[] {
  if (typeof used !== 'number' || !Number.isFinite(used)) return [];
  return [{ provider, kind, usedPercent: Math.max(0, Math.min(100, used)),
    ...(minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? { minutes } : {}),
    ...(Number.isFinite(resetsAt) ? { resetsAt } : {}), ...(limited ? { limited: true } : {}), ...(limit ? { limit } : {}) }];
}
/** Accepts both the statusline envelope and the provider's usage payload. */
export function claudeWindows(raw: unknown): Window[] {
  const source = obj(obj(raw).rate_limits ?? raw);
  return (['five_hour', 'seven_day'] as const).flatMap((id) => {
    const w = obj(source[id]);
    return window('claude', id === 'five_hour' ? 'session' : 'weekly', Number.isFinite(w.utilization) ? w.utilization : w.used_percentage,
      id === 'five_hour' ? 300 : 10080, typeof w.resets_at === 'number' ? w.resets_at : Date.parse(String(w.resets_at)) / 1000);
  });
}
/** Accepts the `usage` member; monthly length is deliberately absent. */
export function goWindows(raw: unknown): Window[] {
  return (['rolling', 'weekly', 'monthly'] as const).flatMap((kind) => {
    const w = obj(obj(raw)[kind]);
    if (typeof w.percent !== 'number' || w.percent < 0 || !['ok', 'rate-limited'].includes(String(w.status))) return [];
    return window('opencode', kind, w.percent, kind === 'monthly' ? undefined : kind === 'weekly' ? 10080 : 300,
      Date.parse(String(w.resetsAt)) / 1000, w.status === 'rate-limited');
  });
}
/** Accepts the `data.limits` member; unknown bucket sizes are skipped. */
export function zaiWindows(raw: unknown): Window[] {
  return (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const w = obj(value); const key = `${w.unit}:${w.number}`;
    if (key !== '3:5' && key !== '6:1') return [];
    return window('zai', key === '3:5' ? 'session' : 'weekly', w.percentage, key === '3:5' ? 300 : 10080, Number(w.nextResetTime) / 1000);
  });
}
/** Typed pass-through of the app-server rate-limit result. */
export interface CodexRateLimitResult { rateLimitsByLimitId?: Record<string, unknown>; rateLimits?: unknown }
export function codexWindows(result: CodexRateLimitResult | undefined): Window[] {
  const limits = Object.values(obj(result?.rateLimitsByLimitId));
  if (!limits.length && result?.rateLimits !== undefined) limits.push(result.rateLimits);
  const groups = limits.flatMap((raw) => {
    if (!record(raw)) return [];
    const name = String(raw.limitName ?? raw.limitId ?? 'Codex').replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Codex';
    const rows = ['primary', 'secondary'].flatMap((key) => {
      const w = obj(raw[key]); const m = typeof w.windowDurationMins === 'number' && w.windowDurationMins > 0 && Number.isFinite(w.windowDurationMins) ? w.windowDurationMins : undefined;
      return window('codex', m === 300 ? 'session' : m === 10080 ? 'weekly' : m === 43200 ? 'monthly' : 'custom', w.usedPercent, m,
        typeof w.resetsAt === 'number' ? w.resetsAt : undefined, false, name.toLowerCase() === 'codex' ? undefined : name);
    }).sort((a, b) => (a.minutes ?? 0) - (b.minutes ?? 0));
    return rows.length ? [rows] : [];
  });
  const chosen = groups.flat().sort((a, b) => b.usedPercent - a.usedPercent).slice(0, 8);
  return groups.map((rows, ordinal) => ({ rows: rows.filter((w) => chosen.includes(w)), ordinal }))
    .filter((g) => g.rows.length).sort((a, b) => Math.max(...b.rows.map((w) => w.usedPercent)) - Math.max(...a.rows.map((w) => w.usedPercent)) || a.ordinal - b.ordinal).flatMap((g) => g.rows);
}
