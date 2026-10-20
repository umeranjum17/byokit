import type { Api, Model } from '@earendil-works/pi-ai';

// Pi's catalogue lags the vendors, and a model id it has not heard of is refused even on a route that serves it. On a
// known route (a provider whose catalogue rows all share one API and base URL, on an API the kit speaks) any id the
// person names becomes a model entry built at run time, never blocked. Unknown routes get nothing: no base URL is guessed.
const APIS = ['anthropic-messages', 'openai-completions', 'openai-responses'];

/** What a provider's live `/models` list said about one id; absent fields keep the safe defaults. */
export type Limits = { contextWindow?: number; maxTokens?: number; cost?: Model<Api>['cost']; input?: Model<Api>['input'] };

type Catalogue = { getProvider(id: string): { getModels(): readonly Model<Api>[] } | undefined; getModel(provider: string, id: string): Model<Api> | undefined };

/** The provider's route when it is known: the one API and base URL every catalogue row shares. */
function route(models: Catalogue, provider: string): Model<Api> | undefined {
  const rows = models.getProvider(provider)?.getModels() ?? [];
  const first = rows[0];
  if (!first || !APIS.includes(first.api) || !/^https:\/\/[^{}]+$/.test(first.baseUrl ?? '')) return undefined;
  return rows.every((m) => m.api === first.api && m.baseUrl === first.baseUrl) ? first : undefined;
}

/** The catalogue's `provider`/`id` entry, else (known route only) an entry for that id. Unpriced (cost 0), 128k context
 *  and 16k output until `limits` says more. Capabilities are the vendor's: input is every modality the route's own
 *  models take (an unknown model never loses image input), `reasoning` whether any of them reasons. */
export function namedModel(models: Catalogue, provider: string, id: string, limits: Limits = {}): Model<Api> | undefined {
  const known = models.getModel(provider, id);
  if (known || !id.trim()) return known;
  const base = route(models, provider);
  if (!base) return undefined;
  const rows = models.getProvider(provider)!.getModels();
  const { contextWindow = 128_000, maxTokens = 16_384, cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    input = (['text', 'image'] as const).filter((m) => rows.some((r) => r.input.includes(m))) } = limits;
  return { id, name: id, api: base.api, provider, baseUrl: base.baseUrl, reasoning: rows.some((r) => r.reasoning), input, cost,
    contextWindow, maxTokens: Math.min(maxTokens, contextWindow),
    ...(base.headers ? { headers: base.headers } : {}), ...(base.compat ? { compat: base.compat } : {}) } as Model<Api>;
}

const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined;
const perMillion = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n * 1e6 : 0; };

/** The limits and price an OpenAI-style `GET {baseUrl}/models` lists for `id` (OpenRouter-style `context_length`,
 *  `top_provider.max_completion_tokens`, `pricing` per token). An Anthropic Messages route lists none; any failure is
 *  `{}` and the defaults stand. */
export async function liveLimits(model: Pick<Model<Api>, 'api' | 'baseUrl' | 'id'>, o: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<Limits> {
  if (!model.api.startsWith('openai-')) return {};
  try {
    const res = await (o.fetch ?? fetch)(`${model.baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${o.apiKey}` }, signal: o.signal });
    if (!res.ok) return {};
    const rows = ((await res.json()) as { data?: Record<string, any>[] }).data;
    const row = Array.isArray(rows) ? rows.find((r) => r?.id === model.id) : undefined;
    if (!row) return {};
    const contextWindow = count(row.context_length) ?? count(row.context_window) ?? count(row.max_model_len);
    const maxTokens = count(row.top_provider?.max_completion_tokens) ?? count(row.max_completion_tokens) ?? count(row.max_output_tokens);
    const p = row.pricing;
    const modes: unknown = row.architecture?.input_modalities ?? row.modalities?.input;
    const input = Array.isArray(modes) ? (['text', 'image'] as const).filter((m) => modes.includes(m)) : [];
    return { ...(input.length ? { input } : {}), ...(contextWindow ? { contextWindow } : {}), ...(maxTokens ? { maxTokens } : {}),
      ...(p && typeof p === 'object' && p.prompt !== undefined ? { cost: { input: perMillion(p.prompt), output: perMillion(p.completion), cacheRead: perMillion(p.input_cache_read), cacheWrite: perMillion(p.input_cache_write) } } : {}) };
  } catch { return {}; }
}

/** `namedModel` with the live list's limits when the route has one. An id the live list does not carry still resolves
 *  (`listed: false`, for the app to warn about): never blocked. */
export async function resolveModel(models: Catalogue, provider: string, id: string, o: { apiKey: string; fetch?: typeof fetch; signal?: AbortSignal }): Promise<{ model: Model<Api>; listed: boolean } | undefined> {
  // `getModel` may be `withNamedModels`', which answers every id: the catalogue itself decides what is listed.
  const listed = models.getProvider(provider)?.getModels().some((m) => m.id === id);
  const found = namedModel({ getProvider: (p) => models.getProvider(p), getModel: (p, i) => models.getProvider(p)?.getModels().find((m) => m.id === i) }, provider, id);
  if (!found) return undefined;
  if (listed) return { model: found, listed: true };
  const limits = await liveLimits(found, o);
  return { model: namedModel({ getProvider: (p) => models.getProvider(p), getModel: () => undefined }, provider, id, limits)!, listed: Object.keys(limits).length > 0 };
}

/** `models` whose `getModel` also answers an id the catalogue lacks, on a known route. */
export function withNamedModels<T extends Catalogue>(models: T): T {
  const own = models.getModel.bind(models);
  return Object.assign(models, { getModel: (provider: string, id: string) => namedModel({ getProvider: (p) => models.getProvider(p), getModel: own }, provider, id) });
}
