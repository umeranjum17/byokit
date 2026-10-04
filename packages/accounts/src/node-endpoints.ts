// Pinned Pi providers run only on the host. Portable entries carry the contract, never Node/Pi runtime imports.
import { createModels, createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { EndpointDriver } from './endpoints.ts';
import { emptyAuthContext } from './isolate.ts';

export const endpointDriver: EndpointDriver = (id, config, auth) => {
  const api = config.compat === 'openai' ? 'openai-completions' : 'anthropic-messages';
  const models = (config.models ?? []).map((m) => Object.freeze({ ...m, api, provider: id, baseUrl: config.baseUrl }));
  const runtime = createModels({ authContext: emptyAuthContext });
  runtime.setProvider(createProvider({ id, name: config.name ?? 'Your own server', baseUrl: config.baseUrl, models,
    auth: { apiKey: { name: 'Selected endpoint',
      check: async () => { await auth(); return { type: 'api_key', source: 'Selected endpoint' }; },
      // The SDK requires a nonempty key even for explicitly keyless local servers. This is not a credential.
      resolve: async () => ({ auth: { apiKey: (await auth()) ?? 'byokit-keyless-endpoint' }, source: 'Selected endpoint' }),
    } }, api: config.compat === 'openai' ? openAICompletionsApi() : anthropicMessagesApi(),
  }));
  // Pi normally accepts arbitrary model objects. Keep the chosen account's destination immutable and refuse
  // foreign/cloned models before auth; every stream/complete/deferred method remains the pinned typed pass-through.
  const dispatch = new Set(['stream', 'complete', 'streamSimple', 'completeSimple', 'streamDeferred', 'fetchDeferred', 'cancelDeferred']);
  return new Proxy(runtime, { get(target, property) {
    if (['setProvider', 'deleteProvider', 'clearProviders'].includes(String(property))) return undefined;
    const value = Reflect.get(target, property);
    if (typeof value !== 'function') return value;
    return (...args: unknown[]) => {
      if ((dispatch.has(String(property)) || property === 'getAuth' && typeof args[0] !== 'string') && !models.includes(args[0] as typeof models[number])) throw new Error('Choose a model from this endpoint account.');
      return value.apply(target, args);
    };
  } });
};
