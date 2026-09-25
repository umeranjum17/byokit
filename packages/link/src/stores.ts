// Where a device keeps its grant (it holds the device's secret key): the phone's secure storage, or the browser's
// IndexedDB sealed with a key the page can use but never read. Each is a DeviceStore for `DeviceLink({ store })`, plus
// `load()` for the next start. One store per paired computer. No Node import: see node.ts for a computer's file.
import type { DeviceGrant, DeviceStore } from './device.ts';

export type KeptDevice = DeviceStore & { load(): Promise<DeviceGrant | null> };

/** The parts of `expo-secure-store` this uses (Keychain on iOS, Keystore-encrypted on Android); pass the module itself. */
export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

const grantOf = (text: string | null | undefined): DeviceGrant | null => {
  if (!text) return null;
  const g = JSON.parse(text);
  return g?.v === 1 && typeof g.secretKey === 'string' && typeof g.host === 'string' ? g : null;
};

/** A grant in the phone's secure storage under `name` (letters, digits, `.`, `-`, `_`): about 300 bytes, one value. */
export function secureDeviceStore(secure: SecureStoreLike, name: string): KeptDevice {
  return {
    load: async () => grantOf(await secure.getItemAsync(name)),
    save: (g) => secure.setItemAsync(name, JSON.stringify(g)),
    clear: () => secure.deleteItemAsync(name),
  };
}

/** A grant in this browser's IndexedDB under `name`, sealed with AES-GCM by a key made here as non-extractable: the
 *  page can seal and open with it, but no script can read the key out, and the stored grant alone opens nothing. */
export function browserDeviceStore(name: string, db = 'byokit-link'): KeptDevice {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(db, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('keys'); r.result.createObjectStore('grants'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async <T>(table: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const d = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = d.transaction(table, mode);
        const r = fn(t.objectStore(table));
        t.oncomplete = () => resolve(r.result);
        t.onabort = () => reject(t.error ?? r.error);
      });
    } finally { d.close(); }
  };
  const key = async (): Promise<CryptoKey> => {
    const kept = await run<CryptoKey | undefined>('keys', 'readonly', (s) => s.get(name));
    if (kept) return kept;
    const made = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    try {
      await run('keys', 'readwrite', (s) => s.add(made, name));
      return made;
    } catch (e) {
      if ((e as DOMException)?.name !== 'ConstraintError') throw e;
      return (await run<CryptoKey>('keys', 'readonly', (s) => s.get(name)))!;
    }
  };
  return {
    async load() {
      const sealed = await run<{ iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer } | undefined>('grants', 'readonly', (s) => s.get(name));
      if (!sealed) return null;
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await key(), sealed.data);
      return grantOf(new TextDecoder().decode(plain));
    },
    async save(g) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(g)));
      await run('grants', 'readwrite', (s) => s.put({ iv, data }, name));
    },
    async clear() { await run('grants', 'readwrite', (s) => s.delete(name)); },
  };
}
