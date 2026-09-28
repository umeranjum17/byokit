// Route labels: data, not code (D12). One entry per auth choice in the pinned tarball's provider contracts (O6).
import type { Route } from './types.ts';

export function routes(): Route[] {
  throw new Error('not built: O6');
}

export function routeFor(provider: string, via: 'browser' | 'code'): Route | undefined {
  throw new Error('not built: O6');
}
