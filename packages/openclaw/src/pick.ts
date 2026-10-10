// The pure start-of-run selection for the OpenClaw kit (docs/runtime-kits.md 5.13, 5.15): one eligibility predicate
// (`consider`), the Auto ranker (`chooseAccount`) and `resolveSelection`, with the kit-only `bound` list marking the
// accounts a conversation may use. Ported structurally from `@byokit/accounts`' `multi.ts`; never imports it (D3).
import type {
  Account, AccountId, AccountPick, Considered, Defaults, ModelInfo, PickWhy, Room, RoomSpan, RunSelection,
} from './types.ts';
import { words, type WordKey } from './words.ts';

export type RoomOf = (a: Account, demand: readonly string[]) => Room;
type Candidate = { account: Account; row: Considered };
const DAY_MS = 24 * 60 * 60 * 1000;
const finite = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n);
const reset = (r: Considered) => r.resetsAt ?? Infinity;
const roomWords = (left: number, span: RoomSpan) => words(`room.${span}` as WordKey, { left: `${Math.round(left)}%` });
// "3:40pm", or "Fri 3:40pm" when it isn't today (matches @byokit/accounts' clock).
const clock = (t: number) => (new Date(t).toDateString() === new Date().toDateString() ? '' : new Date(t).toLocaleDateString('en-US', { weekday: 'short' }) + ' ') +
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();

// One shared eligibility predicate for direct picks, Auto and every explanation row. Room is read once per row.
// `bound` (kit only) is the accounts a conversation may use; an account outside it is never a candidate, even when
// the selection names it, and its row carries `out: 'bound'`. An account the selection names is judged only on
// `bound` and the demand, so an API-key or resting account it names carries no `billing`/`resting` `out`.
function considerRows(accounts: readonly Account[], room: (a: Account) => Room, nowMs: number,
  demand: readonly string[] = [], models?: (a: Account) => readonly ModelInfo[], provider?: string,
  named?: AccountId, bound?: readonly AccountId[]): Candidate[] {
  return accounts.map((account) => {
    const r = room(account);
    const age = finite(r.at) ? Math.max(0, nowMs - r.at) : 'unknown';
    const stale = typeof age === 'number' && age > DAY_MS;
    const left = r.left === 'unknown' || !finite(r.left) || stale ? 'unknown' : Math.max(0, Math.min(100, r.left));
    const row: Considered = { id: account.id, left, age,
      confidence: stale ? 'stale' : left === 'unknown' || age === 'unknown' ? 'unknown' : 'known', reason: 'no_reading' };
    if (r.left !== 'unknown') { row.span = r.span; if (finite(r.resetsAt)) row.resetsAt = r.resetsAt; }
    if (bound !== undefined && !bound.includes(account.id)) row.out = 'bound';
    if (!row.out && account.id !== named) {
      if (account.state === 'resting' && finite(account.until) && account.until > nowMs) { row.out = 'resting'; row.until = account.until; }
      else if (account.state !== 'ready' && !(account.state === 'resting' && finite(account.until) && account.until <= nowMs)) row.out = 'state';
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

/** Every account's `Considered` row, in list order, with the kit-only `bound` applied. */
export function consider(accounts: readonly Account[], defaults: Defaults, sel: RunSelection, room: RoomOf,
  nowMs: number, models?: (a: Account) => readonly ModelInfo[], bound?: readonly AccountId[]): Considered[] {
  const demand = [...new Set([...(sel.model ? [sel.model] : []), ...(sel.needs ?? [])])];
  const defaultAccount = accounts.find((a) => a.id === defaults.account);
  const named = nameOf(accounts, defaults, sel, bound);
  const provider = sel.provider ?? defaultAccount?.provider ?? accounts[0]?.provider;
  return considerRows(accounts, (a) => room(a, demand), nowMs, demand, models, provider, named, bound).map((c) => c.row);
}

const tierOrder = { room: 0, unknown: 1, exhausted: 2 };
function compare(a: Candidate, b: Candidate): number {
  const tier = tierOrder[a.row.tier!] - tierOrder[b.row.tier!];
  if (tier) return tier;
  if (a.row.tier === 'unknown') return 0;
  if (a.row.tier === 'room' && a.row.left !== b.row.left) return Number(b.row.left) - Number(a.row.left);
  // Avoid Infinity - Infinity (NaN); stable sort preserves list order for ties.
  return reset(a.row) === reset(b.row) ? 0 : reset(a.row) < reset(b.row) ? -1 : 1;
}
function rankingReason(winner: Candidate, next?: Candidate): PickWhy {
  if (winner.row.tier === 'unknown') return 'no_reading';
  if (winner.row.tier === 'exhausted') return 'refills_first';
  if (!next || next.row.tier !== 'room' || winner.row.left !== next.row.left) return 'most_room';
  return reset(winner.row) < reset(next.row) ? 'earlier_reset' : 'list_order';
}
function rank(rows: Candidate[]) {
  const ranked = rows.filter((c) => !c.row.out).sort(compare);
  const winner = ranked[0];
  if (!winner) return undefined;
  const why: PickWhy = ranked.length === 1 ? 'only' : rankingReason(winner, ranked[1]);
  for (const c of ranked) c.row.reason = c === winner ? why : rankingReason(winner, c);
  return { account: winner.account, why, row: winner.row };
}

/** Auto's winner only; `candidates` are the eligible accounts. Pure and portable; no timers, reads or mid-run switching. */
export function chooseAccount(candidates: readonly Account[], room: (a: Account) => Room, nowMs: number): { account: Account; why: PickWhy } | undefined {
  const pick = rank(considerRows(candidates, room, nowMs));
  return pick && { account: pick.account, why: pick.why };
}

// The `'default'` id is the saved default account when it is ready, a subscription (or a non-custom API choice) and
// in `bound`; a default outside `bound` is treated as not ready (its row has `out: 'bound'`) and the pick falls through.
function nameOf(accounts: readonly Account[], defaults: Defaults, sel: RunSelection, bound?: readonly AccountId[]): AccountId | undefined {
  const defaultAccount = accounts.find((a) => a.id === defaults.account);
  const usable = defaultAccount?.state === 'ready' &&
    (defaultAccount.billing === 'subscription' || (defaultAccount.billing === 'api' && defaultAccount.provider !== 'custom')) &&
    (bound === undefined || bound.includes(defaultAccount.id));
  return sel.account === 'default' ? (usable ? defaultAccount!.id : undefined) : sel.account === 'auto' ? undefined : sel.account;
}

/** Resolve once before starting. Without `models`, membership is host-validated and a missing model is ''. */
export function resolveSelection(accounts: readonly Account[], defaults: Defaults, sel: RunSelection, room: RoomOf,
  nowMs: number, models?: (a: Account) => readonly ModelInfo[], bound?: readonly AccountId[]): AccountPick {
  const demand = [...new Set([...(sel.model ? [sel.model] : []), ...(sel.needs ?? [])])];
  const defaultAccount = accounts.find((a) => a.id === defaults.account);
  const named = nameOf(accounts, defaults, sel, bound);
  const provider = sel.provider ?? defaultAccount?.provider ?? accounts[0]?.provider;
  const rows = considerRows(accounts, (a) => room(a, demand), nowMs, demand, models, provider, named, bound);
  const considered = rows.map((c) => c.row);
  const auto = rank(rows); // also fills explanations for every eligible row, even on explicit selection
  if (named !== undefined) {
    const chosen = rows.find((c) => c.account.id === named);
    if (!chosen) return { ok: false, code: 'unknown_account', reason: words('auto.none', { provider: provider ?? '' }), considered };
    if (chosen.row.out) return { ok: false, code: 'not_included', reason: words(`pick.out.${chosen.row.out}` as WordKey, { model: chosen.row.missing ?? '' }), considered };
    return finish(chosen.account, chosen.row, sel.account === 'default' ? 'default' : 'chosen', sel.account === 'default' ? 'default' : 'chosen');
  }
  if (sel.account === 'default' && defaults.auto === false) {
    const first = rows.find((c) => !c.row.out);
    if (first) return finish(first.account, first.row, 'default', 'first_ready');
  } else if (auto) return finish(auto.account, auto.row, 'auto', auto.why);
  return { ok: false, code: 'none', reason: words('auto.none', { provider: provider ?? '' }), considered };

  function finish(account: Account, row: Considered, how: 'chosen' | 'default' | 'auto', why: PickWhy): AccountPick {
    const available = models?.(account).filter((m) => m.available);
    const model = sel.model ?? (defaults.model && (!available || available.some((m) => m.id === defaults.model)) ? defaults.model : available?.[0]?.id) ?? '';
    if (models && !model) return { ok: false, code: 'not_included', reason: words('pick.out.model', { model: sel.model ?? '' }), considered };
    row.reason = why;
    const slots = { name: account.name, provider: account.provider };
    const reason = how !== 'auto' ? words(`pick.why.${why}` as WordKey, slots) : row.tier === 'unknown' ? words('auto.unknown', slots) : row.tier === 'exhausted' ?
      words(finite(row.resetsAt) ? 'auto.refills' : 'auto.refillsNoTime', { ...slots, time: finite(row.resetsAt) ? clock(row.resetsAt) : '' }) :
      words('auto.room', { ...slots, room: roomWords(Number(row.left), row.span ?? 'tightest') });
    return { ok: true, account, model, how, why, reason, considered };
  }
}
