export * from './portable.ts';
import { KeystoreError } from './errors.ts';
import type { Keystore } from './types.ts';
import { assertName, assertSecret } from './validate.ts';

export interface WebOptions {
  /** One origin-local database per app. Defaults to byokit-secrets. */
  database?: string;
  /** Injectable browser APIs for offline tests. */
  indexedDB?: IDBFactory;
  crypto?: Crypto;
  isSecureContext?: boolean;
}

const STORE = 'wrapped';
const KEY = 'device-wrap-key';
const item = (name: string): string => `item:${name}`;
const bytes = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
// JSON preserves unmatched UTF-16 surrogates in names and values. Direct UTF-8
// encoding replaces them and could give distinct entry names the same AAD.
const aad = (name: string): Uint8Array<ArrayBuffer> => bytes(JSON.stringify(item(name)));

/** IndexedDB holds only a non-extractable AES-256 key and authenticated ciphertext. */
export function webStore(o: WebOptions = {}): Keystore {
  const database = o.database ?? 'byokit-secrets';
  assertName(database, 'database');
  const apis = (): { idb: IDBFactory; crypto: Crypto } => {
    const idb = o.indexedDB ?? globalThis.indexedDB;
    const crypto = o.crypto ?? globalThis.crypto;
    if (!(o.isSecureContext ?? globalThis.isSecureContext) || !idb || !crypto?.subtle) {
      throw new KeystoreError('unavailable', 'keystore web storage requires HTTPS, IndexedDB and WebCrypto');
    }
    return { idb, crypto };
  };
  const open = async (): Promise<IDBDatabase> => {
    const { idb } = apis();
    return new Promise((resolve, reject) => {
      let failed = false;
      const request = idb.open(database, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => {
        if (failed) { request.result.close(); return; }
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      const fail = () => {
        failed = true;
        reject(new KeystoreError('unavailable', 'keystore web database could not be opened'));
      };
      request.onerror = fail;
      request.onblocked = fail;
    });
  };
  // All requests are scheduled synchronously or in IDB request callbacks. Awaiting
  // WebCrypto inside an IDB transaction would let it auto-commit prematurely.
  const transact = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, done: (value: T) => void) => void): Promise<T> => {
    const db = await open();
    return new Promise((resolve, reject) => {
      let result: T;
      let tx: IDBTransaction | undefined;
      const fail = () => {
        db.close();
        reject(new KeystoreError('failed', 'keystore web transaction failed'));
      };
      try {
        tx = db.transaction(STORE, mode);
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = fail;
        tx.onerror = fail;
        operation(tx.objectStore(STORE), (value) => { result = value; });
      } catch {
        tx?.abort();
        fail();
      }
    });
  };
  const validKey = (key: CryptoKey | undefined): CryptoKey => {
    if (!key || key.type !== 'secret' || key.extractable !== false || key.algorithm?.name !== 'AES-GCM'
      || (key.algorithm as AesKeyAlgorithm).length !== 256
      || !Array.isArray(key.usages) || !key.usages.includes('encrypt') || !key.usages.includes('decrypt')) {
      throw new KeystoreError('auth-failed', 'keystore web encryption key is missing or invalid');
    }
    return key;
  };
  const wrapKey = async (): Promise<CryptoKey> => {
    const stored = await transact<CryptoKey | undefined>('readonly', (store, done) => {
      const request = store.get(KEY);
      request.onsuccess = () => done(request.result);
    });
    if (stored !== undefined) return validKey(stored);
    const created = await apis().crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // Recheck and insert in the same readwrite transaction: another tab or store
    // instance may have initialized the database during key generation.
    const selected = await transact<CryptoKey>('readwrite', (store, done) => {
      const request = store.get(KEY);
      request.onsuccess = () => {
        if (request.result !== undefined) { done(request.result); return; }
        store.add(created, KEY);
        done(created);
      };
    });
    return validKey(selected);
  };
  const call = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof KeystoreError) throw error;
      throw new KeystoreError('failed', 'keystore web operation failed');
    }
  };
  return {
    async get(name) {
      assertName(name);
      return call(async () => {
        const { record, key } = await transact<{ record: unknown; key: CryptoKey | undefined }>('readonly', (store, done) => {
          const record = store.get(item(name));
          const key = store.get(KEY);
          key.onsuccess = () => done({ record: record.result, key: key.result });
        });
        if (record === undefined) return null;
        const saved = record as { v?: unknown; iv?: unknown; ciphertext?: unknown } | null;
        if (!saved || saved.v !== 1 || !(saved.iv instanceof Uint8Array) || saved.iv.byteLength !== 12
          || !(saved.ciphertext instanceof ArrayBuffer) || saved.ciphertext.byteLength < 16) {
          throw new KeystoreError('auth-failed', 'keystore web ciphertext is invalid');
        }
        const wrapping = validKey(key);
        try {
          const plaintext = await apis().crypto.subtle.decrypt({ name: 'AES-GCM', iv: saved.iv as Uint8Array<ArrayBuffer>, additionalData: aad(name) }, wrapping, saved.ciphertext);
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext));
          if (typeof value !== 'string') throw new Error('invalid value');
          return value;
        } catch {
          throw new KeystoreError('auth-failed', 'keystore web ciphertext could not be authenticated');
        }
      });
    },
    async set(name, secret) {
      assertName(name);
      assertSecret(secret);
      await call(async () => {
        const key = await wrapKey();
        const crypto = apis().crypto;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(name) }, key, bytes(JSON.stringify(secret)));
        await transact<void>('readwrite', (store, done) => {
          store.put({ v: 1, iv, ciphertext }, item(name));
          done(undefined);
        });
      });
    },
    async delete(name) {
      assertName(name);
      return call(() => transact<boolean>('readwrite', (store, done) => {
        const request = store.get(item(name));
        request.onsuccess = () => {
          if (request.result === undefined) { done(false); return; }
          store.delete(item(name));
          done(true);
        };
      }));
    },
  };
}
