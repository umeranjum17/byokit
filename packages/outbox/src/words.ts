// Person-facing sentences for the outbox, and the helpers that pick them. UI code shows these; it never
// builds a sentence from a code (docs/kit-conventions.md §9).
import WORDS from './words.json' with { type: 'json' };
import type { CancelResult, OutboxError, OutboxState } from './outbox.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** The sentence for a failed call. */
export function errorWords(error: OutboxError): string {
  return words(error.code === 'not-found' ? 'outbox.notFound'
    : error.code === 'stale-revision' ? 'outbox.staleRevision' : `outbox.${error.code}`);
}

/** The sentence for a cancel that was taken, that lost the race to the send, or whose send is unknown. */
export function cancelWords(result: CancelResult): string {
  return words(result.ok ? 'outbox.cancelled' : result.code === 'unknown' ? 'outbox.unknown' : 'outbox.tooLate');
}

/** The sentence for where one message stands; '' when there is nothing to say. */
export function stateWords(state: OutboxState): string {
  return state === 'queued' ? '' : words(state === 'sending' ? 'outbox.sending'
    : state === 'cancelled' ? 'outbox.cancelled'
    : state === 'failed' ? 'outbox.failed' : 'outbox.sent');
}
