// Node/desktop only. Native APIs keep secrets out of child argv and environments.
import { createRequire } from 'node:module';
import { KeystoreError } from './errors.ts';
import type { Keystore } from './types.ts';
import { assertName, assertSecret } from './validate.ts';

/** Synchronous seam required by accounts' sealing adapter. Missing entries are null. */
export interface KeyringBackend {
  get(name: string): string | null;
  set(name: string, secret: string): void;
  delete(name: string): boolean;
}

export interface KeyringEntry {
  getPassword(): string | null;
  setPassword(secret: string): void;
  deleteCredential(): boolean;
}

export type OSKeyringOptions = {
  service: string;
  /** Fake-only injection; the native binding is loaded lazily otherwise. */
  entry?: (service: string, name: string, options: { linux: { store: 'secret-service' } }) => KeyringEntry;
};

const require = createRequire(import.meta.url);
const OPTIONS = { linux: { store: 'secret-service' as const } };

/** Native Keychain / Credential Manager / Secret Service. No kernel-keyring fallback. */
export function osKeyring(o: OSKeyringOptions): KeyringBackend {
  assertName(o?.service, 'service');
  const service = o.service;
  let factory = o.entry;
  const call = <T>(name: string, operation: (entry: KeyringEntry) => T): T => {
    assertName(name);
    if (!factory && !['linux', 'darwin', 'win32'].includes(process.platform)) {
      throw new KeystoreError('unsupported', 'the native OS keyring is unsupported on this platform');
    }
    try {
      if (!factory) {
        const { Entry } = require('@napi-rs/keyring') as typeof import('@napi-rs/keyring');
        factory = (service, name, options) => new Entry(service, name, options);
      }
      return operation(factory(service, name, OPTIONS));
    } catch {
      // Native error chains can include platform data. Do not expose them or attach a cause.
      throw new KeystoreError('unavailable', 'No OS keyring is available or accessible');
    }
  };
  return {
    get: (name) => call(name, (entry) => entry.getPassword()),
    set(name, secret) {
      assertSecret(secret);
      call(name, (entry) => entry.setPassword(secret));
    },
    delete: (name) => call(name, (entry) => entry.deleteCredential()),
  };
}

/** The same native backend through the kit's async get/set/delete interface. */
export function osKeyringStore(o: OSKeyringOptions): Keystore {
  const ring = osKeyring(o);
  return {
    async get(name) { return ring.get(name); },
    async set(name, secret) { ring.set(name, secret); },
    async delete(name) { return ring.delete(name); },
  };
}
