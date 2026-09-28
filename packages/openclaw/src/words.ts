// Every sentence a person can see, in one file other languages can read too (5.14). Plain words only (4.3).
// Filled in O10.
import wordsJson from './words.json' with { type: 'json' };
import type { KitState, SignInView } from './types.ts';

/** ui-core's AccountView shape, declared locally so this module stays dependency-free (5.14). */
export type AccountView = { ready?: boolean; work?: string | boolean; signIn?: SignInView | null };

export type WordKey = Extract<keyof typeof wordsJson, string>;

export function words(key: WordKey, vars?: Record<string, string>): string {
  throw new Error('not built: O10');
}

export function stateWords(s: KitState): string {
  throw new Error('not built: O10');
}

export function toAccountView(view: SignInView | null, ready: boolean): AccountView {
  throw new Error('not built: O10');
}
