// Every sentence a person can see, in one file other languages can read too (words.json, table 6.9). Plain words
// only: no commands, paths, model ids or error codes (docs/runtime-kits.md 4.3); H8's words test holds the line.
import WORDS from './words.json' with { type: 'json' };
import type { AgentStatus, HerdrState } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const PHASE_KEY: Record<Exclude<HerdrState['phase'], 'stopped'>, WordKey> = {
  connecting: 'herdr.connecting', ready: 'herdr.ready', reconnecting: 'herdr.reconnecting',
  'needs-update': 'herdr.needsUpdate', missing: 'herdr.missing', failed: 'herdr.failed',
};

/** The sentence for a kit state; a stopped kit has nothing to say yet. */
export const stateWords = (s: HerdrState): string => (s.phase === 'stopped' ? '' : words(PHASE_KEY[s.phase]));

const STATUS_KEY: Record<AgentStatus | 'starting', WordKey> = {
  starting: 'agent.starting', idle: 'agent.idle', working: 'agent.working',
  blocked: 'agent.blocked', done: 'agent.done', unknown: 'agent.unknown',
};

/** The sentence for an agent's status. */
export const agentWords = (s: AgentStatus | 'starting'): string => words(STATUS_KEY[s]);
