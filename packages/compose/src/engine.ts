// The two ways to reach the pinned engine (docs/capability-kits.md 4.5, D-H): in process (the default) or through
// the engine's own bin as a separate process. Bodies land in BK-P2 with the pin.
import type { Engine } from './types.ts';

/** Lazily imports ENGINE_PACKAGE on the first request; a missing package rejects `missing`. */
export function inProcessEngine(): Engine {
  throw new Error('not built: BK-P2');
}

/** Runs the engine's bin (absolute path) per request with env { PATH, LANG } only; timeout default 10 s. */
export function binEngine(o: { bin: string; timeoutMs?: number }): Engine {
  void o;
  throw new Error('not built: BK-P2');
}
