// The atomic 0700/0600 writer lifted from packages/accounts/src/node-stores.ts:13-23 and exported (R6):
// an app's own credential file gets the same durability without depending on accounts.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { KeystoreError } from './errors.ts';

export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new KeystoreError('invalid', 'keystore file path must be absolute');
  if (typeof data !== 'string' && !(data instanceof Uint8Array)) throw new KeystoreError('invalid', 'keystore file data must be a string or bytes');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(`${path}.tmp`, data, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
