// The CI override: the host passes the map (built from process.env itself when it wants to).
// The kit never reads process.env; this backend is a validated in-memory copy.
import { KeystoreError } from './errors.ts';
import type { Keystore } from './types.ts';
import { assertName, assertSecret } from './validate.ts';

export function overrideStore(entries: Record<string, string>): Keystore {
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
    throw new KeystoreError('invalid', 'keystore override entries must be a record of strings');
  }
  const data = new Map<string, string>();
  for (const [name, secret] of Object.entries(entries)) {
    assertName(name);
    assertSecret(secret);
    data.set(name, secret);
  }
  return {
    async get(name: string): Promise<string | null> {
      assertName(name);
      return data.has(name) ? data.get(name)! : null;
    },
    async set(name: string, secret: string): Promise<void> {
      assertName(name);
      assertSecret(secret);
      data.set(name, secret);
    },
    async delete(name: string): Promise<boolean> {
      assertName(name);
      return data.delete(name);
    },
  };
}
