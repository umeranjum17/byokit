// Credential stores behind Pi's own CredentialStore seam: one per person, never a shared fallback. Each platform's
// storage is only "load the record, save the record"; this file keeps every one of them serialized the same way, so a
// refresh and a sign-out never interleave. No Node import here: phones and browsers use it too (see node-stores.ts).
import type { Credential, CredentialStore } from '@earendil-works/pi-ai';

export type Record = { [providerId: string]: Credential };

/** A store over one whole record the platform loads and saves. Writes are serialized within this process; a write
 *  re-reads first, so a sign-in that took minutes never overwrites a provider that changed meanwhile. */
export function recordStore(load: () => Promise<Record>, save: (data: Record) => Promise<void>): CredentialStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };
  return {
    read: async (id) => (await load())[id],
    list: async () => Object.entries(await load()).map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: (id, fn) => serial(async () => {
      const current = (await load())[id];
      const next = await fn(current);
      if (next === undefined) return current;
      await save({ ...(await load()), [id]: next });
      return next;
    }),
    delete: (id) => serial(async () => { const data = await load(); if (id in data) { delete data[id]; await save(data); } }),
  };
}

export function memoryStore(): CredentialStore {
  let data: Record = {};
  return recordStore(async () => ({ ...data }), async (d) => { data = d; });
}

/** The parts of `expo-secure-store` this uses (Keychain on iOS, Keystore-encrypted on Android); pass the module itself. */
export type SecureStoreLike = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};

/** One person's sign-ins in the phone's secure storage: `secureStore(SecureStore, 'byokit.1')`. Keys may hold letters,
 *  digits, `.`, `-` and `_`. The record is split into pieces under the 2048 bytes expo-secure-store warns about, written
 *  as a new generation, then `name` is pointed at it: a crash mid-write leaves the old sign-ins whole. */
export function secureStore(secure: SecureStoreLike, name: string): CredentialStore {
  const head = async () => { const [gen = '0', n = '0'] = (await secure.getItemAsync(name))?.split(':') ?? []; return { gen: Number(gen), n: Number(n) }; };
  const load = async () => {
    const { gen, n } = await head();
    let text = '';
    for (let i = 0; i < n; i++) text += (await secure.getItemAsync(`${name}.${gen}.${i}`)) ?? '';
    return text ? JSON.parse(text) : {};
  };
  const save = async (data: Record) => {
    const old = await head();
    const gen = old.gen + 1;
    const parts = (Object.keys(data).length ? JSON.stringify(data) : '').match(/[\s\S]{1,1800}/g) ?? [];
    for (const [i, part] of parts.entries()) await secure.setItemAsync(`${name}.${gen}.${i}`, part);
    await secure.setItemAsync(name, `${gen}:${parts.length}`);
    for (let i = 0; i < old.n; i++) await secure.deleteItemAsync(`${name}.${old.gen}.${i}`);
    // Leftovers of a write that crashed at this generation before.
    for (let i = parts.length; (await secure.getItemAsync(`${name}.${gen}.${i}`)) !== null; i++) await secure.deleteItemAsync(`${name}.${gen}.${i}`);
  };
  return recordStore(load, save);
}

/** One person's sign-ins in the browser's IndexedDB (a PWA, or Electron's renderer), under `name`. A browser has no
 *  keychain: anything running on this page could read them, so keep the page free of scripts you don't control. */
export function browserStore(name: string, db = 'byokit'): CredentialStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(db, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('signins');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest) => {
    const d = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const t = d.transaction('signins', mode);
        const r = fn(t.objectStore('signins'));
        t.oncomplete = () => resolve(r.result);
        t.onerror = t.onabort = () => reject(t.error);
      });
    } finally { d.close(); }
  };
  return recordStore(async () => (await run<Record | undefined>('readonly', (s) => s.get(name))) ?? {}, (data) => run('readwrite', (s) => s.put(data, name)));
}
