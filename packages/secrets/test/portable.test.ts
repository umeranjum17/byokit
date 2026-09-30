import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { webStore } from '../src/web.ts';
import { nativeStoreWith, type SecureStoreLike } from '../src/native.ts';
import { assertSecret } from '../src/validate.ts';

const CANARY = 'secret-canary-\0-😀-\n';
const code = (want: string) => (error: any) => error?.name === 'KeystoreError' && error.code === want && !error.message.includes(CANARY);
const crypto = webcrypto as unknown as Crypto;
const fakeWeb = (idb = new IDBFactory(), database = 'offline-keys') => ({ indexedDB: idb, crypto, isSecureContext: true, database });

// Inspect/tamper only the fake origin-local database, never the person's storage.
async function stored(idb: IDBFactory, key: string, change?: (value: any) => any): Promise<any> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open('offline-keys', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('wrapped', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('wrapped');
      const request = store.get(key);
      request.onsuccess = () => { if (change) store.put(change(request.result), key); };
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

test('web: survives new instances, encrypts at rest, namespaces apps and implements null/boolean semantics', async () => {
  const o = fakeWeb();
  const store = webStore(o);
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.delete('missing'), false);
  await store.set('provider/🔑', CANARY);
  assert.equal(await webStore(o).get('provider/🔑'), CANARY);
  assert.equal(await webStore({ ...o, database: 'another-app' }).get('provider/🔑'), null);
  const record = await stored(o.indexedDB, 'item:provider/🔑');
  assert.equal(record.iv.byteLength, 12);
  assert.ok(!new TextDecoder().decode(record.ciphertext).includes(CANARY));
  const key = await stored(o.indexedDB, 'device-wrap-key');
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, 'AES-GCM');
  assert.equal(key.algorithm.length, 256);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
  await store.set('provider/🔑', CANARY);
  assert.notDeepEqual((await stored(o.indexedDB, 'item:provider/🔑')).iv, record.iv);
  await store.set('empty', '');
  assert.equal(await store.get('empty'), '');
  await store.set('unpaired', '\ud800');
  assert.equal(await store.get('unpaired'), '\ud800');
  assert.equal(await store.delete('empty'), true);
  assert.equal(await store.delete('empty'), false);
  assert.equal(await store.delete('provider/🔑'), true);
  assert.equal(await store.get('provider/🔑'), null);
});

test('web: concurrent initialization uses one persisted key across instances', async () => {
  const o = fakeWeb();
  const stores = Array.from({ length: 8 }, () => webStore(o));
  await Promise.all(stores.map((store, i) => store.set(`provider-${i}`, `${CANARY}${i}`)));
  for (let i = 0; i < stores.length; i++) assert.equal(await webStore(o).get(`provider-${i}`), `${CANARY}${i}`);
  assert.deepEqual(await Promise.all(stores.map((store) => store.delete('provider-0'))), [true, ...Array(7).fill(false)]);
});

test('web: tampering, copying to another name and invalid keys fail closed', async () => {
  const o = fakeWeb();
  const store = webStore(o);
  await store.set('\ud800', CANARY);
  await store.set('\ud801', 'other-value');
  const storedRecord = await stored(o.indexedDB, 'item:\ud800');
  await stored(o.indexedDB, 'item:\ud801', () => storedRecord);
  await assert.rejects(store.get('\ud801'), code('auth-failed'));
  await store.set('original', CANARY);
  await store.set('other', 'other-value');
  const record = await stored(o.indexedDB, 'item:original');
  await stored(o.indexedDB, 'item:other', () => record);
  await assert.rejects(store.get('other'), code('auth-failed'));
  assert.equal(await store.get('original'), CANARY);
  await stored(o.indexedDB, 'item:original', (saved) => {
    new Uint8Array(saved.ciphertext)[0] ^= 1;
    return saved;
  });
  await assert.rejects(store.get('original'), code('auth-failed'));
  await stored(o.indexedDB, 'device-wrap-key', () => ({ extractable: true }));
  const before = await stored(o.indexedDB, 'item:original');
  await assert.rejects(store.set('original', 'replacement'), code('auth-failed'));
  assert.deepEqual(await stored(o.indexedDB, 'item:original'), before);
  await stored(o.indexedDB, 'item:other', () => ({ v: 2 }));
  await assert.rejects(store.get('other'), code('auth-failed'));
});

test('web: unavailable APIs, aborted transactions, crypto failures and validation never expose secrets', async () => {
  const o = fakeWeb();
  const insecure = webStore({ ...o, isSecureContext: false });
  await assert.rejects(insecure.set('x', CANARY), code('unavailable'));
  const broken = webStore({ ...o, crypto: { subtle: { generateKey: async () => { throw new Error(CANARY); } } } as unknown as Crypto });
  await assert.rejects(broken.set('x', CANARY), code('failed'));
  const aborting = {
    open(name: string, version?: number) {
      const request = o.indexedDB.open(name, version);
      request.addEventListener('success', () => {
        const db = request.result;
        const original = db.transaction.bind(db);
        db.transaction = (names, mode, options) => {
          const tx = original(names, mode, options);
          queueMicrotask(() => tx.abort());
          return tx;
        };
      });
      return request;
    },
  } as IDBFactory;
  await assert.rejects(webStore({ ...o, indexedDB: aborting }).set('x', CANARY), code('failed'));
  const store = webStore(o);
  await assert.rejects(store.get(''), code('invalid'));
  await assert.rejects(store.delete('a\0b'), code('invalid'));
  await assert.rejects(store.set('x', '😀'.repeat(262145)), code('invalid'));
  assert.throws(() => webStore({ database: '' }), code('invalid'));
});

test('native: delegates only to fake SecureStore, preserves empty values/options and encodes names without collisions', async () => {
  const entries = new Map<string, string>();
  const calls: { key: string; options: unknown }[] = [];
  const fake: SecureStoreLike = {
    async getItemAsync(key, options) { calls.push({ key, options }); return entries.get(key) ?? null; },
    async setItemAsync(key, value, options) { calls.push({ key, options }); entries.set(key, value); },
    async deleteItemAsync(key, options) { calls.push({ key, options }); entries.delete(key); },
  };
  const options = { keychainService: 'app.keys', requireAuthentication: false };
  const store = nativeStoreWith({ secureStore: fake, options }, async () => { throw new Error('must not load'); });
  assert.equal(await store.get('missing'), null);
  assert.equal(await store.delete('missing'), false);
  await store.set('provider/🔑', CANARY);
  await store.set('provider_🔑', '');
  assert.equal(await store.get('provider/🔑'), CANARY);
  assert.equal(await store.get('provider_🔑'), '');
  assert.equal(await store.delete('provider/🔑'), true);
  assert.equal(await store.delete('provider/🔑'), false);
  for (const call of calls) {
    assert.match(call.key, /^[A-Za-z0-9._-]+$/);
    assert.deepEqual(call.options, options);
  }
  assert.equal(await nativeStoreWith({ secureStore: fake, prefix: 'other' }, async () => fake).get('provider_🔑'), null);
  await assert.rejects(store.set('x', CANARY.repeat(100000)), code('invalid'));
  await assert.rejects(store.get('x\0y'), code('invalid'));
  assert.throws(() => nativeStoreWith({ prefix: 'bad/prefix' }, async () => fake), code('invalid'));
  fake.setItemAsync = async () => { throw new Error(CANARY); };
  await assert.rejects(store.set('x', CANARY), code('failed'));
});

test('native: optional peer loads on demand and a failed load can be retried', async () => {
  let loads = 0;
  const store = nativeStoreWith({}, async () => {
    if (++loads === 1) throw new Error(CANARY);
    return { async getItemAsync() { return null; }, async setItemAsync() {}, async deleteItemAsync() {} };
  });
  assert.equal(loads, 0);
  await assert.rejects(store.get('x'), code('unavailable'));
  assert.equal(await store.get('x'), null);
  assert.equal(loads, 2);
});

test('UTF-8 size validation matches Node, including unmatched surrogates', () => {
  for (const unit of ['a', 'é', '字', '😀', '\ud800', '\udc00']) {
    const limit = Math.floor(1024 * 1024 / Buffer.byteLength(unit));
    assert.doesNotThrow(() => assertSecret(unit.repeat(limit)));
    assert.throws(() => assertSecret(unit.repeat(limit + 1)), code('invalid'));
  }
});

test('platform exports bundle without Node and native calls work without Buffer, process or encoding globals', async () => {
  for (const condition of ['browser', 'react-native']) {
    const bundle = await build({
      stdin: { contents: "import * as kit from '@byokit/secrets'; globalThis.kit = kit;", resolveDir: import.meta.dirname },
      bundle: true, platform: 'browser', format: 'iife', conditions: [condition], write: false, metafile: true,
      plugins: [{ name: 'fake-secure-store', setup(build) {
        build.onResolve({ filter: /^expo-secure-store$/ }, () => ({ path: 'expo-secure-store', namespace: 'fake' }));
        build.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export async function getItemAsync() { return "fake-device-secret"; } export async function setItemAsync() {} export async function deleteItemAsync() {}' }));
      } }],
    });
    assert.ok(!Object.keys(bundle.metafile!.inputs).some((file) => /src\/(index|file|keyring|atomic)\.ts/.test(file)));
    const context: any = condition === 'browser'
      ? { indexedDB: new IDBFactory(), crypto, isSecureContext: true, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer }
      : {};
    runInNewContext(bundle.outputFiles[0].text, context);
    assert.equal(runInNewContext('typeof Buffer + ":" + typeof process + ":" + typeof require', context), 'undefined:undefined:undefined');
    const store = context.kit.overrideStore({ token: CANARY });
    assert.equal(await store.get('token'), CANARY);
    if (condition === 'react-native') {
      assert.equal(runInNewContext('typeof TextEncoder', context), 'undefined');
      assert.equal(await context.kit.nativeStore().get('token'), 'fake-device-secret');
      await context.kit.nativeStore().set('unicode/🔑', CANARY);
    } else {
      const web = context.kit.webStore();
      await web.set('token', CANARY);
      assert.equal(await context.kit.webStore().get('token'), CANARY);
      assert.equal(await web.delete('token'), true);
    }
  }
});
