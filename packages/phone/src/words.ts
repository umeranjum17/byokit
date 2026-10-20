// Person-facing sentences for a phone session. UI code shows these; it never builds a sentence from a code
// (docs/kit-conventions.md §9).
import WORDS from './words.json' with { type: 'json' };
import type { PhoneError } from './session.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const KEYS = {
  busy: 'phone.busy', 'cut-short': 'phone.cutShort', failed: 'phone.failed', network: 'phone.network',
  'not-included': 'phone.notIncluded', 'out-of-credit': 'phone.outOfCredit', 'rate-limited': 'phone.rateLimited',
  resting: 'phone.resting', 'signed-out': 'phone.signedOut', 'step-limit': 'phone.stepLimit',
} as const satisfies Record<PhoneError['code'], WordKey>;

/** The sentence for a failed turn or call. */
export const errorWords = (error: Pick<PhoneError, 'code'>): string => words(KEYS[error.code]);
