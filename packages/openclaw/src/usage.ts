// Portable reading of the pinned engine's retained transcript ledger, NOT a complete spend meter.
import type { SessionsUsageParams } from '@openclaw/gateway-protocol';
import type { CallOptions, Member } from './types.ts';

export type UsageWindow = { startDate: string; endDate: string };
/** Engine-reported counters. Price totals are not a bill, and zero with missingCostEntries is unknown cost. */
export type LedgerUsageTotals = {
  input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number;
  totalCost: number; inputCost: number; outputCost: number; cacheReadCost: number; cacheWriteCost: number;
  missingCostEntries: number; missingCostByModel?: Record<string, number>;
};
export type UsageCache = {
  status: 'fresh' | 'refreshing' | 'partial' | 'stale'; cachedFiles: number; pendingFiles: number; staleFiles: number;
  refreshedAt?: number;
};
export type AgentUsageReading = {
  member: Member; window: UsageWindow & { mode: 'utc' }; receivedAt: number;
  /** Result assembly time, not latest model call time. */
  updatedAt?: number;
  cache?: UsageCache;
  /** Detached Workshop reviews are omitted; other internal turns only count when persisted. */
  coverage: 'retained-transcripts-only';
  state: 'available' | 'unavailable';
  /** Observed ledger counters only. Absent on missing, malformed, refreshing or stale data. */
  totals?: LedgerUsageTotals;
  /** Complete original response, including session rows, day aggregates and unknown extensions. */
  raw: unknown;
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const buckets = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'totalCost', 'inputCost', 'outputCost',
  'cacheReadCost', 'cacheWriteCost', 'missingCostEntries'] as const;
function totalsOf(v: unknown): LedgerUsageTotals | undefined {
  if (!record(v) || !buckets.every(k => count(v[k]))) return;
  if (v.missingCostByModel !== undefined && (!record(v.missingCostByModel) || !Object.values(v.missingCostByModel).every(count))) return;
  return v as LedgerUsageTotals;
}
function cacheOf(v: unknown): UsageCache | undefined {
  if (!record(v) || !['fresh', 'refreshing', 'partial', 'stale'].includes(String(v.status)) ||
    !['cachedFiles', 'pendingFiles', 'staleFiles'].every(k => count(v[k])) ||
    (v.refreshedAt !== undefined && !count(v.refreshedAt))) return;
  return v as UsageCache;
}
function validate(member: Member, window: UsageWindow): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(member)) throw new Error('Invalid member');
  for (const day of [window.startDate, window.endDate]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day)
      throw new Error('Expected a valid YYYY-MM-DD calendar date');
  }
  if (window.startDate > window.endDate) throw new Error('Usage startDate must not follow endDate');
}

/** Normalize an explicitly agent-scoped UTC response. No missing datum is replaced with zero. */
export function agentUsageOf(raw: unknown, member: Member, window: UsageWindow, receivedAt = Date.now()): AgentUsageReading {
  validate(member, window);
  const result: AgentUsageReading = { member, window: { ...window, mode: 'utc' }, receivedAt,
    coverage: 'retained-transcripts-only', state: 'unavailable', raw };
  if (!record(raw)) return result;
  if (count(raw.updatedAt)) result.updatedAt = raw.updatedAt;
  const cache = cacheOf(raw.cacheStatus);
  if (cache) result.cache = cache;
  if (!cache || cache.status !== 'fresh' || cache.pendingFiles !== 0 || cache.staleFiles !== 0 ||
    raw.startDate !== window.startDate || raw.endDate !== window.endDate || !record(raw.aggregates) ||
    !Array.isArray(raw.aggregates.byAgent)) return result;
  const agents = raw.aggregates.byAgent;
  // An absent agent row is not evidence of a zero-use day. Do not read another agent's/global totals.
  if (agents.length !== 1 || !record(agents[0]) || agents[0].agentId !== member) return result;
  const totals = totalsOf(agents[0].totals);
  if (!totals) return result;
  result.state = 'available';
  result.totals = totals;
  return result;
}

/** Works with kit.call or the portable device.call; retains the complete existing pass-through. RPC errors reject. */
export async function readAgentUsage(client: {
  call(method: 'sessions.usage', params: SessionsUsageParams, options?: CallOptions): Promise<unknown>;
}, member: Member, window: UsageWindow, options?: CallOptions): Promise<AgentUsageReading> {
  validate(member, window);
  const raw = await client.call('sessions.usage', { agentId: member, startDate: window.startDate, endDate: window.endDate, mode: 'utc', groupBy: 'instance', limit: 1 }, options);
  return agentUsageOf(raw, member, window);
}
