// Phone consumer: the person pastes their provider key (or follows a claim
// request) and the phone keeps it in its own protected account storage.
// docs/cloud-kit.md 11.5 v1 path (`setup.makeKey`); the claim driver below
// consumes the existing claim() steps (ClaimStep) without rebuilding M8's driver.
// Portable: no `node:*` import, so the phone app and journey tests share it.
// The key travels only in the Authorization header; no sentence below ever holds it.
import { boat, words, MachineError } from '@byokit/cloud';
import type { ClaimStep, MachineStore, Provider } from '@byokit/cloud';

export const BOAT_API = 'https://boat.dev/api/v1';

/** Every way entering the provider value can end: one cheap check read at most, never a machine, install or spend. */
export type SetupWhy = 'unknown-key' | 'denied' | 'expired' | 'unreachable' | 'cancelled' | 'missing';
export type SetupResult = { ok: true } | { ok: false; why: SetupWhy };

/** A Boat provider that checks one pasted key: every read carries only that key. */
export const setupProvider = (o: { label: string; key: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal }): Provider => {
  const inner = o.fetch ?? globalThis.fetch;
  const via: typeof globalThis.fetch = (o.signal === undefined ? inner : (async (url: string, init?: RequestInit) =>
    inner(url, { ...init, signal: o.signal })) as typeof globalThis.fetch);
  return boat({ baseUrl: o.baseUrl ?? BOAT_API, label: o.label, prices: [], key: async () => o.key, fetch: via });
};

/**
 * Paste path: check one key with a single identity read, then save it to the
 * phone's store, keeping the stored machine ref as loaded. An empty key checks
 * nothing and spends nothing (`missing`).
 */
export async function setupKey(o: { provider: Provider; store: MachineStore; key: string; signal?: AbortSignal }): Promise<SetupResult> {
  const key = o.key.trim();
  if (o.signal?.aborted) return { ok: false, why: 'cancelled' };
  if (key === '') return { ok: false, why: 'missing' };
  try {
    await o.provider.account();
  } catch (e) {
    if (o.signal?.aborted) return { ok: false, why: 'cancelled' };
    if (e instanceof MachineError && e.code === 'unauthorized') return { ok: false, why: 'unknown-key' };
    if (e instanceof MachineError && (e.code === 'unreachable' || e.code === 'timeout')) return { ok: false, why: 'unreachable' };
    throw e; // any other kit failure keeps its own typed error; no fallback words
  }
  if (o.signal?.aborted) return { ok: false, why: 'cancelled' }; // checked, then cancelled: the key is not saved
  const kept = await o.store.load();
  await o.store.save({ ...(kept ?? { providerKey: '', ref: null }), providerKey: key });
  return { ok: true };
};

/**
 * Claim path: drive an existing claim() iterable to its terminal step. The UI
 * shows each step through onStep; on `done` the claimed key is saved like a
 * pasted one. A provider-side claim failure keeps its kit error.
 */
export async function setupClaim(o: {
  steps: AsyncIterable<ClaimStep>; store: MachineStore; signal?: AbortSignal;
  onStep?: (step: { step: 'open-page'; url: string } | { step: 'type-code'; url: string; code: string } | { step: 'waiting' }) => void;
}): Promise<SetupResult> {
  for await (const step of o.steps) {
    if (o.signal?.aborted) return { ok: false, why: 'cancelled' };
    if (step.step === 'done') {
      const kept = await o.store.load();
      await o.store.save({ ...(kept ?? { providerKey: '', ref: null }), providerKey: step.key });
      return { ok: true };
    }
    if (step.step === 'failed') {
      if (step.why === 'refused') return { ok: false, why: 'denied' };
      if (step.why === 'expired') return { ok: false, why: 'expired' };
      if (step.why === 'unreachable') return { ok: false, why: 'unreachable' };
      throw new MachineError('provider', 'the provider did not complete the request');
    }
    o.onStep?.(step);
  }
  return { ok: false, why: 'cancelled' }; // the iterable ended unfinished: nothing was saved
};

/** Plain words for each result, reusing the kit sentences where they exist. */
export const setupWords = (why: SetupWhy, label: string): string => {
  switch (why) {
    case 'unknown-key': return words('error.key', { label });
    case 'missing': return words('setup.makeKey', { label });
    case 'unreachable': return `Can't reach ${label} right now. Try again.`;
    case 'cancelled': return 'Cancelled. Nothing was saved.';
    case 'denied': return `The ${label} page refused the request. Nothing was saved.`;
    case 'expired': return 'The request expired. Start again for a new code. Nothing was saved.';
  }
};
