// fakeProvider(): one FakeMachine behind the Provider shape (docs/cloud-kit.md 13.3).
import { MachineError } from '../errors.ts';
import type {
  AsleepWhy, ExecResult, KeyInfo, MachineRecord, MachineRef, MachineState, MachineStore, Plan,
  Price, Provider, Size, Usage,
} from '../types.ts';
import { FakeMachine, fakeMachine } from './fake-machine.ts';

export type FakeCall = { op: string; args: readonly unknown[] };

export type FakeProviderOptions = {
  id?: 'sandbox-api' | 'ssh-vm';
  account?: string;
  sizes?: readonly Size[];
  prices?: readonly Price[];
  root?: boolean;
  create?: boolean; adopt?: boolean; wake?: boolean; sleep?: boolean; snapshot?: boolean;
  fork?: boolean; remove?: boolean; url?: boolean; usage?: boolean; key?: boolean;
  plan?: boolean; why?: boolean;
};

export type FakeControl = {
  machine: FakeMachine;
  calls: FakeCall[];
  setState(id: string, s: MachineState): void;
  setPlan(p: Plan): void;
  setWhy(w: AsleepWhy | null): void;
  /** At or below 0, `usage` rejects `balance`; null (or above 0) clears it. */
  setBalance(n: number | null): void;
};

const today = (): string => new Date().toISOString().slice(0, 10);

const defaultSizes = (): readonly Size[] => [
  { id: 'small', cpus: 2, memoryGb: 4, diskGb: 12 },
  { id: 'default', cpus: 4, memoryGb: 8, diskGb: 50 },
];

const defaultPrices = (): readonly Price[] => [
  {
    size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
    currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://sandbox.test/prices', checked: today(),
  },
];

/** An in-memory MachineStore for benches. */
export function memoryStore(initial: MachineRecord | null = null): MachineStore {
  let record = initial;
  return {
    load: async () => record,
    save: async (r: MachineRecord) => {
      record = r;
    },
  };
}

export function fakeProvider(o: FakeProviderOptions = {}): Provider & { fake: FakeControl } {
  const id = o.id ?? 'sandbox-api';
  const ssh = id === 'ssh-vm';
  const has = (flag: boolean | undefined, sandboxDefault: boolean, sshDefault: boolean): boolean =>
    flag ?? (ssh ? sshDefault : sandboxDefault);
  const can = {
    create: has(o.create, true, false),
    adopt: has(o.adopt, false, true),
    wake: has(o.wake, true, false),
    sleep: has(o.sleep, true, false),
    snapshot: has(o.snapshot, true, false),
    fork: has(o.fork, true, false),
    remove: has(o.remove, true, false),
    url: has(o.url, true, false),
    usage: has(o.usage, true, false),
    key: has(o.key, true, false),
    plan: has(o.plan, true, true),
    why: has(o.why, true, true),
  };
  const machine = fakeMachine();
  machine.sudo = o.root ?? true;
  const calls: FakeCall[] = [];
  const states = new Map<string, MachineState>();
  let plan: Plan = { inTrial: false, trialEndsAt: null, canStayOn: true, checkoutUrl: null };
  let why: AsleepWhy | null = null;
  let balance: number | null = null;
  let seq = 0;
  const seenKeys = new Map<string, MachineRef>();

  const provider: Provider = {
    id,
    label: 'Fake',
    account: async () => {
      calls.push({ op: 'account', args: [] });
      return o.account ?? 'acct-test';
    },
    sizes: () => (ssh ? [] : (o.sizes ?? defaultSizes())),
    prices: () => o.prices ?? defaultPrices(),
    status: async (m: MachineRef) => {
      calls.push({ op: 'status', args: [m.id] });
      return states.get(m.id) ?? 'on';
    },
    exec: async (m: MachineRef, argv: readonly string[], execOpts: { timeoutMs: number; root?: boolean; input?: Uint8Array }) => {
      calls.push({ op: 'exec', args: [m.id, [...argv], { timeoutMs: execOpts.timeoutMs, root: execOpts.root ?? false }] });
      const r = machine.run(argv, { root: execOpts.root, input: execOpts.input });
      const out: ExecResult = { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
      return out;
    },
    write: async (m: MachineRef, path: string, bytes: Uint8Array, mode: number) => {
      calls.push({ op: 'write', args: [m.id, path, bytes.length, mode] });
      machine.writeFile(path, bytes, mode);
    },
  };

  const full = provider as Provider & {
    create?: Provider['create']; adopt?: Provider['adopt']; wake?: Provider['wake']; sleep?: Provider['sleep'];
    snapshot?: Provider['snapshot']; fork?: Provider['fork']; remove?: Provider['remove'];
    url?: Provider['url']; usage?: Provider['usage']; key?: Provider['key'];
    plan?: Provider['plan']; why?: Provider['why'];
  };

  if (can.create) {
    full.create = async (opts: { name: string; size: string; keepCopies: boolean; idempotencyKey: string }) => {
      calls.push({ op: 'create', args: [{ ...opts }] });
      const known = seenKeys.get(opts.idempotencyKey);
      if (known !== undefined) return known;
      const ref: MachineRef = {
        provider: id, account: o.account ?? 'acct-test',
        id: `sb-${++seq}`, name: opts.name, keepCopies: opts.keepCopies,
      };
      states.set(ref.id, 'on');
      seenKeys.set(opts.idempotencyKey, ref);
      return ref;
    };
  }
  if (can.adopt) {
    full.adopt = async () => {
      calls.push({ op: 'adopt', args: [] });
      return 'SHA256:fake-pinned-key';
    };
  }
  if (can.wake) {
    full.wake = async (m: MachineRef) => {
      calls.push({ op: 'wake', args: [m.id] });
      states.set(m.id, 'on');
    };
  }
  if (can.sleep) {
    full.sleep = async (m: MachineRef) => {
      calls.push({ op: 'sleep', args: [m.id] });
      states.set(m.id, 'asleep');
    };
  }
  if (can.snapshot) {
    full.snapshot = async (m: MachineRef, name: string) => {
      calls.push({ op: 'snapshot', args: [m.id, name] });
      return { name: `byokit-${m.name}-${name}` };
    };
  }
  if (can.fork) {
    full.fork = async (m: MachineRef, opts: { name: string; size: string; idempotencyKey: string }) => {
      calls.push({ op: 'fork', args: [m.id, { ...opts }] });
      const ref: MachineRef = {
        provider: id, account: o.account ?? 'acct-test',
        id: `sb-${++seq}`, name: opts.name, keepCopies: m.keepCopies,
      };
      states.set(ref.id, 'on');
      return ref;
    };
  }
  if (can.remove) {
    full.remove = async (m: MachineRef, confirm: string) => {
      calls.push({ op: 'remove', args: [m.id, confirm] });
      states.delete(m.id);
    };
  }
  if (can.url) {
    full.url = async (m: MachineRef, port: number) => {
      calls.push({ op: 'url', args: [m.id, port] });
      return `https://${m.id}-${port}.sandbox.test`;
    };
  }
  if (can.usage) {
    full.usage = async (m: MachineRef, since: string) => {
      calls.push({ op: 'usage', args: [m.id, since] });
      if (balance !== null && balance <= 0) throw new MachineError('balance', 'the account balance is spent');
      const to = new Date().toISOString();
      const hours = Math.max(1, (Date.parse(to) - Date.parse(since)) / 3_600_000);
      const u: Usage = { from: since, to, hours, amount: 5, currency: 'USD' };
      return u;
    };
  }
  if (can.key) {
    full.key = async () => {
      calls.push({ op: 'key', args: [] });
      const k: KeyInfo = { expires: null, scopes: [] };
      return k;
    };
  }
  if (can.plan) {
    full.plan = async () => {
      calls.push({ op: 'plan', args: [] });
      return { ...plan };
    };
  }
  if (can.why) {
    full.why = async (m: MachineRef) => {
      calls.push({ op: 'why', args: [m.id] });
      return why;
    };
  }

  const fake: FakeControl = {
    machine,
    calls,
    setState: (mid: string, s: MachineState) => {
      states.set(mid, s);
    },
    setPlan: (p: Plan) => {
      plan = { ...p };
    },
    setWhy: (w: AsleepWhy | null) => {
      why = w;
    },
    setBalance: (n: number | null) => {
      balance = n;
    },
  };
  return Object.assign(provider, { fake });
}
