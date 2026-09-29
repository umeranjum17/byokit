// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 5.6). Plain words only; never a recorder's name, a path or a key.
import WORDS from './words.json' with { type: 'json' };
import type { CaptureError } from './errors.ts';
import type { RecordEvent } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** The sentence for a recording event. Lands in BK-C2. */
export function eventWords(e: RecordEvent): string {
  void e;
  throw new Error('not built: BK-C2');
}

/** The sentence for a rejection. Lands in BK-C2. */
export function errorWords(e: CaptureError): string {
  void e;
  throw new Error('not built: BK-C2');
}
