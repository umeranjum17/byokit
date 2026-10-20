// byokit.catalog (5.6 live provider catalogs): the provider plugin's own live model list, with each model's api and
// baseUrl from its catalog data, joined by the vendor's own model list, so the kit can register models embedded runs
// cannot resolve otherwise. The engine's catalog loader stops at a registered list; the provider's catalog hook does not.
export function registerCatalog(api) {
  api.registerGatewayMethod('byokit.catalog', async ({ params, respond }) => {
    try {
      const provider = String(params?.provider ?? '');
      const { resolveAgentDir } = await import('openclaw/plugin-sdk/agent-runtime');
      const { getRuntimeConfig } = await import('openclaw/plugin-sdk/config-runtime');
      const { resolvePluginProviders } = await import('openclaw/plugin-sdk/provider-catalog-runtime');
      const { resolveApiKeyForProvider } = await import('openclaw/plugin-sdk/provider-auth-runtime');
      const config = getRuntimeConfig();
      const hook = resolvePluginProviders({ config, env: process.env }).find((p) => p.id === provider)?.catalog;
      if (!provider) return respond(true, { ok: false, reason: 'failed' });
      if (typeof hook?.run !== 'function') return respond(true, { ok: true, models: [] }); // a provider with no catalog lists nothing
      // The first agent holding the provider's key; every account of one provider sees the same catalog.
      let unreadable = false;
      for (const agentId of new Set([...Object.keys(config.agents?.entries ?? {}), 'main'])) {
        const agentDir = resolveAgentDir(config, agentId);
        const apiKey = await resolveApiKeyForProvider({ provider, cfg: config, agentDir })
          .then((a) => a?.apiKey, () => { unreadable = true; return undefined; });
        if (!apiKey) continue;
        const run = async (discoveryApiKey) => (await hook.run({ config, agentDir, env: process.env, providerIds: [provider],
          resolveProviderApiKey: () => ({ apiKey, discoveryApiKey }),
          resolveProviderAuth: () => ({ apiKey, discoveryApiKey, mode: 'api_key', source: 'profile' }) }))?.provider;
        const live = await run(apiKey);
        // Each api's endpoint comes from the pinned catalog (no discovery key): upstream now names endpoints the
        // pinned engine does not recognize, and it sends Go's routing header only to ones it does.
        // ponytail: drop when the engine pin recognizes the live endpoints.
        const pinned = await run(undefined);
        const endpoint = new Map();
        for (const m of pinned?.models ?? []) {
          const api = m.api ?? pinned.api;
          if (!endpoint.has(api) && (m.baseUrl ?? pinned.baseUrl)) endpoint.set(api, m.baseUrl ?? pinned.baseUrl);
        }
        if (!live?.models?.length) return respond(true, { ok: false, reason: 'failed' });
        // A pinned model the live list omits stays in the catalog; live wins by id.
        const liveIds = new Set(live.models.map((m) => m.id));
        const models = [...live.models, ...(pinned?.models ?? []).filter((m) => !liveIds.has(m.id))]
          .map(({ provider: _p, apiKey: _k, headers: _h, ...model }) =>
            (endpoint.has(model.api) ? { ...model, baseUrl: endpoint.get(model.api) } : model));
        // A plugin catalog can be a fixed list (MiniMax's): the vendor's own `/models` lists newer ids, which join it with
        // the richest row's api, base URL and capabilities (a vendor list carries ids only). Same rule as
        // @byokit/accounts' live lists; another api, or a failed fetch, keeps the plugin's rows.
        const base = models.reduce((a, b) => (b.contextWindow ?? 0) > (a.contextWindow ?? 0) ? b : a);
        const openai = String(base.api).startsWith('openai-');
        if (base.baseUrl && (openai || base.api === 'anthropic-messages')) {
          const input = ['text', 'image'].filter((i) => models.some((m) => m.input?.includes(i)));
          const bearer = openai || /^minimax/.test(provider);
          const listed = await fetch(`${String(base.baseUrl).replace(/\/$/, '')}${openai ? '/models' : '/v1/models'}`, { signal: AbortSignal.timeout(10_000),
            headers: bearer ? { authorization: `Bearer ${apiKey}`, 'anthropic-version': '2023-06-01' } : { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } })
            .then((r) => r.ok ? r.json() : null, () => null);
          const have = new Set(models.map((m) => m.id));
          for (const m of Array.isArray(listed?.data) ? listed.data : [])
            if (typeof m?.id === 'string' && m.id && !have.has(m.id))
              models.push({ ...base, id: m.id, name: m.display_name || m.id, input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
        }
        return respond(true, { ok: true, models });
      }
      respond(true, { ok: false, reason: unreadable ? 'failed' : 'no-key' });
    } catch {
      respond(true, { ok: false, reason: 'failed' }); // never engine text: a hook error could carry the key
    }
  }, { scope: 'operator.admin' });
}
