// setup(): one existing-computer connect as a step stream (docs/cloud-kit.md 4.5, 5.11).
// Each step is emitted after its real result, never from timers or log prose.
import { isAdoptionInstallFailure, MachineError } from './errors.ts';
import { machine } from './machine.ts';
import { errorKey } from './words.ts';
import type { HostRecipe, MachineRef, MachineStore, Provider } from './types.ts';
import type { WordKey } from './words.ts';

export type SetupStepName = 'checking-access' | 'listing' | 'inspecting' | 'installing' | 'pairing';

export type SetupStep =
  | { step: 'checking-access'; account: string }
  | { step: 'listing'; machines: MachineRef[] }
  | { step: 'inspecting'; ref: MachineRef }
  | { step: 'installing'; ref: MachineRef }
  | { step: 'pairing' }
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
  pair?: (ref: MachineRef) => Promise<void>;       // the app's Pair-ready gate; absent skips pairing
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
  // adopt() tags install failures so resumed state is irrelevant.
  let ref: MachineRef;
  try {
    ref = await m.adopt(selected, { confirmId: o.confirmId, recipe: o.recipe, onLine: o.onLine });
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
  if (o.pair !== undefined) {
    try {
      await o.pair(ref);
    } catch (e) {
      yield fail('pairing', e);
      return;
    }
    yield { step: 'pairing' };
  }
  yield { step: 'ready', ref };
}
