// Pure start-of-run selection. Callers own identities and credentials and keep the returned account for the run.
import type { Billing, Provider } from './catalogue.ts';
import { clock, say } from './words.ts';

export type AccountId = string;
export type AccountRef = AccountId;
export type Via = 'browser' | 'code' | 'paste' | 'key' | 'session';
export type ProviderInfo = Pick<Provider, 'key' | 'name' | 'company' | 'billing' | 'models'> & { via: Via[] };
export type Account = AccountLike & { route: string; label: string; email?: string; plan?: string; billing: Billing; addedAt: number };
export type ModelInfo = { id: string; name: string; tier?: 'strong' | 'fast'; available: boolean; why?: 'plan' | 'resting' | 'signed_out'; until?: number };
export type SignInState = 'ready' | 'signing' | 'resting' | 'signed_out' | 'needs_again' | 'not_included';
export type AccountLike = { id: string; provider: string; name: string; state: SignInState; billing: 'subscription' | 'api'; until?: number };
export type RoomSpan = 'session' | 'week' | 'month' | 'tightest';
/** Every time here is epoch milliseconds; `at` is the source measurement time, never its receipt time. */
export type Room = { left: number; span: RoomSpan; resetsAt?: number; at?: number } | { left: 'unknown'; at?: number };
export type RunSelection = { account: string | 'default' | 'auto'; model?: string; needs?: string[] };
export type Defaults = { account?: string; model?: string; auto?: boolean };
export type PickWhy = 'chosen' | 'default' | 'first_ready' | 'only' | 'most_room' | 'earlier_reset' | 'list_order' | 'no_reading' | 'refills_first';
export type Considered = {
  id: string; out?: 'state' | 'resting' | 'billing' | 'model' | 'provider'; until?: number; missing?: string;
  tier?: 'room' | 'unknown' | 'exhausted'; left: number | 'unknown'; span?: RoomSpan; resetsAt?: number;
  age: number | 'unknown'; confidence: 'known' | 'stale' | 'unknown';
  reason: PickWhy | 'state' | 'resting' | 'billing' | 'model' | 'provider';
};
export type AccountPick<A extends AccountLike = AccountLike> =
  | { ok: true; account: A; model: string; how: 'chosen' | 'default' | 'auto'; why: PickWhy; reason: string; considered: Considered[] }
  | { ok: false; code: 'none' | 'not_included' | 'unknown_account'; reason: string; considered: Considered[] };
type Models<A> = (a: A) => readonly { id: string; available: boolean }[];
type Candidate<A> = { account: A; row: Considered };
const DAY_MS = 24 * 60 * 60 * 1000;
const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const reset = (r: Considered) => r.resetsAt ?? Infinity;

/** Structural windows: legacy reset seconds by default; usage 0.2.0+ must pass milliseconds explicitly. */
export function roomOf(windows: readonly { usedPercent: number; kind: string; resetsAt?: number }[], at?: number, resetUnit: 'seconds' | 'milliseconds' = 'seconds'): Room {
  const known = windows.filter((w) => finite(w.usedPercent));
  if (!known.length) return { left: 'unknown', ...(finite(at) ? { at } : {}) };
  const w = known.reduce((a, b) => b.usedPercent > a.usedPercent ? b : a);
  const span = w.kind === 'session' ? 'session' : w.kind === 'weekly' ? 'week' : w.kind === 'monthly' ? 'month' : 'tightest';
  return { left: Math.max(0, Math.min(100, 100 - w.usedPercent)), span,
    ...(finite(w.resetsAt) ? { resetsAt: w.resetsAt * (resetUnit === 'seconds' ? 1000 : 1) } : {}), ...(finite(at) ? { at } : {}) };
}

export function roomWords(room: Room): string {
  return room.left === 'unknown' ? say('room.unknown') : say(`room.${room.span}`, { left: `${Math.round(room.left)}%` });
}

// One shared eligibility predicate for direct picks, Auto and all explanation rows. Room is read once per row.
function consider<A extends AccountLike>(accounts: readonly A[], room: (a: A) => Room, nowMs: number,
  demand: readonly string[] = [], models?: Models<A>, provider?: string, named?: string): Candidate<A>[] {
  return accounts.map((account) => {
    const r = room(account);
    const age = finite(r.at) ? Math.max(0, nowMs - r.at) : 'unknown';
    const stale = typeof age === 'number' && age > DAY_MS;
    const left = r.left === 'unknown' || !finite(r.left) || stale ? 'unknown' : Math.max(0, Math.min(100, r.left));
    const row: Considered = { id: account.id, left, age,
      confidence: stale ? 'stale' : left === 'unknown' || age === 'unknown' ? 'unknown' : 'known', reason: 'no_reading' };
    if (r.left !== 'unknown') {
      row.span = r.span;
      if (finite(r.resetsAt)) row.resetsAt = r.resetsAt;
    }
    // Explicit ids bypass state and billing: the host verifies readiness before starting, never falls back.
    if (account.id !== named) {
      if (account.state === 'resting' && finite(account.until) && account.until > nowMs) {
        row.out = 'resting'; row.until = account.until;
      } else if (account.state !== 'ready' && !(account.state === 'resting' && finite(account.until) && account.until <= nowMs)) row.out = 'state';
      else if (account.billing !== 'subscription') row.out = 'billing';
    }
    if (!row.out && demand.length && models) {
      const available = models(account);
      const missing = demand.find((id) => !available.some((m) => m.id === id && m.available));
      if (missing !== undefined) { row.out = 'model'; row.missing = missing; }
    }
    if (!row.out && !demand.length && provider !== undefined && account.provider !== provider && account.id !== named) row.out = 'provider';
    if (row.out) row.reason = row.out;
    else row.tier = left === 'unknown' ? 'unknown' : left > 0 || reset(row) <= nowMs ? 'room' : 'exhausted';
    return { account, row };
  });
}

const tierOrder = { room: 0, unknown: 1, exhausted: 2 };
function compare<A>(a: Candidate<A>, b: Candidate<A>): number {
  const tier = tierOrder[a.row.tier!] - tierOrder[b.row.tier!];
  if (tier) return tier;
  if (a.row.tier === 'unknown') return 0;
  if (a.row.tier === 'room' && a.row.left !== b.row.left) return Number(b.row.left) - Number(a.row.left);
  // Avoid Infinity - Infinity (NaN); stable sort preserves list order for ties.
  return reset(a.row) === reset(b.row) ? 0 : reset(a.row) < reset(b.row) ? -1 : 1;
}
function rankingReason<A>(winner: Candidate<A>, next?: Candidate<A>): PickWhy {
  if (winner.row.tier === 'unknown') return 'no_reading';
  if (winner.row.tier === 'exhausted') return 'refills_first';
  if (!next || next.row.tier !== 'room' || winner.row.left !== next.row.left) return 'most_room';
  return reset(winner.row) < reset(next.row) ? 'earlier_reset' : 'list_order';
}
function rank<A>(rows: Candidate<A>[]) {
  const ranked = rows.filter((c) => !c.row.out).sort(compare);
  const winner = ranked[0];
  if (!winner) return undefined;
  const why: PickWhy = ranked.length === 1 ? 'only' : rankingReason(winner, ranked[1]);
  for (const c of ranked) c.row.reason = c === winner ? why : rankingReason(winner, c);
  return { account: winner.account, why, row: winner.row };
}

/** Auto's winner only. Pure and portable; no timers, reads, refreshes or mid-run switching. */
export function chooseAccount<A extends AccountLike>(accounts: readonly A[], room: (a: A) => Room, nowMs: number): { account: A; why: PickWhy } | undefined {
  const pick = rank(consider(accounts, room, nowMs));
  return pick && { account: pick.account, why: pick.why };
}

/** Resolve once before starting. Without `models`, membership is host-validated and a missing model is ''. */
export function resolveSelection<A extends AccountLike>(accounts: readonly A[], defaults: Defaults, sel: RunSelection,
  room: (a: A, demand: readonly string[]) => Room, nowMs: number, models?: Models<A>): AccountPick<A> {
  const demand = [...new Set([...(sel.model ? [sel.model] : []), ...(sel.needs ?? [])])];
  const defaultAccount = accounts.find((a) => a.id === defaults.account);
  const named = sel.account === 'default' ? defaultAccount?.state === 'ready' ? defaultAccount.id : undefined : sel.account === 'auto' ? undefined : sel.account;
  const provider = defaultAccount?.provider ?? accounts[0]?.provider;
  const rows = consider(accounts, (a) => room(a, demand), nowMs, demand, models, provider, named);
  const considered = rows.map((c) => c.row);
  const auto = rank(rows); // also fills explanations for every eligible row, even on explicit selection
  if (named !== undefined) {
    const chosen = rows.find((c) => c.account.id === named);
    if (!chosen) return { ok: false, code: 'unknown_account', reason: say('pick.unknownAccount'), considered };
    if (chosen.row.out) return { ok: false, code: 'not_included', reason: say('pick.out.model', { model: chosen.row.missing ?? '' }), considered };
    return finish(chosen.account, chosen.row, sel.account === 'default' ? 'default' : 'chosen', sel.account === 'default' ? 'default' : 'chosen');
  }
  if (sel.account === 'default' && defaults.auto === false) {
    const first = rows.find((c) => !c.row.out);
    if (first) return finish(first.account, first.row, 'default', 'first_ready');
  } else if (auto) return finish(auto.account, auto.row, 'auto', auto.why);
  return { ok: false, code: 'none', reason: say('auto.none', { provider: provider ?? '' }), considered };

  function finish(account: A, row: Considered, how: 'chosen' | 'default' | 'auto', why: PickWhy): AccountPick<A> {
    const available = models?.(account).filter((m) => m.available);
    const model = sel.model ?? (defaults.model && (!available || available.some((m) => m.id === defaults.model)) ? defaults.model : available?.[0]?.id) ?? '';
    if (models && !model) return { ok: false, code: 'not_included', reason: say('pick.noModel'), considered };
    row.reason = why;
    const slots = { name: account.name, provider: account.provider };
    const reason = how !== 'auto' ? say(`pick.why.${why}`, slots) : row.tier === 'unknown' ? say('auto.unknown', slots) : row.tier === 'exhausted' ?
      say(finite(row.resetsAt) ? 'auto.refills' : 'auto.refillsNoTime', { ...slots, time: finite(row.resetsAt) ? clock(row.resetsAt) : '' }) :
      say('auto.room', { ...slots, room: roomWords({ left: Number(row.left), span: row.span ?? 'tightest' }) });
    return { ok: true, account, model, how, why, reason, considered };
  }
}
