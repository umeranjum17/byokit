import type { CaptureErrorCode } from './types.ts';

/** Every rejection from the kit (docs/capability-kits.md 5.2). `errorWords(e)` gives the sentence a person sees. */
export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  /** needs-update only: which side is older. */
  readonly why?: 'recorder' | 'app';
  /** The recorder's hint, for logs; never shown as words. */
  readonly hint?: string;
  /** preflight-refused: { planned, cap }; failed: { recorderCode, stderrTail }. */
  readonly detail?: Record<string, unknown>;
  constructor(
    code: CaptureErrorCode,
    message: string,
    o: { why?: 'recorder' | 'app'; hint?: string; detail?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
    if (o.why !== undefined) this.why = o.why;
    if (o.hint !== undefined) this.hint = o.hint;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}
