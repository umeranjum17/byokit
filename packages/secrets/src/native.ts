import { KeystoreError } from './errors.ts';
import type { Keystore } from './types.ts';
import { assertName, assertSecret } from './validate.ts';

/** The subset of expo-secure-store used by the adapter; hosts can inject a fake. */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

export interface SecureStoreOptions {
  keychainService?: string;
  keychainAccessible?: number;
  requireAuthentication?: boolean;
  authenticationPrompt?: string;
  accessGroup?: string;
}

export interface NativeOptions {
  /** Install expo-secure-store in the app, or supply a compatible implementation. */
  secureStore?: SecureStoreLike;
  /** Prefix for this app's entries. Defaults to byokit. */
  prefix?: string;
  /** Passed unchanged to every SecureStore call (including get and delete). */
  options?: SecureStoreOptions;
}

/** Core stays portable and testable without loading any native module. */
export function nativeStoreWith(o: NativeOptions, load: () => Promise<SecureStoreLike>): Keystore {
  const prefix = o.prefix ?? 'byokit';
  assertName(prefix, 'prefix');
  if (!/^[\w.-]+$/.test(prefix)) throw new KeystoreError('invalid', 'keystore prefix must contain only letters, digits, dots, hyphens or underscores');
  const options = o.options === undefined ? undefined : { ...o.options };
  let pending: Promise<SecureStoreLike> | undefined;
  const backend = async (): Promise<SecureStoreLike> => {
    if (o.secureStore) return o.secureStore;
    pending ??= load();
    try { return await pending; }
    catch {
      pending = undefined;
      throw new KeystoreError('unavailable', 'keystore requires expo-secure-store in the app');
    }
  };
  // Expo keys accept only [A-Za-z0-9._-]. Fixed-width UTF-16 hex is collision-free,
  // supports the shared name contract and needs no Node or encoding polyfills.
  const key = (name: string): string => {
    assertName(name);
    let encoded = '';
    for (let i = 0; i < name.length; i++) encoded += name.charCodeAt(i).toString(16).padStart(4, '0');
    return `${prefix}.${encoded}`;
  };
  const call = async <T>(operation: (store: SecureStoreLike) => Promise<T>): Promise<T> => {
    const store = await backend();
    try { return await operation(store); }
    catch { throw new KeystoreError('failed', 'keystore native operation failed'); }
  };
  return {
    async get(name) {
      const entry = key(name);
      return call((store) => store.getItemAsync(entry, options));
    },
    async set(name, secret) {
      const entry = key(name);
      assertSecret(secret);
      await call((store) => store.setItemAsync(entry, secret, options));
    },
    async delete(name) {
      const entry = key(name);
      return call(async (store) => {
        if (await store.getItemAsync(entry, options) === null) return false;
        await store.deleteItemAsync(entry, options);
        return true;
      });
    },
  };
}
