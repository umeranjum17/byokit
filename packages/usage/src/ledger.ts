import type { CallRecord } from './calls.ts';

/** Counts measured tokens for a host's member; no credential, account or network access. */
export interface TokenEntry { tokens: number; time: number; call?: CallRecord }
export interface TokenLedgerStore {
  record(member: string, entry: TokenEntry): void;
  /** Entries in [from, to); the ledger checks bounds again before counting. */
  query(member: string, from: number, to: number): readonly TokenEntry[];
}
export interface TokenLedgerOptions {
  store?: TokenLedgerStore;
  /** Seven-day token allowance. Missing means uncapped; zero means no allowance. */
  cap?: number | ((member: string) => number | undefined);
}
export interface TokenQuery {
  from: number;
  to: number;
  tokens: number;
  /** Present when call records lack reported total tokens; tokens is the known subtotal. */
  unknownCalls?: number;
  days: { date: string; tokens: number; unknownCalls?: number }[];
  week: { from: number; to: number; tokens: number; cap?: number; remaining?: number; unknownCalls?: number };
}
export interface TokenLedger {
  record(member: string, tokens: number, time: number): void;
  query(member: string, from: number, to: number): TokenQuery;
}
export class TokenLedgerError extends Error {
  readonly code: 'invalid' | 'store';
  override name = 'TokenLedgerError';
  constructor(code: 'invalid' | 'store') { super(code === 'invalid' ? 'The app supplied an invalid token ledger value.' : 'The token ledger store did not answer.'); this.code = code; }
}
const validMember = (member: string) => typeof member === 'string' && !!member && member.length <= 1024 && !member.includes('\0');
const validTime = (time: number) => typeof time === 'number' && Number.isFinite(time) && !Number.isNaN(new Date(time).getTime());
const validCount = (tokens: number) => Number.isSafeInteger(tokens) && tokens >= 0;
const dateOf = (time: number) => {
  const date = new Date(time);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
export function memoryTokenLedgerStore(): TokenLedgerStore {
  const entries = new Map<string, TokenEntry[]>();
  return {
    record: (member, entry) => { const rows = entries.get(member) ?? []; rows.push(copyEntry(entry)); entries.set(member, rows); },
    query: (member, from, to) => (entries.get(member) ?? []).filter((entry) => entry.time >= from && entry.time < to).map(copyEntry),
  };
}
/** Local calendar days, including DST changes; all API timestamps are epoch milliseconds. */
export function tokenLedger(options: TokenLedgerOptions = {}): TokenLedger {
  const store = options.store ?? memoryTokenLedgerStore();
  if (options.cap !== undefined && typeof options.cap !== 'function' && !validCount(options.cap)) throw new TokenLedgerError('invalid');
  return {
    record(member, tokens, time) {
      if (!validMember(member) || !validCount(tokens) || !validTime(time)) throw new TokenLedgerError('invalid');
      try { store.record(member, { tokens, time }); } catch { throw new TokenLedgerError('store'); }
    },
    query(member, from, to) {
      if (!validMember(member) || !validTime(from) || !validTime(to) || to < from) throw new TokenLedgerError('invalid');
      const start = new Date(to); start.setDate(start.getDate() - 7);
      const weekFrom = start.getTime();
      if (!validTime(weekFrom)) throw new TokenLedgerError('invalid');
      let entries: readonly TokenEntry[]; let cap: number | undefined;
      try { entries = store.query(member, Math.min(from, weekFrom), to); cap = typeof options.cap === 'function' ? options.cap(member) : options.cap; }
      catch { throw new TokenLedgerError('store'); }
      if (!Array.isArray(entries) || cap !== undefined && !validCount(cap)) throw new TokenLedgerError('invalid');
      let tokens = 0; let weekTokens = 0; let unknownCalls = 0; let weekUnknown = 0;
      const days = new Map<string, { tokens: number; unknownCalls: number }>();
      for (const entry of entries) {
        if (!entry || !validCount(entry.tokens) || !validTime(entry.time) || entry.time >= to) continue;
        const unknown = entry.call !== undefined && entry.call.tokens.total === undefined ? 1 : 0;
        if (entry.time >= weekFrom) { weekTokens += entry.tokens; weekUnknown += unknown; }
        if (entry.time < from) continue;
        tokens += entry.tokens; unknownCalls += unknown; const date = dateOf(entry.time);
        const previous = days.get(date) ?? { tokens: 0, unknownCalls: 0 };
        days.set(date, { tokens: previous.tokens + entry.tokens, unknownCalls: previous.unknownCalls + unknown });
      }
      if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(weekTokens)) throw new TokenLedgerError('invalid');
      return { from, to, tokens, ...(unknownCalls ? { unknownCalls } : {}), days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, counts]) => ({ date, tokens: counts.tokens, ...(counts.unknownCalls ? { unknownCalls: counts.unknownCalls } : {}) })),
        week: { from: weekFrom, to, tokens: weekTokens, ...(weekUnknown ? { unknownCalls: weekUnknown } : {}), ...(cap === undefined ? {} : { cap, ...(weekUnknown ? {} : { remaining: Math.max(0, cap - weekTokens) }) }) } };
    },
  };
}

function copyEntry(entry: TokenEntry): TokenEntry {
  const call = entry.call;
  return { tokens: entry.tokens, time: entry.time, ...(call ? { call: { ...call, tokens: { ...call.tokens },
    ...(call.cost ? { cost: { ...call.cost } } : {}), ...(call.limits ? { limits: call.limits.map((window) => ({ ...window })) } : {}) } } : {}) };
}
