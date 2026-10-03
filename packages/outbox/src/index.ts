// @byokit/outbox: a durable outbound queue whose messages can be taken back until the send, and whose
// cancellations never claim more than they did. Node host side; the store is one fsynced JSON file.
export { Outbox, OutboxError } from './outbox.ts';
export type { OutboxState, OutboxErrorCode, OutboxEntry, OutboxSendJob, OutboxSender, OutboxOptions, CancelResult, FlushResult } from './outbox.ts';
export { WORDS, words, errorWords, cancelWords, stateWords } from './words.ts';
export type { WordKey } from './words.ts';
