import type { lazyApi } from '@earendil-works/pi-ai/api/lazy';
import type { KeyRuntime } from './key-routes.ts';
import { routes } from './catalogue.ts';

type Registry = ReturnType<KeyRuntime['createModels']>;

/** Register a runnable provider, with no model list, for each ready key/plan-key route `models` does not already know
 *  (Pi's catalogue lacks Ollama Pro, for one), so `getModel(upstream, id)` resolves it by name. */
export function addKeyRoutes<T extends Registry>(models: T, runtime: KeyRuntime, lazy: typeof lazyApi, platform: 'node' | 'rn'): T {
  for (const r of routes({ platform })) {
    const target = r.models;
    if (!target || r.readiness !== 'ready' || !['key', 'plan_key'].includes(r.via) ||
      !runtime.supported.includes(target.api) || models.getProvider(r.upstream.id)) continue;
    models.setProvider(Object.assign(runtime.createProvider({ id: r.upstream.id, name: r.name, baseUrl: target.baseUrl,
      models: [], api: lazy(() => runtime.api(target.api)),
      auth: { apiKey: { name: r.label, resolve: async ({ credential }) => credential?.key
        ? { auth: { apiKey: credential.key }, env: credential.env } : undefined } },
    }), { modelRoute: target }));
  }
  return models;
}

/** Vendor routes, not a frozen model list. No ambient auth: native callers pass their own key or provider. */
export function keyModels(runtime: KeyRuntime, lazy: typeof lazyApi): KeyRuntime['createModels'] {
  return (options) => addKeyRoutes(runtime.createModels(options), runtime, lazy, 'rn');
}
