// Your cloud computers as a person sees them: the list, what each one is doing, its newest copy, what it costs, and
// what the host answered when you asked it to do something. Framework-free and portable: the view reads only the
// fields it names, and the cloud kit's `Provider` fits `CloudProvider` as it is (D3), so nothing here imports a kit.
import WORDS from './words.json' with { type: 'json' };
import { store, type Store } from './follow.ts';

/** One machine's state, restated from the cloud kit's `MachineState`. */
export type MachineState =
  | 'creating' | 'on' | 'asleep' | 'waking' | 'stopping'
  | 'unknown' | 'failed' | 'gone' | 'host-key-changed';

/** A saved copy of a machine. */
export type CloudCopy = { id: string; at: string };

/** What a machine has cost since a reading began, restated from the cloud kit's `Usage`. */
export type CloudUsage = { from: string; to: string; hours: number; amount: number; currency: string };

/** What a machine costs: the month's figure, what it has cost so far, and the money it is in. */
export type CloudCost = { perMonth?: number; spent?: number; currency: string };

/**
 * A machine as the provider reports it, restated structurally: a kit that adds a subdomain, a state or a newest copy
 * fits this without a change here. Only the named fields are read, so nothing else on a ref reaches a row.
 */
export type CloudRef = {
  id: string; name: string; account?: string;
  /** The address it answers on, when the provider gives one. */
  subdomain?: string;
  /** What it is doing, when the provider reports it with the ref. */
  state?: MachineState;
  /** Its newest copy, when the provider reports one. */
  snapshot?: CloudCopy | null;
};

/** One machine as the view draws it. */
export type CloudMachine = CloudRef & { state: MachineState; cost?: CloudCost | null };

/** What the person can ask the host to do to a machine. */
export type MachineAction = 'wake' | 'sleep';

/** The list as the app's back end reports it. */
export type CloudState = {
  /** 'loading' until the first list arrives, 'ready' after it, 'failed' when the host could not answer. */
  phase: 'loading' | 'ready' | 'failed';
  /** The machines the host reported, in the host's own order. */
  machines: CloudMachine[];
  /** The actions the host offers, when it can do them. */
  actions: readonly MachineAction[];
  /** The failure, as the host reported it. */
  error?: unknown;
  /** What the person typed to search by. */
  search: string;
  /** The machine the person picked, when they picked one. */
  selected?: string;
  /** The action the host is doing now, and the machine it is doing it to. */
  pending?: { id: string; action: MachineAction };
  /** The host's answer to the last action. */
  ack?: { id: string; ok: boolean; words?: string };
};

/** One thing that can happen to the list. */
export type CloudAction =
  | { type: 'loading' }
  | { type: 'loaded'; machines: readonly CloudMachine[]; actions?: readonly MachineAction[] }
  | { type: 'failed'; error: unknown }
  | { type: 'search'; text: string }
  | { type: 'select'; id: string | null }
  | { type: 'asked'; id: string; action: MachineAction }
  | { type: 'acked'; id: string; ok: boolean; words?: string };

export const CLOUD_EMPTY: CloudState = { phase: 'loading', machines: [], actions: [], search: '' };

/** The list's own history: a read, a search, a pick, an action asked for and the host's answer to it. */
export function cloudStep(s: CloudState, a: CloudAction): CloudState {
  switch (a.type) {
    case 'loading': return s.phase === 'loading' && s.machines.length === 0 ? s : { ...s, phase: 'loading', error: undefined };
    case 'loaded': return { ...s, phase: 'ready', machines: [...a.machines], actions: a.actions ?? s.actions, error: undefined };
    case 'failed': return { ...s, phase: 'failed', error: a.error };
    case 'search': return s.search === a.text ? s : { ...s, search: a.text };
    case 'select': return s.selected === (a.id ?? undefined) ? s : { ...s, selected: a.id ?? undefined };
    case 'asked': return { ...s, pending: { id: a.id, action: a.action }, ack: undefined };
    case 'acked': return { ...s, pending: undefined, ack: { id: a.id, ok: a.ok, ...(a.words ? { words: a.words } : {}) } };
  }
}

/** One machine as a row: what it is doing, its newest copy, what it costs and what the host said. */
export type CloudRow = {
  id: string;
  /** The machine's own name, as the person named it. */
  title: string;
  /** The address it answers on, when the provider gives one. */
  address?: string;
  /** The cloud account it belongs to, when the app keeps more than one. */
  account?: string;
  /** What the machine is doing. */
  state: MachineState;
  /** What the machine is doing, in plain words ('Awake', 'Waking up…'). */
  stateWords: string;
  /** Its newest copy, in plain words ('Saved copy 2 hours ago'), when the app knows one. */
  copy?: string;
  /** What it costs, in plain words ('About $5.00 a month'), when the app knows. */
  cost?: string;
  /** True for the machine the person picked. */
  selected: boolean;
  /** What the person can do right now; absent when nothing helps. */
  action?: MachineAction;
  /** That action's own label, in plain words ('Wake it'). */
  actionWords?: string;
  /** True while the host is doing that action. */
  pending: boolean;
  /** What the host said about the last action, in plain words. */
  ack?: string;
};

/** What the list draws: the rows to show, the line above them, and how the read went. */
export type CloudView = {
  /** The rows to draw, in the host's order, filtered by the search. */
  rows: CloudRow[];
  /** The line above the list; empty when the rows say it all. */
  headline: string;
  /** The machine the person picked, when they picked one. */
  selected?: string;
  /** True while the host is reading the list. */
  loading: boolean;
  /** True when the list is read and there is nothing in it to show. */
  empty: boolean;
  /** The host's own words when the list could not be read. */
  error?: string;
};

/** A sentence with its `{slot}` filled. */
const fill = (text: string, vars: Record<string, string>): string =>
  text.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);

const STATE_WORDS: Record<MachineState, string> = {
  creating: WORDS['cloud.state.creating'], on: WORDS['cloud.state.on'], asleep: WORDS['cloud.state.asleep'],
  waking: WORDS['cloud.state.waking'], stopping: WORDS['cloud.state.stopping'], unknown: WORDS['cloud.state.unknown'],
  failed: WORDS['cloud.state.failed'], gone: WORDS['cloud.state.gone'], 'host-key-changed': WORDS['cloud.state.host-key-changed'],
};

const ACTION_WORDS: Record<MachineAction, string> = { wake: WORDS['cloud.action.wake'], sleep: WORDS['cloud.action.sleep'] };
const PENDING_WORDS: Record<MachineAction, string> = { wake: WORDS['cloud.pending.wake'], sleep: WORDS['cloud.pending.sleep'] };

/** The amount as money, in the money it is in. */
const money = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};

/** How long ago a copy was, in plain words; a copy older than a month shows its date instead. */
export function agoWords(at: string | number, now: number): string {
  const then = typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60_000));
  if (minutes < 1) return WORDS['cloud.age.now'];
  if (minutes < 60) return fill(WORDS[minutes === 1 ? 'cloud.age.minute' : 'cloud.age.minutes'], { n: `${minutes}` });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fill(WORDS[hours === 1 ? 'cloud.age.hour' : 'cloud.age.hours'], { n: `${hours}` });
  const days = Math.round(hours / 24);
  if (days <= 30) return fill(WORDS[days === 1 ? 'cloud.age.day' : 'cloud.age.days'], { n: `${days}` });
  const d = new Date(then);
  return `${d.toLocaleDateString([], { month: 'long' })} ${d.getDate()} ${d.getFullYear()}`;
}

/** The newest saved copy in plain words: `Saved copy just now` for a fresh one, `Saved copy 2 hours ago` for an older one. */
export const copyWords = (copy: CloudCopy, now: number): string => {
  const when = agoWords(copy.at, now);
  return when === WORDS['cloud.age.now'] ? WORDS['cloud.copy.now'] : fill(WORDS['cloud.copy.at'], { when });
};

/** What a machine costs, in plain words; nothing when the app knows no figure. */
export const costWords = (cost: CloudCost | null | undefined): string | undefined => {
  if (!cost) return undefined;
  const monthly = typeof cost.perMonth === 'number' ? money(cost.perMonth, cost.currency) : undefined;
  const spent = typeof cost.spent === 'number' ? money(cost.spent, cost.currency) : undefined;
  if (monthly !== undefined && spent !== undefined) return fill(WORDS['cloud.cost.both'], { spent, monthly });
  if (monthly !== undefined) return fill(WORDS['cloud.cost.month'], { amount: monthly });
  if (spent !== undefined) return fill(WORDS['cloud.cost.spent'], { amount: spent });
  return undefined;
};

/** What the person can do with a machine right now: wake an asleep one, put an awake one to sleep. */
export const machineAction = (state: MachineState, actions: readonly MachineAction[]): MachineAction | undefined => {
  if (state === 'asleep' && actions.includes('wake')) return 'wake';
  if (state === 'on' && actions.includes('sleep')) return 'sleep';
  return undefined;
};

/** The machine a search matches: its name, the address it answers on, or the account it belongs to. */
const matches = (m: CloudMachine, search: string): boolean => {
  const q = search.trim().toLowerCase();
  if (q === '') return true;
  return [m.name, m.subdomain, m.account].some((v) => typeof v === 'string' && v.toLowerCase().includes(q));
};

/** What the host said about an action: its own words when it has them, else the plain default. */
const ackWords = (ack: { ok: boolean; words?: string }, action: MachineAction | undefined): string => {
  if (ack.words !== undefined && ack.words !== '') return ack.words;
  if (!ack.ok) return WORDS['cloud.ack.failed'];
  if (action === 'wake') return WORDS['cloud.ack.wake'];
  if (action === 'sleep') return WORDS['cloud.ack.sleep'];
  return WORDS['cloud.ack.done'];
};

const rowOf = (m: CloudMachine, s: CloudState, now: number): CloudRow => {
  const pending = s.pending?.id === m.id ? s.pending.action : undefined;
  const action = pending ?? machineAction(m.state, s.actions);
  const ack = s.ack?.id === m.id ? s.ack : undefined;
  const cost = costWords(m.cost);
  return {
    id: m.id,
    title: m.name,
    ...(m.subdomain ? { address: m.subdomain } : {}),
    ...(m.account ? { account: m.account } : {}),
    state: m.state,
    stateWords: pending === undefined ? STATE_WORDS[m.state] : PENDING_WORDS[pending],
    ...(m.snapshot ? { copy: copyWords(m.snapshot, now) } : {}),
    ...(cost ? { cost } : {}),
    selected: s.selected === m.id,
    ...(action ? { action, actionWords: ACTION_WORDS[action] } : {}),
    pending: pending !== undefined,
    ...(ack ? { ack: ackWords(ack, action) } : {}),
  };
};

/**
 * The list to draw: the rows the search keeps, the line above them, and how the read went. `words` is the app's
 * own sentence for a failure (the cloud kit's `errorWords` fits); without one the host's own words are shown.
 */
export function cloudView(s: CloudState, o: { now?: number; words?: (e: unknown) => string } = {}): CloudView {
  const now = o.now ?? Date.now();
  const rows = s.machines.filter((m) => matches(m, s.search)).map((m) => rowOf(m, s, now));
  const failed = s.phase === 'failed';
  const headline = failed ? WORDS['cloud.failed']
    : s.phase === 'loading' && rows.length === 0 ? WORDS['cloud.loading']
    : s.machines.length === 0 ? WORDS['cloud.empty']
    : rows.length === 0 ? fill(WORDS['cloud.empty.search'], { text: s.search.trim() })
    : '';
  const error = s.error === undefined ? undefined
    : o.words !== undefined ? o.words(s.error)
    : typeof s.error === 'string' ? s.error : s.error instanceof Error ? s.error.message : '';
  return {
    rows,
    headline,
    ...(s.selected !== undefined ? { selected: s.selected } : {}),
    loading: s.phase === 'loading',
    empty: s.phase === 'ready' && rows.length === 0,
    ...(error !== undefined && error !== '' ? { error } : {}),
  };
}

/** What the store needs from the app's back end: the machines, and the host's own answer to an action. */
export type CloudSource = {
  /** The machines the host reports, with what it knows about each. */
  list(): Promise<readonly CloudMachine[]>;
  /** The actions the host offers, when it can do them. */
  actions?: readonly MachineAction[];
  /** The host does the action and answers; `words` are its own sentence for the answer. */
  act?(id: string, action: MachineAction): Promise<{ ok: boolean; words?: string }>;
};

export type CloudStore = Store<CloudState> & {
  /** Read the list again from the host. */
  refresh(): void;
  /** Pick a machine, or pick none. */
  select(id: string | null): void;
  /** Search the list by name, address or account. */
  search(text: string): void;
  /** Ask the host to do something to a machine; the row says so until the host answers. */
  act(id: string, action: MachineAction): void;
};

/**
 * The list, live: it is read when the first listener arrives and again on `refresh()`, and the host's answer to an
 * action lands in the row that asked for it. The newest read wins, so a slow read never overwrites a newer one.
 */
export function cloudStore(source: CloudSource): CloudStore {
  let reads = 0;
  let asks = 0;
  const made = store<CloudState>(CLOUD_EMPTY, () => {
    void load();
    return () => {};
  });
  const apply = (a: CloudAction) => made.set(cloudStep(made.get(), a));
  const load = async (): Promise<void> => {
    const r = ++reads;
    apply({ type: 'loading' });
    try {
      const machines = await source.list();
      if (r !== reads) return;
      apply({ type: 'loaded', machines, actions: source.actions ?? [] });
    } catch (e) {
      if (r !== reads) return;
      apply({ type: 'failed', error: e });
    }
  };
  return {
    get: made.get,
    subscribe: made.subscribe,
    refresh: () => { void load(); },
    select: (id) => apply({ type: 'select', id }),
    search: (text) => apply({ type: 'search', text }),
    act: (id, action) => {
      const a = ++asks;
      apply({ type: 'asked', id, action });
      void (async () => {
        try {
          const ack = await source.act?.(id, action);
          if (a !== asks) return;
          apply({ type: 'acked', id, ok: ack?.ok === true, ...(ack?.words ? { words: ack.words } : {}) });
        } catch (e) {
          if (a !== asks) return;
          apply({ type: 'acked', id, ok: false, words: e instanceof Error ? e.message : String(e) });
        }
      })();
    },
  };
}

// ---- The cloud kit's own provider, as this view reads it -----------------------------------------------

/**
 * The parts of the cloud kit's `Provider` this view reads, restated structurally: the kit's own provider fits as it
 * is, and a kit that lists more machines (a roster of accounts, a machine with its own subdomain and newest copy)
 * fits too.
 */
export type CloudProvider = {
  list?(): Promise<readonly CloudRef[]>;
  status(ref: CloudRef): Promise<MachineState>;
  usage?(ref: CloudRef, since: string): Promise<CloudUsage | undefined>;
  snapshots?(ref: CloudRef): Promise<readonly CloudCopy[]>;
  wake?(ref: CloudRef): Promise<void>;
  sleep?(ref: CloudRef): Promise<void>;
};

/**
 * The source the view needs, built from a cloud provider: the machines it lists with what it knows about each
 * (its state, its newest copy, what it has cost), and the actions it can do. `since` is where the spend reading
 * starts (the first of the month, say), `monthly` the month's figure for a machine, `known` the app's own record
 * of a machine the provider lists (the name it gave it, which the copies are named after, and the address it
 * answers on), and `words` the host's plain sentence for a failure.
 */
export function cloudSource(provider: CloudProvider, o: {
  since?: string;
  monthly?: (ref: CloudRef) => CloudCost | undefined | Promise<CloudCost | undefined>;
  known?: (ref: CloudRef) => CloudRef | undefined;
  words?: (e: unknown) => string;
} = {}): CloudSource {
  const refs = new Map<string, CloudRef>();
  const wordsOf = (e: unknown): string => o.words !== undefined ? o.words(e)
    : e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const list = async (): Promise<CloudMachine[]> => {
    const found = await provider.list?.();
    if (found === undefined) throw new Error('this provider cannot list its cloud computers');
    refs.clear();
    const machines: CloudMachine[] = [];
    for (const r of found) {
      // The app's own record of the machine wins: the name it gave it is the one its copies are named after.
      const known = o.known?.(r);
      const ref: CloudRef = known === undefined ? r : { ...r, ...known };
      refs.set(ref.id, ref);
      let state = ref.state;
      if (state === undefined) {
        try { state = await provider.status(ref); } catch { state = 'unknown'; }
      }
      let copy = ref.snapshot ?? null;
      if (copy === null && provider.snapshots !== undefined) {
        try { copy = (await provider.snapshots(ref))[0] ?? null; } catch { copy = null; }
      }
      let cost: CloudCost | null = null;
      if (o.since !== undefined && provider.usage !== undefined) {
        try {
          const usage = await provider.usage(ref, o.since);
          if (usage !== undefined) cost = { spent: usage.amount, currency: usage.currency };
        } catch { cost = null; }
      }
      const monthly = await o.monthly?.(ref);
      if (monthly !== undefined) cost = { ...(cost ?? {}), ...monthly };
      machines.push({ ...ref, state, snapshot: copy, cost });
    }
    return machines;
  };
  const act = async (id: string, action: MachineAction): Promise<{ ok: boolean; words?: string }> => {
    const ref = refs.get(id);
    if (ref === undefined) return { ok: false, words: 'That cloud computer is not in the list any more.' };
    try {
      if (action === 'wake') await provider.wake?.(ref);
      else await provider.sleep?.(ref);
      return { ok: true };
    } catch (e) {
      return { ok: false, words: wordsOf(e) };
    }
  };
  return {
    list,
    actions: [...(provider.wake !== undefined ? ['wake' as const] : []), ...(provider.sleep !== undefined ? ['sleep' as const] : [])],
    act,
  };
}
