// byokit.catalog (5.6 live provider catalogs): the provider plugin's own live model list, with each model's api and
// baseUrl from its catalog data, so the kit can register models embedded runs cannot resolve otherwise. The engine's
// catalog loader stops at a registered list; the provider's catalog hook does not.
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
      if (!provider || typeof hook?.run !== 'function') return respond(true, { ok: false });
      // The first agent holding the provider's key; every account of one provider sees the same catalog.
      for (const agentId of new Set([...Object.keys(config.agents?.entries ?? {}), 'main'])) {
        const agentDir = resolveAgentDir(config, agentId);
        const apiKey = await resolveApiKeyForProvider({ provider, cfg: config, agentDir }).then((a) => a?.apiKey, () => undefined);
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
        const models = (live?.models ?? []).map(({ provider: _p, apiKey: _k, headers: _h, ...model }) =>
          (endpoint.has(model.api) ? { ...model, baseUrl: endpoint.get(model.api) } : model));
        return respond(true, models.length ? { ok: true, models } : { ok: false });
      }
      respond(true, { ok: false });
    } catch {
      respond(true, { ok: false }); // never engine text: a hook error could carry the key
    }
  }, { scope: 'operator.admin' });
}
