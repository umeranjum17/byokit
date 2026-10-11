// One row per account, in plain words: the provider and the person's own name for it, then the plan and the room
// left, or the honest reason it is not usable right now. Framework-free and portable: it reads only the fields it
// names (D3), so no credential on an account ever reaches a row. `AccountsSource` is the shape an app fills from its
// own back end; @byokit/accounts `list()` and a room reading fit it with at most one line per member.
import WORDS from './words.json' with { type: 'json' };

export type Billing = 'subscription' | 'api' | 'local' | 'free' | 'unknown';
export type SignInState = 'ready' | 'signing' | 'resting' | 'signed_out' | 'needs_again' | 'not_included';
export type RoomSpan = 'session' | 'week' | 'month' | 'tightest';
/** A room-left reading, restated structurally from `@byokit/accounts` (multi.ts): a known percentage or 'unknown'. */
export type Room = { left: number; span: RoomSpan; resetsAt?: number; at?: number } | { left: 'unknown'; at?: number };
/** One account as `@byokit/accounts` `list()` reports it; only these fields are read, extra ones (a token included) are ignored. */
export type Account = {
  id: string; provider: string; name: string; label?: string;
  state: SignInState; billing: Billing; plan?: string; until?: number;
};

/** What an app supplies: the accounts it lists and one room reading per account. `AccountsSource` is the seam between
 *  any back end and these rows; an at-most-one-line-per-member adapter fits it. */
export type AccountsSource = {
  accounts: () => Promise<readonly Account[]> | readonly Account[];
  room: (account: Account) => Promise<Room> | Room;
};

export type AccountAction = 'sign_in' | 'wait';
export type AccountRow = {
  id: string; title: string; detail: string; state: SignInState; billing: Billing;
  /** Room left is at or below 20%: true at exactly 20, false above it or when the room is unknown. */
  low: boolean;
  /** What the person can do: sign in again, or wait for a resting account to refill. Absent when nothing helps. */
  action?: AccountAction;
  /** A resting account's next refill, epoch milliseconds. */
  until?: number;
};

const UNKNOWN: Room = { left: 'unknown' };
const LOW_AT = 20;

const roomWords = (r: Room): string =>
  r.left === 'unknown' ? WORDS['account.room.unknown'] : (WORDS[`account.room.${r.span}`] as string).replace('{left}', `${Math.round(r.left)}%`);

const planLabel = (plan: string): string => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '');

/** 'ChatGPT · Work', or just the provider's own name when the account keeps it. An email is never used as a name. */
function titleOf(a: Account): string {
  const provider = a.label || a.provider;
  const name = a.name && !a.name.includes('@') && a.name.toLowerCase() !== provider.toLowerCase() ? a.name : '';
  return name ? `${provider} · ${name}` : provider;
}

/** A resting account whose refill time has passed reads as ready again, exactly as the Auto chooser treats it. */
const refilled = (a: Account, now: number): boolean => a.state === 'resting' && typeof a.until === 'number' && a.until <= now;

function rowOf(a: Account, room: Room, now: number): AccountRow {
  const state: SignInState = refilled(a, now) ? 'ready' : a.state;
  const title = titleOf(a);
  if (state === 'ready') {
    const words = roomWords(room);
    return { id: a.id, title, detail: a.plan && room.left !== 'unknown' ? `${planLabel(a.plan)} · ${words}` : words, state, billing: a.billing,
      low: room.left !== 'unknown' && room.left <= LOW_AT };
  }
  if (state === 'resting') {
    return { id: a.id, title, detail: WORDS['account.resting'], state, billing: a.billing, low: false, action: 'wait',
      ...(typeof a.until === 'number' ? { until: a.until } : {}) };
  }
  const action: AccountAction | undefined = state === 'signed_out' || state === 'needs_again' ? 'sign_in' : undefined;
  return { id: a.id, title, detail: WORDS[`account.${state}`], state, billing: a.billing, low: false, ...(action ? { action } : {}) };
}

/** One row per account, reading one room per account; a missing or throwing reading is 'Room left unknown'. */
export function accountRows(accounts: readonly Account[], room: (account: Account) => Room, now: number): AccountRow[] {
  return accounts.map((a) => {
    let r: Room = UNKNOWN;
    try { r = room(a) ?? UNKNOWN; } catch { r = UNKNOWN; }
    return rowOf(a, r, now);
  });
}

/** `accountRows` over an `AccountsSource`: the app's own `accounts()` and `room()`, awaited; a failing room reads unknown. */
export async function rowsOf(source: AccountsSource, now: number): Promise<AccountRow[]> {
  const accounts = await source.accounts();
  const rooms = new Map<string, Room>();
  for (const a of accounts) {
    try { rooms.set(a.id, (await source.room(a)) ?? UNKNOWN); } catch { rooms.set(a.id, UNKNOWN); }
  }
  return accountRows(accounts, (a) => rooms.get(a.id) ?? UNKNOWN, now);
}

/** Untaken names an app can offer for a new account, from the email's local part (never the email itself), else the
 *  provider's name. Dedupes case-insensitively against `taken`; up to three. */
export function nameSuggestions(email: string | undefined, taken: readonly string[], provider = 'Account'): string[] {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const local = email?.split('@')[0]?.split(/[._-]+/).find(Boolean) ?? '';
  const base = (local ? local.charAt(0).toUpperCase() + local.slice(1).toLowerCase() : provider).slice(0, 64) || provider;
  const out: string[] = [];
  for (let n = 1; out.length < 3 && n < 100; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!used.has(name.toLowerCase())) { out.push(name); used.add(name.toLowerCase()); }
  }
  return out;
}

// ---- The run picker and the Move target -------------------------------------------------------------------
// Both restate `@byokit/accounts` structurally (D3), so this entry stays framework-free and Node-free: an app fills
// the picker from `list()` and `models()`, and hands it the pick `resolveSelection` already made for `'auto'`.

/** Why one of an account's models cannot be used right now, restated from `@byokit/accounts` (multi.ts). */
export type ModelWhy = 'plan' | 'resting' | 'signed_out';
/** One model as `@byokit/accounts` `models()` lists it: a strong/fast tier, whether it can run, and, when it can't, why. */
export type ModelInfo = { id: string; name: string; tier?: 'strong' | 'fast'; available: boolean; why?: ModelWhy; until?: number };

/** What a run asks for, restated structurally: an account (or `default`/`auto`) and one model. */
export type RunSelection = { account: string | 'default' | 'auto'; model?: string };

/** Why Auto named (or could not name) an account, restated from `@byokit/accounts` `resolveSelection`. */
export type PickWhy = 'chosen' | 'default' | 'first_ready' | 'only' | 'most_room' | 'earlier_reset' | 'list_order' | 'no_reading' | 'refills_first';

/** Why an account cannot be used, as Auto judges it, restated from `@byokit/accounts` `Considered`. */
export type PickOut = 'state' | 'resting' | 'billing' | 'model' | 'provider';
/** One account's line in the pick's explanation; only the id, the why and the refill time are read here. */
type ConsideredRow = { id: string; out?: PickOut; until?: number };

/** `@byokit/accounts` `resolveSelection`/`pick`, restated structurally: what Auto chose, or why it could not. */
export type Pick =
  | { ok: true; account: Account; model: string; how: 'chosen' | 'default' | 'auto'; why: PickWhy; reason: string; considered?: readonly ConsideredRow[] }
  | { ok: false; code: 'none' | 'not_included' | 'unknown_account'; reason: string; considered?: readonly ConsideredRow[] };

/** One model row under an account, marked `selected` when it is the run's model. */
export type PickerModel = ModelInfo & { selected: boolean };

/** One picker row: the `Auto — most room left` row first, then one per account in list order. */
export type PickerRow = {
  /** `'auto'`, or the account id. */
  key: string;
  kind: 'auto' | 'account';
  /** `Auto — most room left`, or the account's own plain title (`ChatGPT · Work`). */
  title: string;
  /** Auto's own reason in words on the Auto row; an account row's why, or its status when it can be used. */
  detail: string;
  /** True for the one row the run is set to use. */
  selected: boolean;
  /** True when the row cannot be chosen; only Auto, when it has no account to name. */
  disabled: boolean;
  /** Why Auto is disabled, typed from the pick's failure code; present only when `disabled`. */
  disabledReason?: 'none' | 'not_included' | 'unknown_account';
  /** Why the account cannot be used right now: a sign-in problem, a rest, per-use billing, a missing model, or
   *  another service. Absent when it can be used. */
  out?: PickOut;
  /** A resting account's next refill, epoch milliseconds. */
  until?: number;
  /** This account's models, each marked when it is the run's model; empty for the Auto row. */
  models: PickerModel[];
};

/** What a run or settings sheet draws: the rows, the named selection, and what it resolves to. */
export type PickerView = {
  rows: PickerRow[];
  /** Exactly what `sel.account` named: `'auto'` or an account id. */
  selection: string;
  /** True when the selection resolves to a usable account and model. */
  ok: boolean;
  /** The account the run uses, when `ok`. */
  account?: string;
  /** The model the run uses, when `ok`. */
  model?: string;
};

/** An account is usable when it is ready, or resting with its refill time already passed, exactly as a row reads. */
const usableNow = (a: Account, now: number): boolean => a.state === 'ready' || refilled(a, now);

/** The one sentence a Move sheet shows: `Move to Work` after a tap, `Couldn't move to Work` after a refusal. */
export function moveWords(name: string, moved = true): string {
  return WORDS[moved ? 'move.to' : 'move.failed'].replace('{name}', name);
}

/**
 * The picker rows for a run selection, with the selection marked: the `Auto — most room left` row carrying Auto's
 * own `pick.reason`, then one row per account with its model rows and, when it cannot be used, Auto's why and
 * `until`. `auto` is the pick `@byokit/accounts` `resolveSelection` made for `{ account: 'auto' }`; a signed-out
 * explicit pick is shown as `Sign in first` and never replaced by another account.
 */
export function modelPicker(accounts: readonly Account[], models: Record<string, readonly ModelInfo[]>, sel: RunSelection, auto: Pick, now = Date.now()): PickerView {
  const considered = new Map((auto.considered ?? []).map((r) => [r.id, r] as const));
  let account: string | undefined;
  let model: string | undefined;
  if (sel.account === 'auto') {
    if (auto.ok) { account = auto.account.id; model = auto.model; }
  } else {
    const chosen = accounts.find((a) => a.id === sel.account);
    if (chosen && usableNow(chosen, now)) {
      const available = (models[chosen.id] ?? []).filter((m) => m.available);
      const pick = sel.model && available.some((m) => m.id === sel.model) ? sel.model : available[0]?.id;
      if (pick) { account = chosen.id; model = pick; }
    }
  }
  const rows: PickerRow[] = [{
    key: 'auto', kind: 'auto', title: WORDS['picker.auto'], detail: auto.reason,
    selected: sel.account === 'auto', disabled: !auto.ok, ...(auto.ok ? {} : { disabledReason: auto.code }), models: [],
  }];
  for (const a of accounts) {
    const isSelected = sel.account === a.id;
    const why = considered.get(a.id);
    const out = why?.out ?? (usableNow(a, now) ? undefined : a.state === 'resting' ? 'resting' : 'state');
    const rowModels: PickerModel[] = (models[a.id] ?? []).map((m) => ({ ...m, selected: a.id === account && m.id === model && m.available }));
    rows.push({
      key: a.id, kind: 'account', title: titleOf(a), detail: out ? WORDS[`picker.out.${out}`] : '', selected: isSelected, disabled: false,
      ...(out ? { out } : {}), ...(out && why?.until !== undefined ? { until: why.until } : {}), models: rowModels,
    });
  }
  const ok = account !== undefined && model !== undefined;
  return { rows, selection: sel.account, ok, ...(ok ? { account, model } : {}) };
}

const MOVE_DAY_MS = 24 * 60 * 60 * 1000;
type AutoTier = 'room' | 'unknown' | 'exhausted';
type AutoCandidate = { account: Account; tier: AutoTier; left: number | 'unknown'; resetsAt?: number; out?: 'state' | 'resting' | 'billing' };
const TIER_ORDER: Record<AutoTier, number> = { room: 0, unknown: 1, exhausted: 2 };

/**
 * Auto's winner among `accounts`, mirroring `@byokit/accounts` `chooseAccount` (multi.ts): subscriptions only, most
 * room, unknown above exhausted, earliest reset then list order. Used by `bestMoveTarget`, and cross-checked against
 * the real chooser over `fixtures/conformance/auto-pick-typescript.json`.
 */
function autoCandidate(accounts: readonly Account[], room: (a: Account) => Room, now: number): AutoCandidate | undefined {
  const rows = accounts.map((a): AutoCandidate => {
    const r = room(a);
    const age = typeof r.at === 'number' ? Math.max(0, now - r.at) : 'unknown';
    const stale = typeof age === 'number' && age > MOVE_DAY_MS;
    const left = r.left === 'unknown' || typeof r.left !== 'number' || stale ? 'unknown' : Math.max(0, Math.min(100, r.left));
    let out: AutoCandidate['out'];
    if (a.state === 'resting' && typeof a.until === 'number' && a.until > now) out = 'resting';
    else if (a.state !== 'ready' && !(a.state === 'resting' && typeof a.until === 'number' && a.until <= now)) out = 'state';
    else if (a.billing !== 'subscription') out = 'billing';
    const reset = r.left !== 'unknown' && typeof r.resetsAt === 'number' ? r.resetsAt : undefined;
    const tier: AutoTier = left === 'unknown' ? 'unknown' : left > 0 || (reset !== undefined && reset <= now) ? 'room' : 'exhausted';
    return { account: a, tier, left, ...(out ? { out } : {}), ...(reset !== undefined ? { resetsAt: reset } : {}) };
  });
  const ranked = rows.filter((c) => !c.out).sort((x, y) => {
    const tier = TIER_ORDER[x.tier] - TIER_ORDER[y.tier];
    if (tier) return tier;
    if (x.tier === 'unknown') return 0;
    if (x.tier === 'room' && x.left !== y.left) return Number(y.left) - Number(x.left);
    const rx = x.resetsAt ?? Infinity; const ry = y.resetsAt ?? Infinity;
    return rx === ry ? 0 : rx < ry ? -1 : 1;
  });
  return ranked[0];
}

/**
 * The account a running session should move to, or undefined when there is nowhere better to go: `@byokit/accounts`
 * `chooseAccount`'s own winner (`moveToAccount` carries the session there). Nothing to move to with one account,
 * with only signed-out peers, when nobody has room left, or when the list is API keys only; the current account is
 * never named back to itself. `now` defaults to the current time, as `accountRows` does.
 */
export function bestMoveTarget(accounts: readonly Account[], room: Record<string, Room>, current: string, now = Date.now()): string | undefined {
  const pick = autoCandidate(accounts, (a) => room[a.id] ?? { left: 'unknown' }, now);
  if (!pick || pick.account.id === current || pick.tier === 'exhausted') return undefined;
  return pick.account.id;
}
