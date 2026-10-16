// Every sentence a person can see, in one file other languages can read too (words.json). Plain words only: no codes,
// commands, paths, model ids or jargon a person would have to look up. The device entry imports this, so it holds no
// Node dependency and runs in browsers and React Native as well.
import WORDS from './words.json' with { type: 'json' };

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** The sentence for a key, with no slots to fill. */
export const words = (key: WordKey): string => WORDS[key];

/** Why finding a host failed: `wrong-code` is a code the relay does not know or that has run out, `unreachable` is a
 *  relay that answered but could not resolve (or gave a forged address), and `timeout` is one that did not answer
 *  within the bound. A network failure that never reached the relay still rejects with the fetch error, as the
 *  owner client does. */
export type RelayLookupErrorCode = 'wrong-code' | 'unreachable' | 'timeout';

const LOOKUP_WORDS: Record<RelayLookupErrorCode, WordKey> = {
  'wrong-code': 'lookup.wrongCode',
  unreachable: 'lookup.unreachable',
  timeout: 'lookup.timeout',
};

/** A host lookup the relay refused or did not answer. `message` is a plain sentence with the cause and the next step;
 *  `code` is for the app to branch on. */
export class RelayLookupError extends Error {
  readonly code: RelayLookupErrorCode;

  constructor(code: RelayLookupErrorCode) {
    super(words(LOOKUP_WORDS[code]));
    this.name = 'RelayLookupError';
    this.code = code;
  }
}
