// Several cloud accounts and several managed machines (docs/cloud-kit.md 5.14). Portable: no `node:*`
// import. The roster keeps who the person's accounts are and which machines the app manages, never a
// secret: each account's key lives in the app's own secure key store. It builds on `machine()` unchanged:
// every managed machine is one `Machine` over a view of the roster, pinned to its own account's Provider,
// so waking, sleeping or removing one machine touches no other.
import { MachineError } from './errors.ts';
import { machine } from './machine.ts';
import type { Machine, MachineRecord, MachineRef, MachineStore, Provider } from './types.ts';

/** One cloud account, as the roster keeps it: no secret. `id` is the provider's own account id. */
export type RosterAccount = { id: string; provider: string; label: string }
type Pending = NonNullable<MachineRecord['pending']>;
export type RosterRecord = {
  accounts: RosterAccount[]
  active: string | null
  machines: MachineRef[]                       // identity only, each pinned to its account by `ref.account`
  pending?: Record<string, Pending>            // a create whose answer may be lost, by account (5.2 step 3)
}
export type RosterStore = { load(): Promise<RosterRecord | null>; save(r: RosterRecord): Promise<void> }
/** The app's secure key store (a keychain, SecureStore, `@byokit/secrets`): one key per account id. */
export type KeyStore = {
  get(account: string): Promise<string | null>
  set(account: string, key: string): Promise<void>
  delete(account: string): Promise<void>
}

export interface Roster {
  accounts(): Promise<RosterAccount[]>
  /** The selected account, or null with none. */
  active(): Promise<RosterAccount | null>
  /** Checks the key with the provider, keeps it in the key store, lists the account; the first one becomes active. Adding a known account again replaces its key. */
  add(o: { key: string; label?: string }): Promise<RosterAccount>
  select(account: string): Promise<void>
  /** Forgets the account, its key and its managed machines. The computers themselves stay on the provider. */
  remove(account: string): Promise<void>
  /** This account's own Provider (default: the active one); a separate instance per account. */
  provider(account?: string): Promise<Provider>
  /** The provider's list of this account's existing computers (default: the active account). */
  list(account?: string): Promise<MachineRef[]>
  /** Managed machines, newest last; all of them, or one account's. */
  machines(account?: string): Promise<MachineRef[]>
  /** Starts managing a listed computer; its account must be on the roster. Only its identity is kept. */
  manage(ref: MachineRef): Promise<MachineRef>
  /** Stops managing it; the computer stays on the provider. */
  unmanage(id: string): Promise<void>
  /** The managed machine; every Machine call touches only it. */
  machine(id: string): Promise<Machine>
  /** A Machine with no ref yet on this account (default: active), for create() and adopt(); a saved ref makes it managed. */
  fresh(account?: string): Promise<Machine>
}

export function roster(o: {
  store: RosterStore
  keys: KeyStore
  /** Builds one account's Provider; `key` reads that account's key from the key store when called. */
  provider(a: { label: string; key: () => Promise<string> }): Provider
}): Roster {
  let rec: RosterRecord | null = null;
  let loading: Promise<void> | null = null;
  let saving: Promise<void> = Promise.resolve();
  const providers = new Map<string, Provider>();
  const machines = new Map<string, Machine>();

  const load = (): Promise<void> => {
    loading ??= o.store.load().then((r) => {
      rec = r ?? { accounts: [], active: null, machines: [] };
    });
    return loading;
  };
  // Records are replaced, never edited, and saved in order, so the last change is the last write.
  const commit = (next: RosterRecord): Promise<void> => {
    rec = next;
    saving = saving.catch(() => {}).then(() => o.store.save(next));
    return saving;
  };
  const current = async (): Promise<RosterRecord> => {
    await load();
    return rec as RosterRecord;
  };

  const known = async (account: string): Promise<RosterAccount> => {
    const found = (await current()).accounts.find((a) => a.id === account);
    if (found === undefined) throw new MachineError('wrong-account', `account ${account} is not on the roster`);
    return found;
  };
  const target = async (account?: string): Promise<RosterAccount> => {
    if (account !== undefined) return known(account);
    const { accounts, active } = await current();
    const found = accounts.find((a) => a.id === active);
    if (found === undefined) throw new MachineError('wrong-account', 'no account is selected');
    return found;
  };

  const providerOf = (a: RosterAccount): Provider => {
    let p = providers.get(a.id);
    if (p === undefined) {
      p = o.provider({
        label: a.label,
        key: async () => {
          const key = await o.keys.get(a.id);
          if (key === null) throw new MachineError('unauthorized', `no key is kept for account ${a.id}`);
          return key;
        },
      });
      providers.set(a.id, p);
    }
    return p;
  };

  // A MachineStore over the roster for one machine (or, with no id, one not yet made): `machine()` keeps
  // its one-ref contract and the roster keeps the many. `moved` tells the roster which id the Machine now holds.
  const view = (account: string, id: string | null, moved: (now: string | null, was: string | null) => void): MachineStore => {
    let bound = id;
    return {
      async load() {
        const r = await current();
        const ref = bound === null ? null : r.machines.find((m) => m.id === bound) ?? null;
        const pending = r.pending?.[account];
        return { ref, providerKey: '', ...(pending !== undefined ? { pending } : {}) };
      },
      async save(next) {
        const r = await current();
        const { [account]: _gone, ...others } = r.pending ?? {};
        const pending = next.pending !== undefined ? { ...others, [account]: next.pending } : others;
        const was = bound;
        const ref = next.ref === null ? null : identity(next.ref);
        bound = ref?.id ?? null;
        if (bound !== was) moved(bound, was);
        const kept = r.machines.filter((m) => m.id !== was && m.id !== bound);
        await commit({ ...r, machines: ref === null ? kept : [...kept, ref], pending });
      },
    };
  };
  const make = (a: RosterAccount, id: string | null): Machine => {
    const m: Machine = machine({
      provider: providerOf(a),
      store: view(a.id, id, (now, was) => {
        if (was !== null) machines.delete(was);
        if (now !== null) machines.set(now, m);
      }),
    });
    return m;
  };

  const identity = (r: MachineRef): MachineRef => ({
    provider: r.provider, account: r.account, id: r.id, name: r.name, keepCopies: r.keepCopies,
  });

  return {
    async accounts() {
      return [...(await current()).accounts];
    },

    async active() {
      const { accounts, active } = await current();
      return accounts.find((a) => a.id === active) ?? null;
    },

    async add({ key, label }) {
      const probe = o.provider({ label: label ?? '', key: async () => key });
      const id = await probe.account();
      const entry: RosterAccount = { id, provider: probe.id, label: label ?? probe.label };
      await o.keys.set(id, key);
      providers.delete(id);
      const r = await current();
      await commit({
        ...r,
        accounts: [...r.accounts.filter((a) => a.id !== id), entry],
        active: r.active !== null && r.accounts.some((a) => a.id === r.active) ? r.active : id,
      });
      return entry;
    },

    async select(account) {
      await known(account);
      await commit({ ...(await current()), active: account });
    },

    async remove(account) {
      await known(account);
      const r = await current();
      const { [account]: _gone, ...pending } = r.pending ?? {};
      const accounts = r.accounts.filter((a) => a.id !== account);
      for (const m of r.machines) if (m.account === account) machines.delete(m.id);
      providers.delete(account);
      await o.keys.delete(account);
      await commit({
        accounts,
        active: r.active === account ? accounts[0]?.id ?? null : r.active,
        machines: r.machines.filter((m) => m.account !== account),
        pending,
      });
    },

    async provider(account) {
      return providerOf(await target(account));
    },

    async list(account) {
      const p = providerOf(await target(account));
      if (p.list === undefined) throw new MachineError('unsupported', 'this provider cannot list existing machines');
      return p.list();
    },

    async machines(account) {
      const all = (await current()).machines;
      return account === undefined ? [...all] : all.filter((m) => m.account === account);
    },

    async manage(ref) {
      const a = await known(ref.account);
      if (ref.provider !== a.provider) throw new MachineError('wrong-account', `ref belongs to ${ref.provider}, not ${a.provider}`);
      const r = await current();
      const kept = identity(ref);
      await commit({ ...r, machines: [...r.machines.filter((m) => m.id !== ref.id), kept] });
      return kept;
    },

    async unmanage(id) {
      const r = await current();
      if (!r.machines.some((m) => m.id === id)) throw new MachineError('no-machine', `machine ${id} is not managed`);
      machines.delete(id);
      await commit({ ...r, machines: r.machines.filter((m) => m.id !== id) });
    },

    async machine(id) {
      const ref = (await current()).machines.find((m) => m.id === id);
      if (ref === undefined) throw new MachineError('no-machine', `machine ${id} is not managed`);
      const m = machines.get(id) ?? make(await known(ref.account), id);
      machines.set(id, m);
      return m;
    },

    async fresh(account) {
      return make(await target(account), null);
    },
  };
}
