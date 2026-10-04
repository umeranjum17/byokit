import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import { ConnectError } from './errors.ts';
import { endpoint, json, request, strings } from './http.ts';
import type { OAuthEndpoints, Provider } from './types.ts';
export interface Discovered { endpoints: OAuthEndpoints; scopes: readonly string[]; resource?: string }
export async function discover(provider: Provider, fetcher: typeof fetch, timeout: number): Promise<Discovered> {
  if (provider.oauth) {
    for (const url of [provider.oauth.authorize, provider.oauth.token, provider.oauth.register].filter((x): x is string => !!x)) endpoint(url);
    return { endpoints: provider.oauth, scopes: provider.scopes ?? [], resource: provider.mcpUrl };
  }
  let issuer = provider.issuer;
  let resource: string | undefined;
  let scopes = provider.scopes;
  if (provider.mcpUrl) {
    const server = endpoint(provider.mcpUrl);
    // RFC 9728: use the 401 challenge when present, otherwise well-known path then origin.
    const probe = await request(fetcher, server, { headers: { accept: 'application/json, text/event-stream' } }, timeout);
    const challenge = probe.headers.get('www-authenticate');
    await probe.body?.cancel();
    const advertised = challenge?.match(/resource_metadata\s*=\s*"([^"]+)"/i)?.[1];
    const candidates = advertised ? [advertised] : [...new Set([`${server.origin}/.well-known/oauth-protected-resource${server.pathname === '/' ? '' : server.pathname}`, `${server.origin}/.well-known/oauth-protected-resource`])];
    let metadata: Record<string, unknown> | undefined;
    for (const url of candidates) {
      const response = await request(fetcher, url, {}, timeout);
      if (response.status === 404 && !advertised) { await response.body?.cancel(); continue; }
      if (!response.ok) throw new ConnectError('discovery', response.status);
      metadata = await json(response, 'discovery'); break;
    }
    if (!metadata || typeof metadata.resource !== 'string' || !strings(metadata.authorization_servers) || metadata.authorization_servers.length === 0) throw new ConnectError('discovery');
    const canonical = endpoint(metadata.resource).href;
    if (!checkResourceAllowed({ requestedResource: server, configuredResource: canonical })) throw new ConnectError('discovery');
    resource = metadata.resource;
    if (issuer && !metadata.authorization_servers.includes(issuer)) throw new ConnectError('discovery');
    issuer ??= metadata.authorization_servers[0];
    if (!scopes && strings(metadata.scopes_supported)) scopes = metadata.scopes_supported;
  }
  if (!issuer) throw new ConnectError('configuration');
  const base = endpoint(issuer);
  const response = await request(fetcher, `${base.origin}/.well-known/oauth-authorization-server${base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')}`, {}, timeout);
  if (!response.ok) throw new ConnectError('discovery', response.status);
  const m = await json(response, 'discovery');
  if (m.issuer !== issuer || typeof m.authorization_endpoint !== 'string' || typeof m.token_endpoint !== 'string' || (m.code_challenge_methods_supported !== undefined && (!strings(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes('S256')))) throw new ConnectError('discovery');
  for (const raw of [m.authorization_endpoint, m.token_endpoint, m.registration_endpoint].filter((x): x is string => typeof x === 'string')) endpoint(raw);
  return { endpoints: { authorize: m.authorization_endpoint, token: m.token_endpoint, register: typeof m.registration_endpoint === 'string' ? m.registration_endpoint : undefined, issuer }, scopes: scopes ?? (strings(m.scopes_supported) ? m.scopes_supported : []), resource };
}
