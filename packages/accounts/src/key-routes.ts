// Pinned Pi Models and API adapters, not another inference implementation. No provider auth/env discovery.
import type { createModels, createProvider } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ModelsApiStreamOptions, ProviderResponse, ProviderStreams, ProviderHeaders } from '@earendil-works/pi-ai';
import type { Route } from './catalogue.ts';

/** Full Pi request shape; auth always comes from the selected device-owned account. */
export type KeyAsk<T extends Api = Api> = {
  account: string; model: Model<T>; context: Context; options?: ModelsApiStreamOptions<T>;
  onText?: (delta: string) => void; onEvent?: (event: AssistantMessageEvent) => void;
};
export class KeyRouteError extends Error {
  readonly code: 'unsupported_platform' | 'needs_host' | 'needs_keys' | 'no_upstream_flow' | 'provider' | 'request' | 'aborted' | 'auth_override';
  constructor(code: KeyRouteError['code']) {
    super({ unsupported_platform: 'This model adapter is not available on this platform.', needs_host: 'This model adapter needs an isolated app-owned host.',
      needs_keys: 'Key routes need the @byokit/accounts/keys entry: withKeys(platform).',
      no_upstream_flow: 'This sign-in method is not in the pinned upstream.', provider: 'Choose a model from this account’s provider.',
      request: 'This account could not answer. Try again.', aborted: 'The request was cancelled.',
      auth_override: 'A prebuilt client owns its own sign-in. Use the native adapter explicitly.' }[code]);
    this.name = 'KeyRouteError'; this.code = code;
  }
}

/** Platform-owned typed loaders; the portable entry never imports the published runtime. */
export type KeyRuntime = {
  createModels: typeof createModels; createProvider: typeof createProvider;
  supported: readonly string[]; api: (name: string) => Promise<ProviderStreams>;
  cloudflare: () => Promise<typeof import('@earendil-works/pi-ai/providers/cloudflare-stream')>;
};

/** Before credentials: Node-only cloud adapters stay on the host. Bedrock's pin reads ambient AWS_PROFILE even
 * with a bearer token; never load it here. A cloud host adapter is a separate work package. */
export function checkKeyModel(r: Route, model: Model<Api>, platform: 'node' | 'browser' | 'rn', supported: readonly string[]) {
  if (r.upstream.flow === 'absent') throw new KeyRouteError('no_upstream_flow');
  if (r.platforms[platform] === 'no' || platform !== 'node' && ['bedrock-converse-stream', 'google-vertex'].includes(model.api)) throw new KeyRouteError('unsupported_platform');
  if (model.provider !== r.upstream.id) throw new KeyRouteError('provider');
  try { if (!['http:', 'https:'].includes(new URL(model.baseUrl).protocol)) throw new Error(); }
  catch { throw new KeyRouteError('needs_host'); }
  if (!supported.includes(model.api)) throw new KeyRouteError('needs_host');
}

/** Credential headers belong to the selected account, never model/request overrides. */
function nonAuthHeaders(headers?: ProviderHeaders): ProviderHeaders {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !/^(authorization|x-api-key|api-key|x-goog-api-key|cf-aig-authorization)$/i.test(name)));
}

/** Exact-secret redaction also covers vendor/transport errors that echo a request header. */
function publicValue<T>(value: T, secret: string): T {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'string' ? entry.split(secret).join('[redacted]') : entry)) as T;
}

export async function keyRespond<T extends Api>(r: Route, secret: string, ask: KeyAsk<T>, fetcher: typeof fetch | undefined, runtime: KeyRuntime): Promise<AssistantMessage> {
  const options = ask.options;
  if (ask.model.api === 'google-vertex' && /^<[^>]+>$/.test(secret.trim())) throw new KeyRouteError('request');
  try {
  let api = await runtime.api(ask.model.api);
  if (r.provider === 'cloudflare') api = (await runtime.cloudflare()).cloudflareStreams(api);
  // Required on Metro: default auth discovery reaches a lowered unresolved require, which is fatal on RN.
  const authContext = { env: async () => undefined, fileExists: async () => false };
  const models = runtime.createModels({ authContext });
  const compat = ask.model.compat as { openRouterRouting?: object } | undefined;
  const authHeaders: ProviderHeaders = r.upstream.id === 'cloudflare-ai-gateway'
    ? { 'cf-aig-authorization': `Bearer ${secret}`, authorization: null, 'x-api-key': null }
    : r.upstream.method === 'ANTHROPIC_AUTH_TOKEN' ? { authorization: `Bearer ${secret}`, 'x-api-key': null } : {};
  const model = { ...ask.model, headers: nonAuthHeaders(ask.model.headers), compat: { ...compat, allowedFallbackModels: [], openRouterRouting: { ...compat?.openRouterRouting, allow_fallbacks: false } } } as unknown as Model<T>;
  models.setProvider(runtime.createProvider({ id: r.upstream.id, models: [model], api,
    auth: { apiKey: { name: r.label, resolve: async () => ({ auth: { apiKey: secret,
      headers: authHeaders } }) } } }));
  // Truthy scoped defaults stop the pin's env helper from falling back to the host. Azure endpoint config is
  // app-passed, never inferred from env. No retry, even on overload; the caller keeps the selected account.
  const defaults = { PI_CACHE_RETENTION: 'short', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '{}', AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
    AZURE_OPENAI_BASE_URL: ask.model.baseUrl, AZURE_OPENAI_RESOURCE_NAME: 'unused' };
  const env: Record<string, string> = { ...defaults, ...options?.env };
  for (const [key, value] of Object.entries(defaults)) if (!env[key]) env[key] = value;
  const stream = models.stream(model, ask.context, { ...options, apiKey: secret, env, maxRetries: 0,
    fetch: options?.fetch ?? (['google-generative-ai', 'google-vertex'].includes(ask.model.api) ? undefined : fetcher), transformHeaders: undefined,
    headers: { ...nonAuthHeaders(options?.headers), ...authHeaders },
    onResponse: options?.onResponse && ((response: ProviderResponse, model: Model<Api>) => options.onResponse!(publicValue(response, secret), model)),
    onPayload: async (payload: unknown, model: Model<Api>) => {
      const value = await options?.onPayload?.(payload, model) ?? payload;
      if (value && typeof value === 'object') {
        const request = value as Record<string, unknown>;
        if (typeof request.model === 'string' && request.model !== ask.model.id) throw new KeyRouteError('provider');
        delete request.fallbacks; delete request.models;
        if (request.provider && typeof request.provider === 'object') (request.provider as Record<string, unknown>).allow_fallbacks = false;
      }
      return value;
    } } as unknown as ModelsApiStreamOptions<T>);
    for await (const raw of stream) {
      const event = publicValue(raw, secret);
      // Pi error events carry raw diagnostics; the public error is intentionally bounded.
      if (event.type === 'error') throw new KeyRouteError(event.reason === 'aborted' ? 'aborted' : 'request');
      ask.onEvent?.(event);
      if (event.type === 'text_delta') ask.onText?.(event.delta);
    }
    const result = publicValue(await stream.result(), secret);
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new KeyRouteError(result.stopReason === 'aborted' ? 'aborted' : 'request');
    return result;
  } catch (error) {
    if (error instanceof KeyRouteError) throw error;
    throw new KeyRouteError(options?.signal?.aborted ? 'aborted' : 'request');
  }
}
