// Complete pinned discovery. No credential reads, plugin installation or live qualification.
import routesJson from './routes.json' with { type: 'json' };
import type { Route } from './types.ts';

const table = routesJson as Route[];
export type RouteFacts = {
  platform?: 'node' | 'browser' | 'rn';
  host?: boolean;
  binaries?: readonly string[];
  plugins?: readonly string[];
  clients?: readonly string[];
};
export type RouteView = Route & { readiness: NonNullable<Route['readiness']> };

/** Every choice, including external dependencies and providers without a wizard choice.
 * `offerPolicy` is eligibility; legacy boolean `offer` additionally requires readiness.
 * No facts means the kit's Node host with bundled plugins, not installed external plugins or CLIs.
 * External installs belong to the explicit host operation; discovery never performs one.
 */
export function routes(facts: RouteFacts = {}): RouteView[] {
  const platform = facts.platform ?? 'node';
  return table.map(route => {
    let readiness: RouteView['readiness'] = 'ready';
    let why: string | undefined;
    if (route.upstream?.flow === 'absent') {
      readiness = 'no_upstream_flow'; why = route.reason;
    } else if (route.platforms?.[platform] === 'no') {
      readiness = 'unsupported_platform'; why = `Not supported on ${platform}.`;
    } else if (route.platforms?.[platform] === 'host' && !facts.host) {
      readiness = 'needs_host'; why = 'Needs the linked engine host.';
    } else if (route.needs?.binary && !facts.binaries?.includes(route.needs.binary)) {
      readiness = 'needs_binary'; why = `Needs ${route.needs.binary} in the isolated HOME.`;
    } else if (route.needs?.plugin && !facts.plugins?.includes(route.needs.plugin)) {
      readiness = 'needs_plugin'; why = `Needs plugin ${route.needs.plugin}; discovery does not install it.`;
    } else if (route.needs?.client && !facts.clients?.includes(route.needs.client)) {
      readiness = 'needs_client'; why = `Needs host client registration ${route.needs.client}.`;
    }
    return { ...route, readiness, ...(why ? { why } : {}),
      offer: route.offerPolicy === 'default' && route.billing === 'subscription' && readiness === 'ready' };
  });
}

/** Retain explicit legacy selectors alongside corrected discovery metadata. A native CLI selector still
 * reaches engine detection (which checks its own login); it does not make an unavailable route default.
 * API billing is never picked as a fallback. */
export function routeFor(provider: string, via: 'browser' | 'code'): Route | undefined {
  return table.find(route => route.billing === 'subscription' && route.offerPolicy === 'default'
    && ((route.offer && route.provider === provider && route.via === via)
      || (route.legacy?.provider === provider && route.legacy.via === via)));
}
