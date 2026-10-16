// ServiceError (docs/service-kit.md 6): one error class, a code, optional detail and cause.
export type ServiceErrorCode = 'unsupported' | 'bad-name' | 'bad-bin' | 'missing-bin' | 'linger' | 'provider';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  readonly detail: Readonly<Record<string, string>>;
  constructor(code: ServiceErrorCode, message: string, o: { detail?: Record<string, string>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'ServiceError';
    this.code = code;
    this.detail = o.detail ?? {};
  }
}
