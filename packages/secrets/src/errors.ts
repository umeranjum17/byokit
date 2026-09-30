// One secret per name. Errors never carry a secret: messages name the entry, never its value.
export type KeystoreErrorCode = 'invalid' | 'auth-failed' | 'keyring-locked' | 'unsupported' | 'unavailable' | 'failed';

export class KeystoreError extends Error {
  readonly code: KeystoreErrorCode;
  constructor(code: KeystoreErrorCode, message: string) {
    super(message);
    this.name = 'KeystoreError';
    this.code = code;
  }
}
