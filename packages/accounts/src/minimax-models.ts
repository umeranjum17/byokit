import type { Model, Models } from '@earendil-works/pi-ai';

// pi-ai (1.2.0, and 1.3.0) lists MiniMax-M3 but not the M3.1 Flash pair. Both ride M3's row (same API, base URL, image
// input and context); Flash is billed at its published rate. Preview has no published price, so it takes Flash's.
const FLASH = { input: 0.15, output: 0.6, cacheRead: 0.015, cacheWrite: 0 };
const EXTRA = ['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview'];

/** `models` with `MiniMax-M3.1-Flash` and `MiniMax-M3.1-Flash-Preview` listed on `minimax` and `minimax-cn`. */
export function withMinimaxFlash<T extends Models>(models: T): T {
  const set = (models as unknown as { setProvider(provider: object): void }).setProvider;
  for (const id of ['minimax', 'minimax-cn']) {
    const provider = models.getProvider(id);
    const base = provider?.getModels().find((m) => m.id === 'MiniMax-M3');
    if (!provider || !base) continue;
    const getModels = (): readonly Model<never>[] => {
      const own = provider.getModels() as readonly Model<never>[];
      return [...own, ...EXTRA.filter((x) => !own.some((m) => m.id === x))
        .map((x) => ({ ...base, id: x, name: x, cost: FLASH }) as unknown as Model<never>)];
    };
    set.call(models, { ...provider, getModels });
  }
  return models;
}
