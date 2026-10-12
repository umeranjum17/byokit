// Account-plan misuse as decided code, without importing @byokit/accounts at runtime: that kit stays an
// optional peer a rules/answerer/Jev tool never installs. `code` is the cross-package identity both kits
// document; `instanceof` against this class also matches the accounts kit's own error, so catching the
// export this module backs keeps working whatever threw it.
export class UnsupportedAccountError extends Error {
  readonly code = 'unsupported_account';
  constructor(message: string) { super(message); this.name = 'UnsupportedAccountError'; }
  static [Symbol.hasInstance](value: unknown): boolean {
    return (typeof value === 'object' && value !== null &&
      (value as { code?: unknown }).code === 'unsupported_account' &&
      (value as { name?: unknown }).name === 'UnsupportedAccountError') ||
      Function.prototype[Symbol.hasInstance].call(this, value);
  }
}
