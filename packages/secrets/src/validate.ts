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
  // Count UTF-8 bytes without Buffer or a TextEncoder polyfill on React Native.
  let bytes = 0;
  for (const character of secret) {
    const point = character.codePointAt(0)!;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes > MAX_SECRET_BYTES) throw new KeystoreError('invalid', 'keystore secret is larger than 1 MiB');
  }
}
