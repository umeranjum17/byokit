// setup(): one existing-computer connect as a step stream (docs/cloud-kit.md 4.5, 5.11).
// Each step is emitted after its real result, never from timers or log prose.
import { MachineError } from './errors.ts';
import { machine } from './machine.ts';
import { readOutbox, type PairContext, type PairReceipt } from './enrol.ts';
import { checkPort, servePort } from './tailnet.ts';
import { errorKey } from './words.ts';
import type { HostRecipe, MachineRef, MachineStore, Provider, TailnetStep } from './types.ts';
import type { WordKey } from './words.ts';

export type SetupStepName = 'checking-access' | 'listing' | 'inspecting' | 'installing' | 'securing' | 'pairing';

export type SetupStep =
  | { step: 'checking-access'; account: string }
  | { step: 'listing'; machines: MachineRef[] }
  | { step: 'inspecting'; ref: MachineRef }
  | { step: 'installing'; ref: MachineRef }
  | { step: 'securing'; name: string }
  | { step: 'pairing'; receipt?: PairReceipt }
  | { step: 'ready'; ref: MachineRef }
  | { step: 'failed'; at: SetupStepName; cause: WordKey; retryable: boolean };

/** Failures a repeated setup() may pass without new input (5.11). */
const RETRYABLE = new Set(['unreachable', 'timeout', 'provider', 'balance', 'busy']);

export async function* setup(o: {
  provider: Provider;
  store: MachineStore;
  recipe: HostRecipe;
  pick: (listed: MachineRef[]) => MachineRef;
  confirmId: string;
  onLine?: (line: string) => void;
  address?: { hostname: string; port: number; onStep?: (s: TailnetStep) => void };  // the secure address; absent skips securing
  pair?: (ref: MachineRef, ctx: PairContext) => Promise<PairReceipt | void>;  // the app's Pair-ready gate; absent skips pairing
}): AsyncGenerator<SetupStep> {
  const m = machine({ provider: o.provider, store: o.store });
  const fail = (at: SetupStepName, e: unknown): SetupStep =>
    e instanceof MachineError
      ? { step: 'failed', at, cause: errorKey(e), retryable: RETRYABLE.has(e.code) }
      : { step: 'failed', at, cause: 'error.app', retryable: false };
  const saved = (selected: MachineRef): MachineRef | null => {
    const r = m.ref;
    return r !== null && r.id === selected.id && r.name === o.recipe.name ? r : null;
  };
  let account: string;
  try {
    account = await o.provider.account();
  } catch (e) {
    yield fail('checking-access', e);
    return;
  }
  yield { step: 'checking-access', account };
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
  // adopt() guards, saves, then installs: a saved picked ref means the guards passed.
  const prior = saved(selected);
  let ref: MachineRef;
  try {
    ref = await m.adopt(selected, { confirmId: o.confirmId, recipe: o.recipe, onLine: o.onLine });
    yield { step: 'inspecting', ref };
    yield { step: 'installing', ref };
  } catch (e) {
    const code = (e as { code?: string }).code;
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
    } else if (code === 'busy' || prior !== null || resumed === null) {
      yield fail('inspecting', e);
      return;
    } else {
      yield fail('installing', e);
      return;
    }
  }
  let urls: string[] = [];
  if (o.address !== undefined) {
    const { hostname, port, onStep } = o.address;
    let name: string;
    try {
      checkPort(port);
      const t = await m.tailnet();
      name = t.state === 'joined' && t.name !== null ? t.name : (await m.joinTailnet({ hostname }, onStep)).name;
      await servePort(o.provider, ref, port);
    } catch (e) {
      yield fail('securing', e);
      return;
    }
    urls = [`ws://${name}:${port}`];
    yield { step: 'securing', name };
  }
  if (o.pair !== undefined) {
    let receipt: PairReceipt | void;
    try {
      receipt = await o.pair(ref, { urls, read: (file) => readOutbox(o.provider, ref, o.recipe, file) });
    } catch (e) {
      yield fail('pairing', e);
      return;
    }
    yield receipt ? { step: 'pairing', receipt } : { step: 'pairing' };
  }
  yield { step: 'ready', ref };
}
