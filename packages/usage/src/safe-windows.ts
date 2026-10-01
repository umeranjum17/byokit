import { record, quotaScope } from './windows.ts';
import type { Provider, Window } from './types.ts';

/** Public stores receive only these quota fields, never raw provider payloads. */
export function safeWindows(provider: Provider, raw: unknown): Window[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 64).flatMap((value) => {
    if (!record(value) || !['session', 'weekly', 'monthly', 'rolling', 'custom'].includes(String(value.kind)) || value.usedPercent !== undefined && (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent))) return [];
    return [{ provider, kind: value.kind as Window['kind'], ...(typeof value.usedPercent === 'number' ? { usedPercent: Math.max(0, Math.min(100, value.usedPercent)) } : {}),
      ...(quotaScope(value.scope) ? { scope: quotaScope(value.scope) } : {}),
      ...(typeof value.minutes === 'number' && Number.isFinite(value.minutes) && value.minutes > 0 ? { minutes: value.minutes } : {}),
      ...(typeof value.resetsAt === 'number' && Number.isFinite(value.resetsAt) ? { resetsAt: value.resetsAt } : {}),
      ...(value.limited === true ? { limited: true } : {}),
      ...(typeof value.limit === 'string' && value.limit.length <= 80 ? { limit: value.limit } : {}) }];
  });
}
