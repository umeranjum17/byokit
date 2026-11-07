// Person-facing sentences for the bus. UI code shows these; it never builds a sentence from a code
// (docs/kit-conventions.md §9).
import WORDS from './words.json' with { type: 'json' };
import type { NatsError } from './error.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

const KEYS = {
  'unsupported-platform': 'nats.unsupportedPlatform', 'download-failed': 'nats.downloadFailed', 'checksum-failed': 'nats.checksumFailed',
  'unpack-failed': 'nats.unpackFailed', 'port-taken': 'nats.portTaken', 'start-failed': 'nats.startFailed', closed: 'nats.closed',
} as const satisfies Record<NatsError['code'], WordKey>;

/** The sentence for a failed call. */
export const errorWords = (e: Pick<NatsError, 'code'>): string => words(KEYS[e.code]);
