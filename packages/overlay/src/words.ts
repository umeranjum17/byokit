// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 7.7). Plain words only, and no claim about where data goes (D-O).
import WORDS from './words.json' with { type: 'json' };
import type { OverlayState } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const STATE_KEY: Record<OverlayState, WordKey> = {
  on: 'overlay.on', off: 'overlay.off', stuck: 'overlay.stuck', 'needs-permission': 'overlay.needsPermission',
  unsupported: 'overlay.unsupported',
};

/** The sentence for a state. On Android 13+ sideloaded installs the app adds `overlay.restricted` under `needs-permission`. */
export const stateWords = (s: OverlayState): string => words(STATE_KEY[s]);
