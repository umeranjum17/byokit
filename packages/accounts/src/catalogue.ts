import CATALOGUE from './catalogue.json' with { type: 'json' };
import ROUTES from './routes.json' with { type: 'json' };

/** How the person pays. Only subscription billing is eligible for default selection. */
export type Billing = 'subscription' | 'api' | 'local' | 'free' | 'unknown';
/** Route vocabulary is additive; legacy account `Via` values stay unchanged. */
export type RouteVia = 'browser' | 'code' | 'paste' | 'key' | 'session' | 'setup_token' | 'cli' | 'plan_key' | 'cloud' | 'local' | 'endpoint';
export type Support = 'yes' | 'host' | 'no';
export type Readiness = 'ready' | 'needs_binary' | 'needs_plugin' | 'needs_host' | 'needs_client' | 'unsupported_platform' | 'no_upstream_flow';
export type Route = {
  id: string; provider: string; name: string; company: string; label: string; aliases?: string[];
  via: RouteVia; billing: Billing; billingFrom: 'source' | 'host'; offer: 'default' | 'explicit';
  platforms: { node: Support; browser: Support; rn: Support };
  needs?: { binary?: string; plugin?: string; client?: string };
  upstream: { surface: 'accounts' | 'openclaw' | 'herdr'; id: string; method?: string; revision: string; flow: 'present' | 'absent' };
};
export type RouteView = Route & { readiness: Readiness; why?: string };
/** hostSide means the app supplies the required route driver/forwarder, not merely that it runs on a computer. */
export type RouteHost = { platform: 'node' | 'browser' | 'rn'; hostSide?: boolean; binaries?: readonly string[]; plugins?: readonly string[]; clients?: readonly string[] };

/** Availability from pinned method/platform support and app-supplied host facts.
 *  Missing account adapters require host support; readiness is never live qualification.
 *  No credentials, environment inspection or live requests are involved. */
export function routeReadiness(r: Route, host: RouteHost): RouteView {
  let readiness: Readiness = 'ready';
  if (r.upstream.flow === 'absent') readiness = 'no_upstream_flow';
  else if (r.platforms[host.platform] === 'no') readiness = 'unsupported_platform';
  else if (r.platforms[host.platform] === 'host' && !host.hostSide) readiness = 'needs_host';
  else if (r.needs?.binary && !host.binaries?.includes(r.needs.binary)) readiness = 'needs_binary';
  else if (r.needs?.plugin && !host.plugins?.includes(r.needs.plugin)) readiness = 'needs_plugin';
  else if (r.needs?.client && !host.clients?.includes(r.needs.client)) readiness = 'needs_client';
  const why: Record<Exclude<Readiness, 'ready'>, string> = {
    no_upstream_flow: 'This sign-in method is not in the pinned upstream.',
    unsupported_platform: 'This sign-in method is not available on this platform.',
    needs_host: "This sign-in method needs the app's host side.",
    needs_binary: 'This sign-in method needs its program installed.',
    needs_plugin: 'This sign-in method needs its provider plugin installed.',
    needs_client: 'This sign-in method needs a client registration.',
  };
  return { ...r, readiness, ...(readiness === 'ready' ? {} : { why: why[readiness] }) };
}

/** Every pinned method, unavailable ones included; dependent host adapters are not assumed installed. */
export const routes = (host: RouteHost = { platform: 'node' }): RouteView[] => (ROUTES as Route[]).map((r) => routeReadiness(r, host));
export function route(id: string, host: RouteHost = { platform: 'node' }): RouteView {
  const r = routes(host).find((r) => r.id === id);
  if (!r) throw Object.assign(new Error('no such AI account route'), { status: 404 });
  return r;
}
/** Terms assessment for choosing between several accounts; descriptive, never an eligibility gate. */
export type MultiAccountTerms = { terms: 'allowed' | 'grey' | 'partner' | 'forbidden'; why: string; source: string };
/** `callbackPort`: where the provider sends the browser back after its own sign-in page, fixed for the client Pi signs in as.
 *  `revoke`: where signing out ends the sign-in on the provider's side too, for the client `clientId`. */
export type Provider = { key: string; pi: string; name: string; company: string; models: { strong: string; fast?: string }; fresh?: { param: string; value: string }; callbackPort?: number; clientId?: string; revoke?: string; billing: 'subscription' | 'api'; auth?: 'api-key' | 'oauth'; label?: string; offer?: boolean; readiness?: Readiness; routes?: string[]; source: string; multiAccount: MultiAccountTerms };

export const PROVIDERS: Record<string, Provider> = Object.fromEntries(Object.entries(CATALOGUE).map(([key, p]) => [key, { key, ...p } as Provider]));

export function provider(key: string) {
  const p = PROVIDERS[key];
  if (!p) throw Object.assign(new Error('no such AI account'), { status: 404 });
  return p;
}

/** Legacy no-argument/key-list calls keep Provider identities; dead defaults are omitted.
 *  Pass host facts to get all ready subscription routes, including plan keys.
 *  Non-subscription routes are discoverable, never auto-selected. */
export function offered(host: RouteHost): RouteView[];
export function offered(keys?: readonly string[]): Provider[];
export function offered(input?: readonly string[] | RouteHost): Provider[] | RouteView[] {
  if (input && 'platform' in input) return routes(input).filter((r) => r.offer === 'default' && r.readiness === 'ready');
  if (input) return input.map(provider);
  return Object.values(PROVIDERS).filter((p) => p.billing === 'subscription' && p.offer !== false && (!p.readiness || p.readiness === 'ready'));
}
