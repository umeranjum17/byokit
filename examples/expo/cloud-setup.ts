// Phone consumer: the person pastes their provider key and the phone keeps it
// in its own protected account storage.
// docs/cloud-kit.md 11.5 v1 path (`setup.makeKey`).
// Portable: no `node:*` import, so the phone app and journey tests share it.
// The key travels only in the Authorization header; no sentence below ever holds it.
import { boat, words, MachineError } from '@byokit/cloud';
import type { MachineStore, Provider } from '@byokit/cloud';

export const BOAT_API = 'https://boat.dev/api/v1';

/** Every way entering the provider value can end: one cheap check read at most, never a machine, install or spend. */
export type SetupWhy = 'unknown-key' | 'unreachable' | 'cancelled' | 'missing';
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
 * phone's store. The stored machine ref is kept only while it belongs to the
 * key's account; otherwise it is dropped so the next connect resolves fresh.
 * An empty key checks nothing and spends nothing (`missing`).
 */
export async function setupKey(o: { provider: Provider; store: MachineStore; key: string; signal?: AbortSignal }): Promise<SetupResult> {
  const key = o.key.trim();
  if (o.signal?.aborted) return { ok: false, why: 'cancelled' };
  if (key === '') return { ok: false, why: 'missing' };
  let account: string;
  try {
    account = await o.provider.account();
  } catch (e) {
    if (o.signal?.aborted) return { ok: false, why: 'cancelled' };
    if (e instanceof MachineError && e.code === 'unauthorized') return { ok: false, why: 'unknown-key' };
    if (e instanceof MachineError && (e.code === 'unreachable' || e.code === 'timeout')) return { ok: false, why: 'unreachable' };
    throw e; // any other kit failure keeps its own typed error; no fallback words
  }
  if (o.signal?.aborted) return { ok: false, why: 'cancelled' }; // checked, then cancelled: the key is not saved
  const kept = await o.store.load();
  const ref = kept?.ref && kept.ref.provider === o.provider.id && kept.ref.account === account ? kept.ref : null;
  await o.store.save({ ...kept, providerKey: key, ref });
  return { ok: true };
};

/** Plain words for each result, reusing the kit sentences where they exist. */
export const setupWords = (why: SetupWhy, label: string): string => {
  switch (why) {
    case 'unknown-key': return words('error.key', { label });
    case 'missing': return words('setup.makeKey', { label });
    case 'unreachable': return `Can't reach ${label} right now. Try again.`;
    case 'cancelled': return 'Cancelled. Nothing was saved.';
  }
};
