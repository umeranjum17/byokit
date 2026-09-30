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
  let pending = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request<Promise<T>>(`byokit-link:${db}:${name}`, fn).then((value) => value);
    const work = pending.then(fn);
    pending = work.then(() => {}, () => {});
    return work;
  };
  const generation = async () => (await run<{ generation?: number } | undefined>('grants', 'readonly', (s) => s.get(name)))?.generation ?? 0;
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
  const read = async (): Promise<DeviceGrant | null> => {
    const sealed = await run<{ iv?: Uint8Array<ArrayBuffer>; data?: ArrayBuffer } | undefined>('grants', 'readonly', (s) => s.get(name));
    if (!sealed?.iv || !sealed.data) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, await key(), sealed.data);
    return grantOf(new TextDecoder().decode(plain));
  };
  return {
    load: () => locked(read),
    save(g) {
      return locked(async () => {
        const started = await generation();
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(g)));
        await run('grants', 'readwrite', (s) => {
          const r = s.get(name);
          r.onsuccess = () => { if ((r.result?.generation ?? 0) === started && r.result?.forgottenId !== g.device.id) s.put({ iv, data, generation: started }, name); };
          return r;
        });
      });
    },
    clear: () => locked(async () => {
      const forgottenId = (await read().catch(() => null))?.device?.id;
      await run('grants', 'readwrite', (s) => {
        const r = s.get(name);
        r.onsuccess = () => { s.put({ generation: (r.result?.generation ?? 0) + 1, forgottenId: forgottenId ?? r.result?.forgottenId }, name); };
        return r;
      });
    }),
  };
}

/** A device's collection of paired computers. Names are app-chosen, not host-supplied paths.
 *  `store(name)` adapts one entry to DeviceLink's save/clear interface. */
export type DeviceStores = {
  list(): Promise<string[]>;
  load(name: string): Promise<DeviceGrant | null>;
  save(name: string, grant: DeviceGrant): Promise<void>;
  remove(name: string): Promise<void>;
  store(name: string): KeptDevice;
};

const checkedName = (name: string) => {
  if (!/^[A-Za-z0-9_.-]{1,120}$/.test(name)) throw new Error('A store name must use letters, digits, dots, dashes or underscores.');
  return name;
};
const secureWork = new WeakMap<SecureStoreLike, Map<string, Promise<void>>>();

/** Multiple grants in platform secure storage, with a private index. Operations across instances sharing the
 *  same module and prefix are serialized. The native backend has no cross-process transaction API. */
export function secureDeviceStores(secure: SecureStoreLike, prefix = 'byokit.link'): DeviceStores {
  checkedName(prefix);
  let work = secureWork.get(secure);
  if (!work) { work = new Map(); secureWork.set(secure, work); }
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = (work!.get(prefix) ?? Promise.resolve()).then(fn);
    work!.set(prefix, next.then(() => {}, () => {}));
    return next;
  };
  const index = `${prefix}.index`;
  const entry = (name: string) => secureDeviceStore(secure, `${prefix}.grant.${checkedName(name)}`);
  const names = async (): Promise<string[]> => {
    const raw = await secure.getItemAsync(index);
    if (raw === null) return [];
    const names: unknown = JSON.parse(raw);
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(n))) throw new Error('Invalid device store index.');
    return [...new Set(names as string[])];
  };
  const stores: DeviceStores = {
    list: () => locked(async () => {
      const all = await names();
      const kept = await Promise.all(all.map(async (n) => await entry(n).load() ? n : null));
      return kept.filter((n): n is string => n !== null);
    }),
    load: (name) => locked(() => entry(name).load()),
    save: (name, grant) => locked(async () => {
      const store = entry(name);
      const all = await names();
      // Index first: an interrupted write leaves a missing entry we can filter, never an undiscoverable secret.
      if (!all.includes(name)) await secure.setItemAsync(index, JSON.stringify([...all, name]));
      await store.save(grant);
    }),
    remove: (name) => locked(async () => {
      await entry(name).clear();
      await secure.setItemAsync(index, JSON.stringify((await names()).filter((n) => n !== name)));
    }),
    store(name) { checkedName(name); return { load: () => stores.load(name), save: (g) => stores.save(name, g), clear: () => stores.remove(name) }; },
  };
  return stores;
}

/** Enumerates the existing sealed IndexedDB entries; each retains its own non-extractable wrapping key and
 *  clear/save generation protection. Tombstones are excluded from list. Compatible with browserDeviceStore. */
export function browserDeviceStores(db = 'byokit-link'): DeviceStores {
  const entry = (name: string) => browserDeviceStore(checkedName(name), db);
  const stores: DeviceStores = {
    async list() {
      // Let the existing backend create the schema even when no entry has been saved yet.
      await browserDeviceStore('', db).load();
      const names = await new Promise<string[]>((resolve, reject) => {
        const r = indexedDB.open(db, 1);
        r.onerror = () => reject(r.error);
        r.onsuccess = () => {
          const d = r.result;
          const t = d.transaction('grants', 'readonly');
          const q = t.objectStore('grants').openCursor();
          const names: string[] = [];
          q.onsuccess = () => {
            const c = q.result;
            if (!c) return;
            if (typeof c.key === 'string' && c.value?.iv && c.value?.data) names.push(c.key);
            c.continue();
          };
          t.oncomplete = () => { d.close(); resolve(names); };
          t.onabort = () => { d.close(); reject(t.error ?? q.error); };
        };
      });
      return names;
    },
    load: (name) => entry(name).load(),
    save: async (name, grant) => { await entry(name).save(grant); },
    remove: async (name) => { await entry(name).clear(); },
    store: entry,
  };
  return stores;
}
