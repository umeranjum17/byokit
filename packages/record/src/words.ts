// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 5.6). Plain words only; never a recorder's name, a path or a key.
import WORDS from './words.json' with { type: 'json' };
import type { CaptureError } from './errors.ts';
import type { CaptureErrorCode, RecordEvent } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };

/** A sentence with its `{slots}` filled; an unfilled slot stays visible. */
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const EVENT_WORDS: Record<RecordEvent['event'], WordKey> = {
  'consent-pending': 'capture.consentPending',
  recording: 'capture.recording',
  done: 'capture.done',
};

const ERROR_WORDS: Record<Exclude<CaptureErrorCode, 'needs-update'>, WordKey> = {
  missing: 'capture.missing',
  unsupported: 'capture.unsupported',
  'consent-cancelled': 'capture.consentCancelled',
  'consent-timeout': 'capture.consentTimeout',
  stopped: 'capture.stopped',
  'already-recording': 'capture.busy',
  'preflight-refused': 'capture.overLimit',
  'take-input': 'capture.takeMissing',
  'render-failed': 'capture.renderFailed',
  timeout: 'capture.timeout',
  invalid: 'capture.failed',
  'too-much-output': 'capture.failed',
  protocol: 'capture.failed',
  failed: 'capture.failed',
};

/** The sentence for a recording event. */
export function eventWords(e: RecordEvent): string {
  return words(EVENT_WORDS[e.event]);
}

/** The sentence for a rejection; `needs-update` names the older side (`recorder` when unknown). */
export function errorWords(e: CaptureError): string {
  if (e.code === 'needs-update') return words(e.why === 'app' ? 'capture.needsUpdate.app' : 'capture.needsUpdate.recorder');
  return words(ERROR_WORDS[e.code] ?? 'capture.failed');
}
