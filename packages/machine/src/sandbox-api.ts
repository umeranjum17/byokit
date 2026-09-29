// Sandbox API adapter (docs/machine-kit.md section 6). M1 stub: signature frozen, body lands in M4.
import type { Price, Provider } from './types.ts';

export function sandboxApi(o: {
  baseUrl: string; label: string; prices: readonly Price[]; key: () => Promise<string>; fetch?: typeof fetch
}): Provider {
  void o;
  throw new Error('not built: M4');
}
