// Every sentence a person can see, in one file other languages can read too (words.json, docs/capability-kits.md
// 14.11), with the kit's error class (kit-conventions §3, §9). Plain words only.
import WORDS from './words.json' with { type: 'json' };
import type { ShareErrorCode } from './types.ts';

export type WordKey = keyof typeof WORDS;
export { WORDS };
export const words = (key: WordKey, vars: Record<string, string> = {}): string =>
  WORDS[key].replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

/** `code` picks the words (`errorWords`); `message` is for logs only. */
export class ShareError extends Error {
  readonly code: ShareErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: ShareErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'ShareError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

const ERROR_KEY: Record<ShareErrorCode, WordKey> = {
  unreadable: 'share.unreadable', partial: 'share.partial', failed: 'share.failed', invalid_share_url: 'share.invalid_link',
};

/** The sentence for a share error; its code picks it, one to one. */
export const errorWords = (e: Pick<ShareError, 'code'>): string => words(ERROR_KEY[e.code]);
