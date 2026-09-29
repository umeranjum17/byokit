import { KeystoreError } from './errors.ts';

const MAX_NAME = 256;
const MAX_SECRET_BYTES = 1024 * 1024;

/** Names (and the keyring service) travel in CLI argv, so they must be small and NUL-free. */
export function assertName(name: string, what = 'name'): void {
  if (typeof name !== 'string' || name.length === 0) throw new KeystoreError('invalid', `keystore ${what} must be a non-empty string`);
  if (name.length > MAX_NAME) throw new KeystoreError('invalid', `keystore ${what} is longer than ${MAX_NAME} characters`);
  if (name.includes('\0')) throw new KeystoreError('invalid', `keystore ${what} must not contain NUL`);
}

/** Secrets travel on stdin, so NUL is allowed; the size cap bounds what a keyring CLI must swallow. */
export function assertSecret(secret: string): void {
  if (typeof secret !== 'string') throw new KeystoreError('invalid', 'keystore secret must be a string');
  if (Buffer.byteLength(secret, 'utf8') > MAX_SECRET_BYTES) throw new KeystoreError('invalid', 'keystore secret is larger than 1 MiB');
}
