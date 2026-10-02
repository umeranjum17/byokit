import data from './words.json' with { type: 'json' };
import type { ShareErrorCode } from './types.ts';
export const words = data;
export class ShareError extends Error {
  readonly code: ShareErrorCode;
  constructor(code: ShareErrorCode) {
    super(words[code === 'invalid_share_url' ? 'share.invalid_link' : `share.${code}`]);
    this.name = 'ShareError';
    this.code = code;
  }
}
