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
