// Live account rows and the run picker as React hooks over `./accounts.ts`. An app fills an `AccountsSource`
// (or the fuller `ModelPickerSource`) from its own back end — one line per member — and draws the rows its own
// way. A failing room leaves only its row unknown; a mid-refresh `remove()` still drops the row. No openclaw
// adapter yet (pending O14).
import { useCallback, useEffect, useRef, useState } from 'react';
import { accountRows, modelPicker, rowsOf, type Account, type AccountRow, type AccountsSource, type ModelInfo, type Pick, type PickerView, type Room, type RunSelection } from './accounts.ts';

/** What the hooks remove through: an `AccountsSource` plus the back end's own removal, when the app allows it. */
export type AccountHooksSource = AccountsSource & { remove?: (id: string) => Promise<unknown> };

/** What the picker reads: the rows' source plus one model list per account and Auto's own pick. */
export type ModelPickerSource = AccountHooksSource & {
  models: (account: Account) => Promise<readonly ModelInfo[]> | readonly ModelInfo[];
  auto: () => Promise<Pick> | Pick;
};

/** A live `@byokit/accounts` member: `list()`/`models()`/`pick()`/`remove()` fit with one line per member. */
export type MemberAccounts<M> = {
  list: (member: M) => Promise<readonly Account[]>;
  models: (member: M, id: string) => Promise<readonly ModelInfo[]>;
  pick: (member: M, sel: RunSelection, room?: (account: Account, demand: readonly string[]) => Room | Promise<Room>) => Promise<Pick>;
  remove: (member: M, id: string) => Promise<unknown>;
};

/** A live `cliAccounts()` kit: `list()` fits with one line; `remove` when the app lets the person remove one. */
export type CliAccounts = {
  list: () => Promise<readonly Account[]>;
  remove?: (id: string) => Promise<unknown>;
};

const UNKNOWN_ROOM: Room = { left: 'unknown' };
const CLI_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex', pi: 'Pi' };

/** One line per member: the rows' source (with the picker's models and Auto pick) over a live `Accounts`. */
export function accountsSource<M>(accounts: MemberAccounts<M>, member: M, room: (account: Account) => Room | Promise<Room> = () => UNKNOWN_ROOM): ModelPickerSource {
  return {
    accounts: () => accounts.list(member),
    room,
    models: (a) => accounts.models(member, a.id),
    auto: () => accounts.pick(member, { account: 'auto' }, room),
    remove: (id) => accounts.remove(member, id),
  };
}

/** One line: the rows' source over a live `cliAccounts()` kit, with each provider's plain name on its rows. */
export function cliSource(cli: CliAccounts, room: (account: Account) => Room | Promise<Room> = () => UNKNOWN_ROOM): AccountHooksSource {
  const remove = cli.remove;
  return {
    accounts: async () => (await cli.list()).map((c) => ({ ...c, label: CLI_LABEL[c.provider] ?? c.provider })),
    room,
    ...(remove ? { remove: (id: string) => remove(id) } : {}),
  };
}

export type UseAccounts = {
  rows: AccountRow[]; ready: boolean; error: unknown;
  refresh: () => Promise<void>; remove: (id: string) => Promise<void>;
};

/** The rows live: `refresh()` re-reads the source; the caller's removal of an id sticks across refreshes. */
export function useAccounts(source: AccountHooksSource): UseAccounts {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const removed = useRef(new Set<string>());
  const gen = useRef(0);
  const refresh = useCallback(async () => {
    const g = ++gen.current;
    let next: AccountRow[];
    try {
      next = await rowsOf(source, Date.now());
    } catch (e) {
      if (gen.current === g) setError(e);
      return;
    }
    if (gen.current !== g) return;
    setRows(next.filter((r) => !removed.current.has(r.id)));
    setError(undefined);
    setReady(true);
  }, [source]);
  useEffect(() => { void refresh(); }, [refresh]);
  const remove = useCallback(async (id: string) => {
    removed.current.add(id);
    gen.current++;
    setRows((prev) => prev.filter((r) => r.id !== id));
    try { await source.remove?.(id); } catch (e) { removed.current.delete(id); throw e; }
    await refresh();
  }, [source, refresh]);
  return { rows, ready, error, refresh, remove };
}

export type UseModelPicker = {
  rows: AccountRow[]; picker: PickerView | null; selection: RunSelection; ready: boolean; error: unknown;
  select: (sel: RunSelection) => void; refresh: () => Promise<void>; remove: (id: string) => Promise<void>;
};

/** The run picker live: `select()` marks the selection at once (kept across refreshes); `refresh()` re-reads
 *  accounts, models and Auto's pick together. `picker` is null until the first refresh resolves. */
export function useModelPicker(source: ModelPickerSource, initial: RunSelection = { account: 'auto' }): UseModelPicker {
  const [rows, setRows] = useState<AccountRow[]>([]);
  const [picker, setPicker] = useState<PickerView | null>(null);
  const [selection, setSelection] = useState<RunSelection>(initial);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const sel = useRef(initial);
  const cache = useRef<{ accounts: Account[]; models: Record<string, readonly ModelInfo[]>; auto: Pick } | null>(null);
  const removed = useRef(new Set<string>());
  const gen = useRef(0);
  const refresh = useCallback(async () => {
    const g = ++gen.current;
    const now = Date.now();
    let list: Account[];
    try {
      list = [...(await source.accounts())];
    } catch (e) {
      if (gen.current === g) setError(e);
      return;
    }
    const live = list.filter((a) => !removed.current.has(a.id));
    const rooms = new Map<string, Room>();
    for (const a of live) {
      try { rooms.set(a.id, (await source.room(a)) ?? UNKNOWN_ROOM); } catch { rooms.set(a.id, UNKNOWN_ROOM); }
    }
    const models: Record<string, readonly ModelInfo[]> = {};
    for (const a of live) {
      try { models[a.id] = await source.models(a); } catch { models[a.id] = []; }
    }
    let auto: Pick;
    try {
      auto = await source.auto();
    } catch (e) {
      if (gen.current === g) setError(e);
      return;
    }
    if (gen.current !== g) return;
    cache.current = { accounts: live, models, auto };
    setRows(accountRows(live, (a) => rooms.get(a.id) ?? UNKNOWN_ROOM, now).filter((r) => !removed.current.has(r.id)));
    setPicker(modelPicker(live, models, sel.current, auto, now));
    setError(undefined);
    setReady(true);
  }, [source]);
  useEffect(() => { void refresh(); }, [refresh]);
  const select = useCallback((next: RunSelection) => {
    sel.current = next;
    setSelection(next);
    const c = cache.current;
    if (c) setPicker(modelPicker(c.accounts, c.models, next, c.auto, Date.now()));
  }, []);
  const remove = useCallback(async (id: string) => {
    removed.current.add(id);
    gen.current++;
    setRows((prev) => prev.filter((r) => r.id !== id));
    const c = cache.current;
    if (c) {
      const accounts = c.accounts.filter((a) => a.id !== id);
      cache.current = { ...c, accounts };
      setPicker(modelPicker(accounts, c.models, sel.current, c.auto, Date.now()));
    }
    try { await source.remove?.(id); } catch (e) { removed.current.delete(id); throw e; }
    await refresh();
  }, [source, refresh]);
  return { rows, picker, selection, ready, error, select, refresh, remove };
}
