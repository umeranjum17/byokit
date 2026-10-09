// Every sentence a person can see, in one file other languages can read too (5.14). Plain words only (4.3).
import wordsJson from './words.json' with { type: 'json' };
import type { KitState, SignInView } from './types.ts';

/** ui-core's AccountView shape, declared locally so this module stays dependency-free (5.14). */
export type AccountView = { ready?: boolean; work?: string | boolean; signIn?: SignInView | null };

export type WordKey = Extract<keyof typeof wordsJson, string>;

export function words(key: WordKey, vars?: Record<string, string>): string {
  let sentence: string = wordsJson[key];
  if (vars) for (const [name, value] of Object.entries(vars)) sentence = sentence.replaceAll(`{${name}}`, value);
  return sentence;
}

const PHASE_WORDS: Record<Exclude<KitState['phase'], 'stopped'>, WordKey> = {
  installing: 'engine.installing',
  starting: 'engine.starting',
  repairing: 'engine.repairing',
  ready: 'engine.ready',
  restarting: 'engine.restarting',
  failed: 'engine.failed',
  locked: 'engine.locked',
  'needs-update': 'engine.needsUpdate',
};

const MiB = 1024 * 1024;

export function stateWords(s: KitState): string {
  // 'stopped' is never on screen (4.3 covers what a person can see), so 5.14 has no row for it.
  if (s.phase === 'failed' && s.why === 'engine-already-running') return words('engine.alreadyRunning');
  if (s.why === 'auth-store-unreadable') return words('engine.authStoreUnreadable');
  if (s.why === 'auth-store-seal-size' && s.sealSize) return words('engine.authStoreSealSize', { size: String(Math.ceil(s.sealSize.size / MiB)), limit: String(s.sealSize.cap / MiB) });
  if (s.why === 'sign-in-reset') return words('engine.signInAgain');
  return s.phase === 'stopped' ? '' : words(PHASE_WORDS[s.phase]);
}

export function toAccountView(view: SignInView | null, ready: boolean): AccountView {
  // `why` maps 1:1; ui-core's phaseOf reads busy/declined/expired itself (5.14).
  return { ready, signIn: view };
}
