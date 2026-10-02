import WORDS from './words.json' with { type: 'json' };
import type { InferError, InferState } from './types.ts';
export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const STATE: Record<InferState['phase'], WordKey | undefined> = {
  unsupported: 'infer.unsupported', 'not-installed': 'infer.notInstalled', installing: 'infer.installing',
  installed: 'infer.installed', loading: 'infer.loading', ready: 'infer.ready', busy: undefined, failed: 'infer.failed',
};
export function stateWords(s: InferState): string {
  const key = STATE[s.phase];
  const percent = s.total ? String(Math.floor(((s.received ?? 0) / s.total) * 100)) : '0';
  return key ? words(key, { percent }) : '';
}
const ERROR: Record<InferError['code'], WordKey> = {
  unsupported: 'infer.unsupported', 'not-installed': 'infer.notInstalled', invalid: 'infer.invalid', integrity: 'infer.integrity',
  'no-space': 'infer.noSpace', network: 'infer.network', busy: 'infer.busy', 'too-large': 'infer.tooLarge',
  incomplete: 'infer.incomplete', failed: 'infer.failed',
};
export const errorWords = (e: InferError): string => words(ERROR[e.code]);
