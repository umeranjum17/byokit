// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 4.8). Plain words only, and no claim about where a draft goes (D-P).
import WORDS from './words.json' with { type: 'json' };
import type { ComposeError } from './errors.ts';
import type { DraftCheck, Platform } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const ERROR_KEY: Record<ComposeError['code'], WordKey> = {
  missing: 'compose.missing', 'needs-update': 'compose.needsUpdate', engine: 'compose.failed', invalid: 'compose.failed',
};

/** The sentence for a rejection. */
export const errorWords = (e: ComposeError): string => words(ERROR_KEY[e.code]);

/** The plain lines for one checked draft, in the 4.8 order. Lands in BK-P1. */
export function checkLines(c: DraftCheck, platform: Platform, o?: { original?: boolean }): string[] {
  void c; void platform; void o;
  throw new Error('not built: BK-P1');
}
