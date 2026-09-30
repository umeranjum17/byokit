// Protocol shapes informed by can1357/oh-my-pi (MIT), pinned at 2b023d1.
// This module normalizes quota fields only; it does not import upstream runtime code.
import { record, window, codexWindows } from './windows.ts';
import type { Window } from './types.ts';
const obj = (value: unknown): Record<string, unknown> => record(value) ? value : {};
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const number = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const label = (value: unknown): string | undefined => typeof value === 'string' ? value.replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 80) || undefined : undefined;
const time = (value: unknown): number | undefined => typeof value === 'string' ? Date.parse(value) : number(value);
const ratio = (used: unknown, limit: unknown, remaining?: unknown): number | undefined => {
  const cap = number(limit); const consumed = number(used); const left = number(remaining);
  return cap !== undefined && cap > 0 && (consumed !== undefined || left !== undefined) ? 100 * (consumed ?? cap - left!) / cap : undefined;
};
export function codexTokenWindows(raw: unknown): Window[] {
  const source = obj(raw); const plan = obj(source.rate_limit);
  const group = (value: Record<string, unknown>, name?: string) => ({ limitName: name,
    ...Object.fromEntries(['primary', 'secondary'].map((key) => {
      const w = obj(value[`${key}_window`]);
      return [key, { usedPercent: w.used_percent, windowDurationMins: typeof w.limit_window_seconds === 'number' ? w.limit_window_seconds / 60 : undefined, resetsAt: w.reset_at }];
    })) });
  return codexWindows({ rateLimitsByLimitId: Object.fromEntries([
    ['plan', group(plan, 'Codex')], ...rows(source.additional_rate_limits).map((v, i) => { const extra = obj(v); return [String(i), group(obj(extra.rate_limit), label(extra.limit_name))]; }),
  ]) });
}
export function copilotWindows(raw: unknown): Window[] {
  const source = obj(raw);
  return Object.entries(obj(source.quota_snapshots)).flatMap(([key, value]) => {
    const quota = obj(value);
    if (quota.unlimited === true) return [];
    const left = number(quota.percent_remaining);
    return window('copilot', 'monthly', left === undefined ? ratio(undefined, quota.entitlement, quota.remaining) : 100 - left,
      undefined, time(source.quota_reset_date), false, label(key));
  });
}
export function grokWindows(raw: unknown): Window[] {
  const config = obj(obj(raw).config); const period = obj(config.currentPeriod);
  const weekly = number(config.creditUsagePercent);
  if (weekly !== undefined) return window('grok', 'weekly', weekly, 10080, time(period.end));
  return window('grok', 'monthly', ratio(config.used, config.monthlyLimit), undefined, time(config.periodEnd));
}
export function minimaxWindows(raw: unknown): Window[] {
  const source = obj(raw);
  if (obj(source.base_resp).status_code !== 0) return [];
  return rows(source.model_remains).flatMap((value) => {
    const bucket = obj(value);
    if (bucket.current_interval_status === 3 && bucket.current_weekly_status === 3 && bucket.current_interval_total_count === 0 && bucket.current_weekly_total_count === 0) return [];
    return ['interval', 'weekly'].flatMap((key) => {
      const left = number(bucket[`current_${key}_remaining_percent`]);
      const exhausted = bucket[`current_${key}_status`] === 2;
      const rawReset = bucket[key === 'interval' ? 'end_time' : 'weekly_end_time'];
      const reset = typeof rawReset === 'number' && rawReset > 0 ? rawReset < 1e12 ? rawReset * 1000 : rawReset : time(rawReset);
      return window('minimax', key === 'weekly' ? 'weekly' : 'rolling', exhausted ? 100 : left === undefined ? undefined : 100 - left,
        key === 'weekly' ? 10080 : undefined, reset, exhausted, label(bucket.model_name));
    });
  });
}
export function geminiWindows(raw: unknown): Window[] {
  return rows(obj(raw).buckets).flatMap((value) => {
    const bucket = obj(value); const left = number(bucket.remainingFraction);
    return window('gemini', 'custom', left === undefined ? undefined : 100 - left * 100, undefined, time(bucket.resetTime), false, label(bucket.modelId));
  });
}
export function kimiWindows(raw: unknown, nowMs: number): Window[] {
  const source = obj(raw);
  const read = (value: unknown, minutes?: number, reset?: unknown): Window[] => {
    const detail = obj(value);
    const units: Record<string, number> = { SECOND: 1 / 60, MINUTE: 1, HOUR: 60, DAY: 1440, WEEK: 10080 };
    const w = obj(detail.window);
    const duration = number(w.duration);
    const m = minutes ?? (duration === undefined ? undefined : duration * (units[String(w.timeUnit).toUpperCase().replace(/S$/, '')] ?? NaN));
    const row = record(detail.detail) ? detail.detail : detail;
    const resetValue = reset ?? w.resetTime ?? row.resetTime ?? row.reset_at ?? row.resetAt;
    let resetMs = time(resetValue);
    if (typeof resetValue === 'number') resetMs = resetValue > 1e12 ? resetValue : resetValue * 1000;
    if (resetValue === undefined && number(row.reset_in) !== undefined) resetMs = nowMs + number(row.reset_in)! * 1000;
    return window('kimi', m === 300 ? 'session' : m === 10080 ? 'weekly' : m === 43200 ? 'monthly' : 'custom', ratio(row.used, row.limit, row.remaining), m, resetMs);
  };
  return [...read(source.usage, 10080), ...read(source.totalQuota), ...rows(source.limits).flatMap((row) => read(row))];
}
