// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 12.7). Plain words only.
import WORDS from './words.json' with { type: 'json' };
import type { StatusState } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const STATE_KEY: Record<StatusState, WordKey> = {
  on: 'status.on', off: 'status.off', 'needs-permission': 'status.needsPermission', unsupported: 'status.unsupported',
};

/** The sentence for a state. */
export const stateWords = (s: StatusState): string => words(STATE_KEY[s]);
