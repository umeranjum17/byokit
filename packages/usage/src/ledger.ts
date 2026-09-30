/** Counts measured tokens for a host's member; no credential, account or network access. */
export interface TokenEntry { tokens: number; time: number }
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
  days: { date: string; tokens: number }[];
  week: { from: number; to: number; tokens: number; cap?: number; remaining?: number };
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
    record: (member, entry) => { const rows = entries.get(member) ?? []; rows.push({ tokens: entry.tokens, time: entry.time }); entries.set(member, rows); },
    query: (member, from, to) => (entries.get(member) ?? []).filter((entry) => entry.time >= from && entry.time < to).map((entry) => ({ ...entry })),
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
      let entries: readonly TokenEntry[]; let cap: number | undefined;
      try { entries = store.query(member, Math.min(from, weekFrom), to); cap = typeof options.cap === 'function' ? options.cap(member) : options.cap; }
      catch { throw new TokenLedgerError('store'); }
      if (!Array.isArray(entries) || cap !== undefined && !validCount(cap)) throw new TokenLedgerError('invalid');
      let tokens = 0; let weekTokens = 0; const days = new Map<string, number>();
      for (const entry of entries) {
        if (!entry || !validCount(entry.tokens) || !validTime(entry.time) || entry.time >= to) continue;
        if (entry.time >= weekFrom) weekTokens += entry.tokens;
        if (entry.time < from) continue;
        tokens += entry.tokens; const date = dateOf(entry.time); days.set(date, (days.get(date) ?? 0) + entry.tokens);
      }
      if (!Number.isSafeInteger(tokens) || !Number.isSafeInteger(weekTokens)) throw new TokenLedgerError('invalid');
      return { from, to, tokens, days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, tokens]) => ({ date, tokens })),
        week: { from: weekFrom, to, tokens: weekTokens, ...(cap === undefined ? {} : { cap, remaining: Math.max(0, cap - weekTokens) }) } };
    },
  };
}
