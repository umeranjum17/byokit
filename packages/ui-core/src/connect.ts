// "Connect an AI account" as headless view state: every route the kits list (D18), grouped by how the person pays,
// with plain words for the billing, the method and whether it works here. Plans come first and are the only rows
// offered by default; every other row is listed and used only when the person picks it. Nothing here names a
// provider: groups and words come from each row's billing, method and readiness alone. Framework-free.
import WORDS from './words.json' with { type: 'json' };
import { keyStep, keyView, type KeyAction, type KeyState } from './key.ts';
import type { UseSignIn } from './useSignIn.ts';

export type Billing = 'subscription' | 'api' | 'local' | 'free' | 'unknown';
export type Via = 'browser' | 'code' | 'paste' | 'key' | 'session' | 'setup_token' | 'cli' | 'plan_key' | 'cloud' | 'local' | 'endpoint';
export type Readiness = 'ready' | 'needs_binary' | 'needs_plugin' | 'needs_host' | 'needs_client' | 'unsupported_platform' | 'no_upstream_flow';

/** One route as any kit's `routes()` lists it, restated structurally (D3): `@byokit/accounts` and
 *  `@byokit/openclaw` route views fit as they are. Only these fields are read, so nothing else (a credential
 *  included) can reach the view. */
export type ConnectRoute = {
  id: string; provider: string; name?: string; company?: string;
  via: Via; billing: Billing;
  /** accounts: `'default' | 'explicit'`; openclaw: `offerPolicy` plus its legacy ready-only boolean `offer`. */
  offer?: 'default' | 'explicit' | boolean; offerPolicy?: 'default' | 'explicit';
  /** openclaw: `services` marks speech, search, media and other non-chat rows. */
  group?: 'models' | 'services';
  upstream?: { surface: 'accounts' | 'openclaw' | 'herdr' };
  readiness: Readiness;
};

export type ConnectGroupId = 'plans' | 'perUse' | 'local' | 'server' | 'cloud' | 'other' | 'services';
/** What choosing a row leads to: a sign-in sheet (`useSignIn`), a key card (`keyView`), the app's own setup form
 *  (cloud account, local model, server address and its billing), or the reason it cannot be used here. */
export type ConnectDoes = 'signin' | 'key' | 'setup' | 'unavailable';

export type ConnectRow = {
  /** Unique across kits: `<surface>/<id>`. */
  key: string; id: string; provider: string; surface?: 'accounts' | 'openclaw' | 'herdr';
  name: string; company: string; via: Via; billing: Billing; group: ConnectGroupId;
  /** Offered by default: a ready subscription row. Never true for any other billing. */
  offered: boolean; ready: boolean; readiness: Readiness; does: ConnectDoes;
  /** Plain words: how it is paid for, how you sign in, and whether it works here. */
  billingWords: string; method: string; status: string;
};
export type ConnectGroup = { id: ConnectGroupId; title: string; note: string; rows: ConnectRow[] };

export type ConnectStep = { at: 'list' } | { at: 'route'; key: string; entry: KeyState };
export type ConnectAction = { type: 'pick'; key: string } | { type: 'back' } | KeyAction;
export type ConnectView = {
  groups: ConnectGroup[];
  /** The picked row and, for a key route, its key card. Undefined on the list or when the row is gone. */
  chosen?: { row: ConnectRow; key?: ReturnType<typeof keyView> };
};
export type ConnectWords = typeof WORDS;

const ORDER: ConnectGroupId[] = ['plans', 'perUse', 'local', 'server', 'cloud', 'other', 'services'];
const SIGNIN: readonly Via[] = ['browser', 'code', 'paste', 'session', 'cli'];
const KEY: readonly Via[] = ['key', 'plan_key', 'setup_token'];

const fill = (s: string, r: { name: string; company: string }) => s.replace('{name}', r.name).replace('{company}', r.company);

/** Billing decides first: only a subscription row named default is a plan, so an API, free or unknown row never
 *  lands in Plans whatever its `offer` says; nor does a cloud, local or server row, which is always explicit. */
function groupOf(r: ConnectRoute): ConnectGroupId {
  if (r.group === 'services') return 'services';
  if (r.via === 'cloud') return 'cloud';
  if (r.via === 'endpoint') return 'server';
  if (r.via === 'local') return 'local';
  const byDefault = r.offer === 'default' || r.offerPolicy === 'default' || r.offer === true;
  if (r.billing === 'subscription' && byDefault) return 'plans';
  if (r.billing === 'local') return 'local';
  if (r.billing === 'api') return 'perUse';
  return 'other';
}

function rowOf(r: ConnectRoute, w: ConnectWords): ConnectRow {
  const name = r.name || r.provider, company = r.company || name;
  const group = groupOf(r);
  const ready = r.readiness === 'ready';
  const billing = r.via === 'endpoint' ? w['billing.server'] : r.via === 'local' ? w['billing.local'] : w[`billing.${r.billing}`];
  return {
    key: `${r.upstream?.surface ?? ''}/${r.id}`, id: r.id, provider: r.provider,
    ...(r.upstream ? { surface: r.upstream.surface } : {}),
    name, company, via: r.via, billing: r.billing, group,
    offered: group === 'plans' && ready, ready, readiness: r.readiness,
    does: !ready ? 'unavailable' : SIGNIN.includes(r.via) ? 'signin' : KEY.includes(r.via) ? 'key' : 'setup',
    billingWords: fill(billing, { name, company }), method: w[`via.${r.via}`], status: w[`ready.${r.readiness}`],
  };
}

export function connectStep(step: ConnectStep, action: ConnectAction): ConnectStep {
  if (action.type === 'pick') return { at: 'route', key: action.key, entry: 'entry' };
  if (action.type === 'back') return { at: 'list' };
  return step.at === 'route' ? { ...step, entry: keyStep(step.entry, action) } : step;
}

/** Every route, grouped in a fixed order (empty groups left out), rows in the kits' own order. */
export function connectView(routes: readonly ConnectRoute[], step: ConnectStep = { at: 'list' }, words: ConnectWords = WORDS): ConnectView {
  const rows = routes.map((r) => rowOf(r, words));
  const groups = ORDER.map((id) => ({ id, title: words[`connect.${id}`], note: words[`connect.${id}.note`], rows: rows.filter((r) => r.group === id) }))
    .filter((g) => g.rows.length);
  const row = step.at === 'route' ? rows.find((r) => r.key === step.key) : undefined;
  if (!row || step.at !== 'route') return { groups };
  if (row.does !== 'key') return { groups, chosen: { row } };
  const label = words[row.group === 'plans' ? 'key.label.plan' : row.billing === 'api' ? 'key.label.perUse' : 'key.label.other'];
  return { groups, chosen: { row, key: keyView(step.entry, (k) => (k === 'key.label' ? label : words[k])) } };
}

/** What the app does for the picked row, given that row; credentials go straight from the app to its kit. */
export type UseConnectSignIn = Omit<UseSignIn, 'read' | 'start' | 'cancel'> & {
  read: (row: ConnectRow) => ReturnType<UseSignIn['read']>;
  start?: (row: ConnectRow, body?: Parameters<NonNullable<UseSignIn['start']>>[0]) => Promise<unknown>;
  cancel: (row: ConnectRow) => Promise<unknown>;
};

/** `useSignIn`'s options for the chosen sign-in row, or undefined for any other step. Draw the sheet as its own
 *  component keyed by `chosen.row.key` so a new pick starts with fresh sign-in state. */
export function signInFor(view: ConnectView, o: UseConnectSignIn): UseSignIn | undefined {
  const row = view.chosen?.row;
  if (row?.does !== 'signin') return undefined;
  const { read, start, cancel, ...rest } = o;
  return { ...rest, read: () => read(row), cancel: () => cancel(row), ...(start ? { start: (body) => start(row, body) } : {}) };
}
