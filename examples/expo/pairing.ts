import { normalizeCode, pairWithCode, pairWithOffer, type KeptDevice } from '@byokit/link';

export function pairInput(input: string, hostUrl: string, options: Parameters<typeof pairWithOffer>[1]) {
  const code = normalizeCode(input.trim());
  return code ? pairWithCode(hostUrl.trim(), code, options) : pairWithOffer(input.trim(), options);
}

export function pairingGeneration() {
  let current = 0, pairing = false;
  return {
    next: () => ++current,
    begin: () => { if (pairing) return null; pairing = true; return ++current; },
    finish: () => { pairing = false; },
    isCurrent: (generation: number) => generation === current,
  };
}

export function forgettableStore(store: KeptDevice) {
  let forgotten = false;
  let pending = Promise.resolve();
  const forget = async () => {
    forgotten = true;
    await pending;
    await store.clear();
  };
  return {
    load: () => store.load(),
    save(grant: Parameters<KeptDevice['save']>[0]) {
      if (forgotten) return Promise.resolve();
      const writing = pending.then(() => forgotten ? undefined : store.save(grant));
      pending = writing.catch(() => {});
      return writing;
    },
    clear: forget,
    forget,
  };
}
