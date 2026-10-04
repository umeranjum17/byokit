// Portable additive day reader. No host files, pricing guesses or side totals for persisted turns.
import { agentUsageOf, type AgentUsageReading } from './usage.ts';
import type { SessionsUsageParams } from '@openclaw/gateway-protocol';
import type { Member } from './types.ts';
export type EngineStartedKind = 'workshop-review';
export type EngineStartedCharge = {
  chargeId: string; member: Member; kind: EngineStartedKind;
  state: 'counted' | 'reported-missing' | 'pending' | 'interrupted';
  startedAt: number; endedAt?: number; outcome?: 'nothing' | 'proposed' | 'applied' | 'failed';
  provider: string; model: string; billing: 'subscription' | 'api' | 'local' | 'unknown'; authProfileId?: string;
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoningTokens?: number; total: number };
  tokenSource: 'engine-reported'; cost: { state: 'missing' }; bootId: string; seq: number;
  origin?: { sessionKey: string; runId?: string };
};
export type AgentDayUsage = {
  member: Member;
  window: { startMs: number; endMs: number } & ({ mode: 'utc' } | { mode: 'time-zone'; timeZone: string });
  transcripts: Omit<AgentUsageReading, 'window'> & { window: { startDate: string; endDate: string } &
    ({ mode: 'utc' } | { mode: 'time-zone'; timeZone: string }) };
  engineStarted: { state: 'available' | 'unavailable'; coverageSince?: number; charges: EngineStartedCharge[]; unreadableLines: number };
  coverage: 'transcripts+workshop-review'; complete: boolean; knownTotalTokens?: number;
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const integer = (v: unknown): v is number => count(v) && Number.isSafeInteger(v);
function dates(window: AgentDayUsage['window']): { startDate: string; endDate: string } {
  if (!integer(window.startMs) || !integer(window.endMs) || window.startMs > window.endMs) throw new Error('Invalid usage window');
  if (window.mode !== 'utc' && window.mode !== 'time-zone') throw new Error('Gateway timezone is unsupported');
  const zone = window.mode === 'utc' ? 'UTC' : window.timeZone;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = (at: number) => {
    const p = Object.fromEntries(formatter.formatToParts(at).map(p => [p.type, p.value]));
    return `${p.year}-${p.month}-${p.day}`;
  };
  return { startDate: day(window.startMs), endDate: day(window.endMs) };
}
/** Only accept the kit's bounded, content-free RPC result; malformed facts make the reading unavailable. */
export function engineStartedOf(raw: unknown, member: Member, window: AgentDayUsage['window']): AgentDayUsage['engineStarted'] & { complete: boolean } {
  const unavailable = { state: 'unavailable' as const, charges: [], unreadableLines: 0, complete: false };
  if (!object(raw) || raw.agentId !== member || raw.startMs !== window.startMs || raw.endMs !== window.endMs || raw.state !== 'available' ||
    !Array.isArray(raw.facts) || !integer(raw.unreadableLines) || !count(raw.coverageSince) || typeof raw.complete !== 'boolean') return unavailable;
  const phases = new Map<string, Record<string, unknown>>();
  for (const fact of raw.facts) {
    if (!object(fact) || fact.v !== 1 || fact.agentId !== member || fact.kind !== 'workshop-review' ||
      !['started', 'ended'].includes(String(fact.phase)) || !text(fact.chargeId) || !text(fact.bootId) ||
      !text(fact.provider) || !text(fact.model) || !integer(fact.seq) || fact.seq < 1 || !count(fact.at) || !count(fact.startedAt) ||
      (fact.authProfileId !== undefined && !text(fact.authProfileId)) ||
      (fact.outcome !== undefined && !['nothing', 'proposed', 'applied', 'failed'].includes(String(fact.outcome)))) return unavailable;
    const key = `${fact.chargeId}\0${fact.phase}`;
    const previous = phases.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(fact)) return unavailable;
    phases.set(key, fact);
  }
  const ids = new Set([...phases.values()].map(f => f.chargeId as string));
  const charges: EngineStartedCharge[] = [];
  for (const id of ids) {
    const ended = phases.get(`${id}\0ended`), started = phases.get(`${id}\0started`);
    if (ended && started && ['agentId', 'bootId', 'kind', 'provider', 'model', 'authProfileId', 'startedAt'].some(k => started[k] !== ended[k])) return unavailable;
    const fact = ended ?? started!;
    const at = ended ? fact.at as number : fact.startedAt as number;
    if (at < window.startMs || at > window.endMs) continue;
    let tokens: EngineStartedCharge['tokens'];
    if (object(fact.usage) && count(fact.usage.total) && ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens'].every(k => (fact.usage as Record<string, unknown>)[k] === undefined || count((fact.usage as Record<string, unknown>)[k]))) {
      tokens = { total: fact.usage.total };
      for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoningTokens'] as const) if (count(fact.usage[k])) tokens[k] = fact.usage[k];
    }
    const charge: EngineStartedCharge = { chargeId: id, member, kind: 'workshop-review', state: ended ? (tokens ? 'counted' : 'reported-missing') :
      fact.bootId === raw.liveBootId ? 'pending' : 'interrupted', startedAt: fact.startedAt as number,
      provider: fact.provider as string, model: fact.model as string, billing: 'unknown', tokenSource: 'engine-reported',
      cost: { state: 'missing' }, bootId: fact.bootId as string, seq: fact.seq as number };
    if (ended) charge.endedAt = fact.at as number;
    if (fact.outcome !== undefined) charge.outcome = fact.outcome as EngineStartedCharge['outcome'];
    if (fact.authProfileId !== undefined) charge.authProfileId = fact.authProfileId as string;
    if (tokens && ended) charge.tokens = tokens;
    if (object(fact.origin) && text(fact.origin.sessionKey) && (fact.origin.runId === undefined || text(fact.origin.runId)))
      charge.origin = { sessionKey: fact.origin.sessionKey, ...(fact.origin.runId ? { runId: fact.origin.runId as string } : {}) };
    charges.push(charge);
  }
  charges.sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt) || a.chargeId.localeCompare(b.chargeId));
  return { state: 'available', coverageSince: raw.coverageSince, charges, unreadableLines: raw.unreadableLines,
    complete: raw.complete && raw.unreadableLines === 0 && window.startMs >= raw.coverageSince && charges.every(c => c.state === 'counted') };
}
/** Read the transcript and Workshop terms independently. A failed term never becomes zero. */
export async function readAgentDayUsage(client: { callDynamic(method: string, params?: unknown): Promise<unknown>;
  call(method: 'sessions.usage', params: SessionsUsageParams): Promise<unknown> }, member: Member, window: AgentDayUsage['window']): Promise<AgentDayUsage> {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(member)) throw new Error('Invalid member');
  const day = dates(window);
  const [transcriptRaw, ledgerRaw] = await Promise.all([
    client.call('sessions.usage', { agentId: member, ...day, mode: window.mode === 'utc' ? 'utc' : 'specific',
      ...(window.mode === 'time-zone' ? { timeZone: window.timeZone } : {}), groupBy: 'instance', limit: 1 }).catch(() => undefined),
    client.callDynamic('byokit.usage.engineStarted', { agentId: member, startMs: window.startMs, endMs: window.endMs }).catch(() => undefined),
  ]);
  const transcripts: AgentDayUsage['transcripts'] = { ...agentUsageOf(transcriptRaw, member, day), window: { ...day,
    ...(window.mode === 'utc' ? { mode: 'utc' as const } : { mode: 'time-zone' as const, timeZone: window.timeZone }) } };
  // The pinned RPC reports calendar-day totals, not arbitrary millisecond slices. Never claim an exact partial-day total.
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: window.mode === 'utc' ? 'UTC' : window.timeZone,
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  if (clock.format(window.startMs) !== '00:00:00' || window.startMs % 1000 !== 0 ||
    clock.format(window.endMs) !== '23:59:59' || window.endMs % 1000 !== 999) {
    transcripts.state = 'unavailable'; delete transcripts.totals;
  }
  const { complete, ...engineStarted } = engineStartedOf(ledgerRaw, member, window);
  const result: AgentDayUsage = { member, window, transcripts, engineStarted, coverage: 'transcripts+workshop-review',
    complete: complete && transcripts.state === 'available' };
  if (transcripts.totals && engineStarted.state === 'available') result.knownTotalTokens = transcripts.totals.totalTokens +
    engineStarted.charges.reduce((n, c) => n + (c.state === 'counted' ? c.tokens!.total : 0), 0);
  return result;
}
