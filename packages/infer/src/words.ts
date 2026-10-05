import WORDS from './words.json' with { type: 'json' };
import type { InferError, InferState } from './types.ts';
import type { PaneSummary } from './summary.ts';
import type { InferLocalBackend } from './backend.ts';
export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const STATE: Record<InferState['phase'], WordKey | undefined> = {
  unsupported: 'infer.unsupported', 'not-installed': 'infer.notInstalled', installing: 'infer.installing',
  installed: 'infer.installed', loading: 'infer.loading', ready: 'infer.ready', busy: undefined, failed: 'infer.failed',
};
// Nano's download belongs to Android, so its states never ask the person to download anything.
const NANO: Partial<Record<InferState['phase'], WordKey>> = {
  unsupported: 'infer.nanoUnsupported', 'not-installed': 'infer.nanoNotReady', installing: 'infer.nanoNotReady', failed: 'infer.nanoFailed',
};
/** `nano: true` for a NanoModel's state. */
export function stateWords(s: InferState, o: { nano?: boolean } = {}): string {
  const key = (o.nano && NANO[s.phase]) || STATE[s.phase];
  const percent = s.total ? String(Math.floor(((s.received ?? 0) / s.total) * 100)) : '0';
  return key ? words(key, { percent }) : '';
}
const ERROR: Record<InferError['code'], WordKey> = {
  unsupported: 'infer.unsupported', 'not-installed': 'infer.notInstalled', invalid: 'infer.invalid', integrity: 'infer.integrity',
  'no-space': 'infer.noSpace', network: 'infer.network', busy: 'infer.busy', 'too-large': 'infer.tooLarge',
  incomplete: 'infer.incomplete', failed: 'infer.failed',
};
const NANO_ERROR: Partial<Record<InferError['code'], WordKey>> = { 'not-installed': 'infer.nanoNotReady', unsupported: 'infer.nanoUnsupported', failed: 'infer.nanoFailed' };
/** `nano: true` for an error from a NanoModel. */
export const errorWords = (e: InferError, o: { nano?: boolean } = {}): string => words((o.nano && NANO_ERROR[e.code]) || ERROR[e.code]);
export const summaryWords = (code: Extract<PaneSummary, { ok: false }>['code']): string =>
  words(code === 'not-enough-output' ? 'infer.notEnough' : code === 'incomplete' ? 'infer.incomplete' : 'infer.unusable');
/** Which model on this phone answers, for the person. */
export const whereWords = (b: InferLocalBackend): string => words(b.name === 'on-device-nano' ? 'infer.whereNano' : 'infer.whereGguf');
