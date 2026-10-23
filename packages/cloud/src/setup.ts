// setup(): one existing-computer connect, or one new computer, as a step stream (docs/cloud-kit.md 4.5, 5.11).
// Each step is emitted after its real result, never from timers or log prose.
import { isAdoptionInstallFailure, MachineError } from './errors.ts';
import { machine } from './machine.ts';
import { readOutbox, type PairContext, type PairReceipt } from './enrol.ts';
import { checkRecipe } from './recipe.ts';
import { LISTEN_SHELL } from './unit.ts';
import { errorKey } from './words.ts';
import { via, type SshPins, type SshRoute, type SshTarget, type SshTransport } from './ssh-vm.ts';
import type { HostRecipe, MachineRef, MachineStore, Provider } from './types.ts';
import type { WordKey } from './words.ts';

export type SetupStepName = 'checking-access' | 'listing' | 'creating' | 'inspecting' | 'installing' | 'securing' | 'pairing';

export type SetupStep =
  | { step: 'checking-access'; account: string }
  | { step: 'listing'; machines: MachineRef[] }
  | { step: 'creating'; ref: MachineRef }
  | { step: 'inspecting'; ref: MachineRef }
  | { step: 'installing'; ref: MachineRef }
  | { step: 'securing'; route: SshRoute }
  | { step: 'pairing'; receipt?: PairReceipt }
  | { step: 'ready'; ref: MachineRef }
  | { step: 'failed'; at: SetupStepName; cause: WordKey; retryable: boolean };

/** Failures a repeated setup() may pass without new input (5.11). */
const RETRYABLE = new Set(['unreachable', 'timeout', 'provider', 'balance', 'busy']);

/** How long a new machine has to come on, polled as Boat's wake polls (6.1). */
const CREATE_WAIT_MS = 5 * 60 * 1000;
const CREATE_POLL_MS = 2000;

/** Connect an existing computer the person picks, or rent a new one on their account (5.11). */
type Target =
  | { pick: (listed: MachineRef[]) => MachineRef; confirmId: string; create?: never }
  | { create: { size: string; keepCopies: boolean }; pick?: never; confirmId?: never };

export async function* setup(o: Target & {
  provider: Provider;
  store: MachineStore;
  recipe: HostRecipe;
  onLine?: (line: string) => void;
  // The SSH route to the app port on the machine's loopback (9.1); absent skips securing. `publicKey` is the device's
  // login key for `provider.sshAccess`; without it, `target` and the fingerprint `pins` holds.
  address?: {
    port: number; transport: SshTransport; publicKey?: string;
    target?: { host: string; port?: number; user: string }; pins?: Pick<SshPins, 'load'>;
  };
  pair?: (ref: MachineRef, ctx: PairContext) => Promise<PairReceipt | void>;  // the app's Pair-ready gate; absent skips pairing
  replaceOwner?: boolean;                          // 5.12: only after the person confirms an `error.ownerEnrolled` failure
}): AsyncGenerator<SetupStep> {
  const replaceOwner = o.replaceOwner === true;
  const m = machine({ provider: o.provider, store: o.store });
  const fail = (at: SetupStepName, e: unknown): SetupStep =>
    e instanceof MachineError
      ? { step: 'failed', at, cause: errorKey(e), retryable: RETRYABLE.has(e.code) }
      : { step: 'failed', at, cause: 'error.app', retryable: false };
  const saved = (selected: MachineRef): MachineRef | null => {
    const r = m.ref;
    return r !== null && r.id === selected.id && r.name === o.recipe.name ? r : null;
  };
  // A new machine is named after the recipe, so a retry finds it saved and resumes instead of renting another.
  const created = async (c: { size: string; keepCopies: boolean }): Promise<MachineRef> => {
    checkRecipe(o.recipe, o.recipe.name); // before the rental: a recipe the kit refuses never bills
    let ref: MachineRef;
    try {
      ref = await m.create({ name: o.recipe.name, size: c.size, keepCopies: c.keepCopies });
    } catch (e) {
      const resumed = m.ref;
      if (!(e instanceof MachineError && e.code === 'exists') || resumed === null || resumed.name !== o.recipe.name) throw e;
      ref = resumed;
    }
    // Boat's create resolves before the machine is on (6.1); a saved one may have gone to sleep since.
    for (const until = Date.now() + CREATE_WAIT_MS; ;) {
      const s = await m.state();
      if (s === 'on') return ref;
      if (s === 'failed' || s === 'gone') throw new MachineError('provider', `the new cloud computer is ${s}`);
      if (s === 'host-key-changed') throw new MachineError('host-key', 'the pinned host key no longer matches');
      if (s === 'asleep') {
        await m.wake();
        continue;
      }
      if (Date.now() >= until) throw new MachineError('timeout', `the new cloud computer is still ${s}`);
      await new Promise<void>((resolve) => setTimeout(resolve, CREATE_POLL_MS));
    }
  };
  let account: string;
  try {
    account = await o.provider.account();
  } catch (e) {
    yield fail('checking-access', e);
    return;
  }
  yield { step: 'checking-access', account };
  if (o.create !== undefined) {
    let ref: MachineRef;
    try {
      ref = await created(o.create);
    } catch (e) {
      yield fail('creating', e);
      return;
    }
    yield { step: 'creating', ref };
    try {
      await m.install(o.recipe, o.onLine);
    } catch (e) {
      yield fail('installing', e);
      return;
    }
    yield { step: 'installing', ref };
    yield* secureAndPair(ref);
    return;
  }
  if (o.provider.list === undefined) {
    yield { step: 'failed', at: 'listing', cause: 'error.app', retryable: false };
    return;
  }
  let listed: MachineRef[];
  try {
    listed = await o.provider.list();
  } catch (e) {
    yield fail('listing', e);
    return;
  }
  yield { step: 'listing', machines: listed };
  let selected: MachineRef;
  try {
    selected = o.pick(listed);
  } catch (e) {
    yield fail('listing', e);
    return;
  }
  // adopt() tags install failures so resumed state is irrelevant.
  let ref: MachineRef;
  try {
    ref = await m.adopt(selected, { confirmId: o.confirmId, recipe: o.recipe, onLine: o.onLine, replaceOwner });
    yield { step: 'inspecting', ref };
    yield { step: 'installing', ref };
  } catch (e) {
    if (isAdoptionInstallFailure(e)) {
      yield fail('installing', e);
      return;
    }
    const code = e instanceof MachineError ? e.code : undefined;
    const resumed = saved(selected);
    if (code === 'exists' && resumed !== null) {
      ref = resumed;
      yield { step: 'inspecting', ref };
      try {
        await m.install(o.recipe, o.onLine);
      } catch (e2) {
        yield fail('installing', e2);
        return;
      }
      yield { step: 'installing', ref };
    } else {
      yield fail('inspecting', e);
      return;
    }
  }
  yield* secureAndPair(ref);

  // 5.11 securing: the SSH target, its pinned host key, a listener on the machine's loopback, and one forward that
  // opens. Nothing is installed and no port is opened.
  async function secure(ref: MachineRef, a: NonNullable<typeof o.address>): Promise<SshRoute> {
    if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) {
      throw new MachineError('bad-recipe', 'address.port: use a whole number from 1 to 65535.');
    }
    if (typeof a.transport?.hostKey !== 'function') throw new MachineError('bad-recipe', 'address.transport: pass the app SSH transport');
    const { transport } = a;
    const { forward } = transport;
    let target: SshTarget;
    if (o.provider.sshAccess !== undefined) {
      if (typeof a.publicKey !== 'string') throw new MachineError('bad-recipe', 'address.publicKey: pass the device\'s SSH public key');
      target = await o.provider.sshAccess(ref, a.publicKey);
    } else if (a.target !== undefined && a.pins !== undefined) {
      const fingerprint = await a.pins.load();
      if (fingerprint === null) throw new MachineError('host-key', 'no host key is pinned yet; confirm it with sshHostKey() first');
      target = { host: a.target.host, port: a.target.port ?? 22, user: a.target.user, fingerprint };
    } else {
      throw new MachineError('bad-recipe', 'address: pass target and pins for a provider without sshAccess');
    }
    const seen = await via(() => transport.hostKey({ host: target.host, port: target.port }));
    if (seen.fingerprint !== target.fingerprint) throw new MachineError('host-key', 'the server host key does not match the pinned one');
    const listening = await o.provider.exec(ref, ['sh', '-c', LISTEN_SHELL, 'sh', String(a.port)], { timeoutMs: 30_000 });
    if (listening.timedOut) throw new MachineError('timeout', 'checking the app port took too long');
    if (listening.code !== 0) throw new MachineError('provider', `nothing listens on 127.0.0.1:${a.port} on the cloud computer`);
    if (forward === undefined) throw new MachineError('unsupported', 'address.transport: this SSH transport cannot forward to the app port');
    const opened = await via(() => forward(target, { host: '127.0.0.1', port: a.port }));
    await opened.close();
    return { ...target, appPort: a.port };
  }

  // The steps after install, shared by both paths: securing, the pair gate, then ready.
  async function* secureAndPair(ref: MachineRef): AsyncGenerator<SetupStep> {
    let urls: string[] = [];
    let ssh: SshRoute | undefined;
    if (o.address !== undefined) {
      try {
        ssh = await secure(ref, o.address);
      } catch (e) {
        yield fail('securing', e);
        return;
      }
      urls = [`ws://127.0.0.1:${ssh.appPort}`];
      yield { step: 'securing', route: ssh };
    }
    if (o.pair !== undefined) {
      let receipt: PairReceipt | void;
      try {
        receipt = await o.pair(ref, {
          urls, ...(ssh !== undefined ? { ssh } : {}), read: (file) => readOutbox(o.provider, ref, o.recipe, file), replaceOwner,
          run: (argv, ro) => m.run(o.recipe, argv, ro), handoff: (argv, ho) => m.handoff(o.recipe, argv, ho),
        });
      } catch (e) {
        yield fail('pairing', e);
        return;
      }
      yield receipt ? { step: 'pairing', receipt } : { step: 'pairing' };
    }
    yield { step: 'ready', ref };
  }
}
