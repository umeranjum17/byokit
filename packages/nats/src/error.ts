export type NatsErrorCode = 'unsupported-platform' | 'download-failed' | 'checksum-failed' | 'unpack-failed' | 'port-taken' | 'start-failed' | 'closed';

export class NatsError extends Error {
  readonly code: NatsErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: NatsErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'NatsError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}
