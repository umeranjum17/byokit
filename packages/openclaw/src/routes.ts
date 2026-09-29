// Route labels: data, not code (D12). One entry per auth choice in the pinned tarball's provider contracts (O6).
import routesJson from './routes.json' with { type: 'json' };
import type { Route } from './types.ts';

const table = routesJson as Route[];

/** The pin's auth-choice table. `provider` is the id a person's account is known by (the doc's matrix), which for
 *  MiniMax's portal routes is the account-visible `minimax`, not the wizard's internal `minimax-portal`. `plugin` is
 *  the bundled plugin the app must allow for that route to start (5.6). Only the pin's bundled provider contracts are
 *  listed: install-catalog plugins (external providers needing their own install) are not contracted by the pin and
 *  are deliberately absent. */
export function routes(): Route[] {
  return table;
}

/** The route an app should use: only an offered route counts, so an Anthropic fallback can never be picked. */
export function routeFor(provider: string, via: 'browser' | 'code'): Route | undefined {
  return table.find((route) => route.offer && route.provider === provider && route.via === via);
}
