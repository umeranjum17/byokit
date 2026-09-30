import type { ComposeErrorCode } from './types.ts';

/** Every rejection from the kit (docs/capability-kits.md 4.3). `errorWords(e)` gives the sentence a person sees. */
export class ComposeError extends Error {
  readonly code: ComposeErrorCode;
  /** engine: { engineCode }, needs-update: { protocol }. */
  readonly detail?: Record<string, unknown>;
  constructor(code: ComposeErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = 'ComposeError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}
