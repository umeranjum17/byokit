import WORDS from './words.json' with { type: 'json' };
export { WORDS };
export type WordKey = keyof typeof WORDS;
export function words(key: WordKey): string { return WORDS[key]; }
export function stateWords(state: { phase: 'connecting' | 'connected' | 'thinking' | 'speaking' | 'closed' }): string { return words(`realtime.${state.phase}`); }
export function errorWords(_error: unknown): string { return words('realtime.error'); }
