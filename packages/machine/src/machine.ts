// machine() (docs/machine-kit.md section 5). M1 builds the 5.1 checks of every method,
// 5.2-5.5 and 5.7; install, update, host, logs and deliver run their checks, then throw
// 'not built: M3'.
import { MachineError } from './errors.ts';
import { balanceCost, dateOf, enteredCost, monthStartIso, usageCost } from './cost.ts';
import { checkRecipe } from './recipe.ts';
import type {
  AsleepWhy, HostRecipe, Machine, MachineRecord, MachineRef, MachineStore, Plan, Provider,
} from './types.ts';

const EXEC_TIMEOUT_MS = 30_000;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DELIVER_LIMIT = 64 * 1024;

const randomBase36 = (n: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
};

export function machine(o: { provider: Provider; store: MachineStore }): Machine {
  let loading: Promise<void> | null = null;
  let record: MachineRecord | null = null;

  const load = (): Promise<void> => {
    loading ??= o.store.load().then((r) => {
      record = r;
    });
    return loading;
  };
  const current = (): MachineRef | null => record?.ref ?? null;

  const save = async (next: MachineRef | null): Promise<void> => {
    const saved: MachineRecord = { ...(record ?? { providerKey: '' }), ref: next };
    await o.store.save(saved);
    record = saved;
  };

  const checkAccount = async (r: MachineRef | null): Promise<void> => {
    if (r !== null && (r.provider !== o.provider.id || r.account !== (await o.provider.account()))) {
      throw new MachineError('wrong-account', `stored ref belongs to another account than ${o.provider.id}`);
    }
  };

  // 5.1 check order: load; wrong-account; no-machine. The kit never uses, repairs or
  // overwrites a mismatched ref; the app decides.
  const need = async (): Promise<MachineRef> => {
    await load();
    const r = current();
    await checkAccount(r);
    if (r === null) throw new MachineError('no-machine', 'no machine in the store');
    return r;
  };

  const checkPort = (port: number): void => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MachineError('bad-recipe', `port: must be an integer 1-65535, got ${JSON.stringify(port)}`);
    }
  };

  // 8.2 without a recipe: probe for a system unit; exit 0 means a system unit.
  const stopUnit = async (r: MachineRef): Promise<void> => {
    const unit = `byokit-${r.name}.service`;
    let system = false;
    try {
      system = (await o.provider.exec(r, ['test', '-e', `/etc/systemd/system/${unit}`], { timeoutMs: EXEC_TIMEOUT_MS })).code === 0;
    } catch {
      system = false;
    }
    try {
      if (system) await o.provider.exec(r, ['systemctl', 'stop', unit], { timeoutMs: EXEC_TIMEOUT_MS, root: true });
      else await o.provider.exec(r, ['systemctl', '--user', 'stop', unit], { timeoutMs: EXEC_TIMEOUT_MS });
    } catch {
      // A missing unit is ignored, so the host gets SIGTERM and flushes whether or not
      // the provider's stop is a clean OS shutdown (G10).
    }
  };

  const self: Machine = {
    get ref(): MachineRef | null {
      return current();
    },

    async create({ name, size, keepCopies }): Promise<MachineRef> {
      await load();
      const existing = current();
      await checkAccount(existing);
      if (existing !== null) throw new MachineError('exists', 'the store already holds a machine');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
        throw new MachineError('bad-recipe', `name: must match ^[a-z][a-z0-9-]{0,31}$, got ${JSON.stringify(name)}`);
      }
      const sizes = o.provider.sizes();
      if (sizes.length > 0 && !sizes.some((s) => s.id === size)) {
        throw new MachineError('bad-recipe', `size: must be one of ${sizes.map((s) => s.id).join(', ')}, got ${JSON.stringify(size)}`);
      }
      if (o.provider.create !== undefined) {
        const idempotencyKey = `byokit-${name}-${randomBase36(16)}`;
        for (let attempt = 0; ; attempt++) {
          try {
            const created = await o.provider.create({ name, size, keepCopies, idempotencyKey });
            await save(created);
            return created;
          } catch (e) {
            // The same key on every retry; unreachable only.
            if ((e as { code?: string }).code === 'unreachable' && attempt < 3) continue;
            throw e;
          }
        }
      }
      // Provider without create (SSH VM): adopt the machine that already exists (5.2 step 4).
      if (keepCopies !== false) throw new MachineError('bad-recipe', 'keepCopies: must be false when the provider has no create');
      if (o.provider.adopt === undefined) throw new MachineError('unsupported', 'this provider cannot adopt a machine');
      const id = await o.provider.adopt();
      const adopted: MachineRef = { provider: o.provider.id, account: await o.provider.account(), id, name, keepCopies: false };
      const s = await o.provider.status(adopted);
      if (s !== 'on') {
        if (s === 'host-key-changed') throw new MachineError('host-key', 'the pinned host key no longer matches');
        throw new MachineError('unreachable', `adopted machine is ${s}, not on`);
      }
      await save(adopted);
      return adopted;
    },

    async state() {
      const r = await need();
      return o.provider.status(r);
    },

    async wake(): Promise<void> {
      const r = await need();
      if (o.provider.wake === undefined) throw new MachineError('unsupported', 'this provider cannot wake a machine');
      if ((await o.provider.status(r)) === 'on') return;
      await o.provider.wake(r);
    },

    async sleep(): Promise<void> {
      const r = await need();
      if (o.provider.sleep === undefined) throw new MachineError('unsupported', 'this provider cannot sleep a machine');
      if (r.keepCopies === false) {
        throw new MachineError('unsupported', 'a stop without copies erases the disk, so the kit never sleeps such a machine');
      }
      await stopUnit(r);
      await o.provider.sleep(r);
    },

    async install(r: HostRecipe, _onLine?: (line: string) => void): Promise<void> {
      const ref = await need();
      checkRecipe(r, ref.name);
      void _onLine;
      throw new Error('not built: M3');
    },

    async update(r: HostRecipe): Promise<void> {
      const ref = await need();
      checkRecipe(r, ref.name);
      throw new Error('not built: M3');
    },

    async host() {
      await need();
      throw new Error('not built: M3');
    },

    async logs(lines: number) {
      await need();
      if (!Number.isInteger(lines) || lines < 1) {
        throw new MachineError('bad-recipe', `lines: must be an integer >= 1, got ${JSON.stringify(lines)}`);
      }
      throw new Error('not built: M3');
    },

    async url(port: number) {
      const r = await need();
      checkPort(port);
      return o.provider.url?.(r, port) ?? null;
    },

    async cost() {
      const r = await need();
      const today = dateOf(new Date());
      if (o.provider.usage !== undefined) {
        let u;
        try {
          u = await o.provider.usage(r, monthStartIso(new Date()));
        } catch (e) {
          if ((e as { code?: string }).code === 'balance') return balanceCost(o.provider.prices(), { label: o.provider.label, today });
          throw e;
        }
        return usageCost(u, o.provider.prices(), { label: o.provider.label, today });
      }
      const entered = enteredCost(record?.monthlyEntered, o.provider.prices(), { label: o.provider.label, today });
      if (entered === null) throw new MachineError('unsupported', 'no usage and no entered price for this machine');
      return entered;
    },

    async remove(confirm: string): Promise<void> {
      const r = await need();
      if (confirm !== r.id) throw new MachineError('confirm', 'confirm must equal the machine id');
      if (o.provider.remove === undefined) throw new MachineError('unsupported', 'this provider cannot remove a machine');
      await o.provider.remove(r, confirm);
      await save(null);
    },

    async plan(): Promise<Plan | null> {
      await load();
      await checkAccount(current());
      return o.provider.plan?.() ?? null;
    },

    async why(): Promise<AsleepWhy | null> {
      const r = await need();
      const s = await o.provider.status(r);
      if (s !== 'asleep') return null;
      if (o.provider.why !== undefined) {
        try {
          const w = await o.provider.why(r);
          if (w !== null) return w;
        } catch {
          // Skip the rule; why() itself rejects only when state() does.
        }
      }
      if (o.provider.usage !== undefined) {
        try {
          await o.provider.usage(r, monthStartIso(new Date()));
        } catch (e) {
          if ((e as { code?: string }).code === 'balance') return 'out-of-credit';
        }
      }
      if (o.provider.plan !== undefined) {
        try {
          const p = await o.provider.plan();
          if (!p.canStayOn) return 'trial-limit';
        } catch {
          // Skip the rule.
        }
      }
      return 'provider';
    },

    async deliver(r: HostRecipe, file: string, bytes: Uint8Array): Promise<void> {
      const ref = await need();
      checkRecipe(r, ref.name);
      if (!FILE_NAME.test(file)) {
        throw new MachineError('bad-recipe', `file: must match ^[a-z0-9][a-z0-9._-]{0,63}$, got ${JSON.stringify(file)}`);
      }
      if (bytes.length > DELIVER_LIMIT) {
        throw new MachineError('bad-recipe', `bytes: at most ${DELIVER_LIMIT} bytes, got ${bytes.length}`);
      }
      throw new Error('not built: M3');
    },
  };

  return self;
}
