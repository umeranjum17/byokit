// Pinned Pi Models and API adapters, not another inference implementation. No provider auth/env discovery.
import type { createModels, createProvider } from '@earendil-works/pi-ai';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, ModelAuth, ModelsApiStreamOptions, ProviderResponse, ProviderStreams, ProviderHeaders } from '@earendil-works/pi-ai';
import type { Route } from './catalogue.ts';
import { say } from './words.ts';

/** Full Pi request shape; auth always comes from the selected device-owned account. */
export type KeyAsk<T extends Api = Api> = {
  account: string; model: Model<T>; context: Context; options?: ModelsApiStreamOptions<T>;
  onText?: (delta: string) => void; onEvent?: (event: AssistantMessageEvent) => void;
};
export class KeyRouteError extends Error {
  readonly code: 'unsupported_platform' | 'needs_host' | 'needs_keys' | 'no_upstream_flow' | 'provider' | 'request' | 'needs_workspace' | 'workspaces_unread' | 'aborted' | 'auth_override' | 'out_of_credit' | 'key_refused' | 'rate_limited';
  /** For logs and an optional details line, never the shown words: the HTTP status the provider answered, and its own
   *  message (or the network error) with the account's secrets replaced, on one line of at most 300 characters. */
  readonly status?: number; readonly detail?: string;
  /** Only for `out_of_credit`: the count a 402 names in its own words ("can only afford N"), so the app can re-ask
   *  with it. Never retried here; absent for any other body or status. */
  readonly affordable?: number;
  constructor(code: KeyRouteError['code'], cause?: { status?: number; detail?: string; affordable?: number }) {
    super({ unsupported_platform: 'This model adapter is not available on this platform.', needs_host: 'This model adapter needs an isolated app-owned host.',
      needs_keys: 'Key routes need the @byokit/accounts/keys entry: withKeys(platform).',
      no_upstream_flow: 'This sign-in method is not in the pinned upstream.', provider: 'Choose a model from this account’s provider.',
      request: 'This account could not answer. Try again.', needs_workspace: 'This account works with more than one workspace. Pick the one to use and connect it again.',
      workspaces_unread: 'Couldn’t reach OpenCode to check this key’s workspaces. Check the internet connection, then try again.',
      aborted: 'The request was cancelled.',
      auth_override: 'A prebuilt client owns its own sign-in. Use the native adapter explicitly.',
      out_of_credit: say('ask.outOfCredit'), key_refused: say('ask.keyRefused'), rate_limited: say('ask.rateLimited') }[code]);
    this.name = 'KeyRouteError'; this.code = code;
    if (cause?.status) this.status = cause.status;
    if (cause?.detail) this.detail = cause.detail;
    if (cause?.affordable !== undefined) this.affordable = cause.affordable;
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
function publicValue<T>(value: T, secrets: readonly string[]): T {
  return JSON.parse(JSON.stringify(value, (_key, entry) => typeof entry === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), entry) : entry)) as T;
}

/** Pi's error text without its status prefix, the body's own message when it is JSON, secrets scrubbed (not capped). */
function messageOf(said: unknown, secrets: readonly string[]): string | undefined {
  if (typeof said !== 'string') return;
  let text = publicValue(said, secrets).replace(/^\d{3}:?\s*/, '');
  let body: { message?: unknown; error?: { message?: unknown } } | undefined;
  try { body = JSON.parse(text); } catch { body = undefined; }
  const message = body?.error?.message ?? body?.message;
  if (typeof message === 'string') text = message;
  return text;
}

/** The message on one line of at most 300 characters. Scrub before capping, so a cut never leaves part of a secret. */
const detailOf = (message: string | undefined): string | undefined => message?.replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;

/** The count a 402 names in its own words; anything else, or a count that is not a safe integer, is absent. */
function affordableOf(message: string | undefined): number | undefined {
  const count = Number(/can only afford (\d+)/i.exec(message ?? '')?.[1]);
  return Number.isSafeInteger(count) ? count : undefined;
}

/** A provider's own refusal, by the HTTP status it answered; anything else is the bounded generic. */
const refusal = (status: number): KeyRouteError['code'] =>
  status === 402 ? 'out_of_credit' : status === 401 || status === 403 ? 'key_refused' : status === 429 ? 'rate_limited' : 'request';

/** `access` is a saved key, or an OAuth sign-in's request auth as its pinned Pi provider derives it (a bearer key, Kimi's
 *  header or Copilot's base), which replaces the route's key auth. */
export async function keyRespond<T extends Api>(r: Route, access: string | ModelAuth, ask: KeyAsk<T>, fetcher: typeof fetch | undefined, runtime: KeyRuntime): Promise<AssistantMessage> {
  const options = ask.options;
  const auth: ModelAuth = typeof access === 'string' ? { apiKey: access } : access;
  const secrets = [auth.apiKey, ...Object.values(auth.headers ?? {}).map((value) => value?.replace(/^Bearer\s+/i, ''))].filter((s): s is string => !!s);
  if (ask.model.api === 'google-vertex' && typeof access === 'string' && /^<[^>]+>$/.test(access.trim())) throw new KeyRouteError('request');
  // The status, read where this request went out: Pi's error event keeps it inside its message, and a refused
  // connection reaches that event only as "Connection error.", so the network cause is read here too. Adapters that
  // take no fetch (Google, Bedrock) never set either and stay 'request'.
  let status = 0;
  let network: string | undefined;
  const send = options?.fetch ?? fetcher;
  const watched: typeof fetch = async (input, init) => {
    try {
      const res = await (send ?? fetch)(input, init);
      status = res.status;
      return res;
    } catch (e) {
      const cause = (e as { cause?: { message?: unknown } })?.cause?.message;
      network = `${e instanceof Error ? e.message : String(e)}${typeof cause === 'string' ? `: ${cause}` : ''}`;
      throw e;
    }
  };
  const failed = (code: KeyRouteError['code'], said?: unknown) => {
    const message = messageOf(network ?? said, secrets);
    return new KeyRouteError(code, { status, detail: detailOf(message), affordable: code === 'out_of_credit' ? affordableOf(message) : undefined });
  };
  try {
  let api = await runtime.api(ask.model.api);
  if (r.provider === 'cloudflare') api = (await runtime.cloudflare()).cloudflareStreams(api);
  // Required on Metro: default auth discovery reaches a lowered unresolved require, which is fatal on RN.
  const authContext = { env: async () => undefined, fileExists: async () => false };
  const models = runtime.createModels({ authContext });
  const compat = ask.model.compat as { openRouterRouting?: object } | undefined;
  const authHeaders: ProviderHeaders = typeof access !== 'string'
    ? { ...access.headers, ...(['minimax', 'minimax-cn'].includes(r.upstream.id) ? { authorization: `Bearer ${auth.apiKey}`, 'x-api-key': null } : {}) }
    : r.upstream.id === 'cloudflare-ai-gateway'
    ? { 'cf-aig-authorization': `Bearer ${access}`, authorization: null, 'x-api-key': null }
    : r.upstream.method === 'ANTHROPIC_AUTH_TOKEN' ? { authorization: `Bearer ${access}`, 'x-api-key': null } : {};
  const model = { ...ask.model, headers: nonAuthHeaders(ask.model.headers), compat: { ...compat, allowedFallbackModels: [], openRouterRouting: { ...compat?.openRouterRouting, allow_fallbacks: false } } } as unknown as Model<T>;
  models.setProvider(runtime.createProvider({ id: r.upstream.id, models: [model], api,
    auth: { apiKey: { name: r.label, resolve: async () => ({ auth: { apiKey: auth.apiKey,
      headers: authHeaders, ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}) } }) } } }));
  // Truthy scoped defaults stop the pin's env helper from falling back to the host. Azure endpoint config is
  // app-passed, never inferred from env. No retry, even on overload; the caller keeps the selected account.
  const defaults = { PI_CACHE_RETENTION: 'short', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '{}', AZURE_OPENAI_API_VERSION: '2025-04-01-preview',
    AZURE_OPENAI_BASE_URL: ask.model.baseUrl, AZURE_OPENAI_RESOURCE_NAME: 'unused' };
  const env: Record<string, string> = { ...defaults, ...options?.env };
  for (const [key, value] of Object.entries(defaults)) if (!env[key]) env[key] = value;
  const stream = models.stream(model, ask.context, { ...options, apiKey: auth.apiKey, env, maxRetries: 0,
    fetch: options?.fetch || !['google-generative-ai', 'google-vertex'].includes(ask.model.api) ? watched : undefined, transformHeaders: undefined,
    headers: { ...nonAuthHeaders(options?.headers), ...authHeaders },
    onResponse: options?.onResponse && ((response: ProviderResponse, model: Model<Api>) => options.onResponse!(publicValue(response, secrets), model)),
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
      const event = publicValue(raw, secrets);
      // The shown words stay bounded; the provider's own words ride along as `detail`. The gateway's own
      // workspace refusal names its cause, so it maps to its own typed words instead of the generic retry.
      if (event.type === 'error') {
        const reason = (event as { error?: { errorMessage?: unknown } }).error?.errorMessage;
        throw failed(typeof reason === 'string' && /workspace selection is required/i.test(reason) ? 'needs_workspace'
          : event.reason === 'aborted' ? 'aborted' : refusal(status), reason);
      }
      ask.onEvent?.(event);
      if (event.type === 'text_delta') ask.onText?.(event.delta);
    }
    const result = publicValue(await stream.result(), secrets);
    if (result.stopReason === 'error' || result.stopReason === 'aborted') throw failed(result.stopReason === 'aborted' ? 'aborted' : 'request', result.errorMessage);
    return result;
  } catch (error) {
    if (error instanceof KeyRouteError) throw error;
    throw failed(options?.signal?.aborted ? 'aborted' : refusal(status), error instanceof Error ? error.message : String(error));
  }
}
