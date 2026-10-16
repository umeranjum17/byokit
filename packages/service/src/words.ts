// Every sentence a person can see (docs/service-kit.md 6), in one file other languages can read too.
// No sentence claims the host comes back after a restart or sign-out (S7).
import WORDS from './words.json' with { type: 'json' };
import type { ServiceError } from './errors.ts';
import type { ServiceState } from './index.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const STATE_KEY: Record<ServiceState['phase'], WordKey> = {
  running: 'service.running', stopped: 'service.stopped', 'not-installed': 'service.notInstalled',
  failed: 'service.failed', unsupported: 'service.unsupported',
};

/** The sentence for a service state. */
export const stateWords = (s: ServiceState, vars: { app: string }): string => words(STATE_KEY[s.phase], vars);

/** The sentence for a kit failure; `linger` asks for the one line in `detail.command`. */
export const errorWords = (e: ServiceError, vars: { app: string }): string =>
  words(e.code === 'linger' ? 'service.linger' : e.code === 'unsupported' ? 'service.unsupported' : 'service.failed', vars);
