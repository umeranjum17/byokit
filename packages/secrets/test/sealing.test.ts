import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileStore } from '../../accounts/src/node-stores.ts';
import { scratchDir } from '../../test-support.ts';
import { hostKeySeal, osKeyring, osKeyringSeal, osKeyringStore, type KeyringBackend } from '../src/index.ts';

const CANARY = 'sk-umer-sealed-canary-😀\n\0';
const code = (want: string) => (error: any) => error?.name === 'KeystoreError' && error.code === want && !error.message.includes(CANARY);
function fakeRing() {
  const data = new Map<string, string>();
  const ring: KeyringBackend = {
    get: (name) => data.get(name) ?? null,
    set: (name, value) => { data.set(name, value); },
    delete: (name) => data.delete(name),
  };
  return { ring, data };
}

test('native backend forces persistent Secret Service and implements the common store seam', async () => {
  const calls: unknown[] = [];
  const data = new Map<string, string>();
  const store = osKeyringStore({
    service: 'Umer',
    entry(service, name, options) {
      calls.push({ service, name, options });
      return {
        getPassword: () => data.get(name) ?? null,
        setPassword: (secret) => { data.set(name, secret); },
        deleteCredential: () => data.delete(name),
      };
    },
  });
  assert.equal(await store.get('api'), null);
  assert.equal(await store.delete('api'), false);
  await store.set('api', CANARY);
  assert.equal(await store.get('api'), CANARY);
  assert.equal(await store.delete('api'), true);
  for (const call of calls) assert.deepEqual(call, { service: 'Umer', name: 'api', options: { linux: { store: 'secret-service' } } });
  assert.ok(!JSON.stringify(calls).includes(CANARY));
  const unavailable = osKeyring({ service: 'Umer', entry() { throw new Error(CANARY); } });
  assert.throws(() => unavailable.get('api'), code('unavailable'));
  assert.throws(() => unavailable.set('api', CANARY), code('unavailable'));
  assert.throws(() => unavailable.delete('api'), code('unavailable'));
  assert.throws(() => unavailable.get(''), code('invalid'));
});

test('accounts fileStore accepts the OS seal, encrypts api_key at rest and survives restart/rotation', async () => {
  const { ring, data } = fakeRing();
  const seal = osKeyringSeal({ service: 'Umer', keyring: ring });
  assert.equal(data.size, 0, 'construction probes availability without creating a key');
  const path = join(scratchDir('os-seal'), 'private', 'accounts.bin');
  const store = fileStore(path, seal);
  await store.modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const oldFile = readFileSync(path);
  assert.ok(!oldFile.includes(Buffer.from(CANARY)));
  assert.ok(!JSON.stringify([...data.values()]).includes(CANARY), 'keyring holds only data keys and an active id');
  assert.equal(data.size, 2);
  assert.equal((await fileStore(path, osKeyringSeal({ service: 'Umer', keyring: ring })).read('provider'))?.type, 'api_key');
  const before = seal.decryptString(oldFile);
  const id = seal.rotateKey();
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(seal.decryptString(oldFile), before, 'rotation retains old backups');
  await store.modify('second', async () => ({ type: 'api_key', key: 'second-key' }));
  const newFile = readFileSync(path);
  assert.equal(newFile.subarray(5, 21).toString('hex'), id);
  assert.notDeepEqual(newFile, oldFile);
  await store.delete('provider');
  assert.equal(await store.read('provider'), undefined);
  assert.deepEqual(await store.list(), [{ providerId: 'second', type: 'api_key' }]);
});

test('wrong keys, tampering and missing/corrupt data keys fail closed and preserve the accounts file', async () => {
  const { ring, data } = fakeRing();
  const seal = osKeyringSeal({ service: 'Umer', keyring: ring });
  const path = join(scratchDir('os-seal-auth'), 'private', 'accounts.bin');
  const store = fileStore(path, seal);
  await store.modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const original = readFileSync(path);
  for (const at of [0, 4, 5, 21, 45, original.length - 1]) {
    const tampered = Buffer.from(original);
    tampered[at] ^= 1;
    assert.throws(() => seal.decryptString(tampered), code('auth-failed'));
  }
  for (const length of [0, 20, 60]) assert.throws(() => seal.decryptString(original.subarray(0, length)), code('auth-failed'));
  assert.throws(() => osKeyringSeal({ service: 'another-service', keyring: ring }).decryptString(original), code('auth-failed'));
  const keyName = `byokit-seal-key-v1-${original.subarray(5, 21).toString('hex')}`;
  const realKey = data.get(keyName)!;
  for (const wrong of [randomBytes(32).toString('hex'), 'corrupt', null]) {
    if (wrong === null) data.delete(keyName); else data.set(keyName, wrong);
    await assert.rejects(store.read('provider'), code('auth-failed'));
    await assert.rejects(store.modify('provider', async () => ({ type: 'api_key', key: 'replace' })), code('auth-failed'));
    assert.deepEqual(readFileSync(path), original);
    assert.equal(data.get(keyName), wrong ?? undefined, 'no replacement key is generated');
  }
  data.set(keyName, realKey);
  assert.equal(JSON.parse(seal.decryptString(original)).provider.key, CANARY);
});

test('failed persistence/activation leaves old keys usable; competing initialization cannot orphan ciphertext', () => {
  const { ring, data } = fakeRing();
  const a = osKeyringSeal({ service: 'Umer', keyring: ring });
  const old = Buffer.from(a.encryptString(CANARY));
  const active = data.get('byokit-seal-active-v1');
  const originalSet = ring.set;
  ring.set = (name, value) => {
    if (name === 'byokit-seal-active-v1') throw new Error(CANARY);
    originalSet(name, value);
  };
  assert.throws(() => a.rotateKey(), code('unavailable'));
  assert.equal(data.get('byokit-seal-active-v1'), active);
  assert.equal(a.decryptString(old), CANARY);
  ring.set = originalSet;
  // Model the other process publishing its own active id between key creation and activation.
  const b = osKeyringSeal({ service: 'Umer', keyring: ring });
  const saved = b.rotateKey();
  const bFile = Buffer.from(b.encryptString('other process'));
  a.rotateKey();
  assert.equal(a.decryptString(bFile), 'other process');
  assert.ok(data.has(`byokit-seal-key-v1-${saved}`));
  assert.equal(b.decryptString(old), CANARY);
  ring.set = () => {};
  assert.throws(() => a.rotateKey(), code('auth-failed'), 'read-back rejects a keyring that drops writes');
});

test('headless hosts explicitly select hostKeySeal; no generated key, plaintext fallback or resolver errors leak', async () => {
  const unavailable: KeyringBackend = { get() { throw new Error(CANARY); }, set() { throw new Error(CANARY); }, delete() { throw new Error(CANARY); } };
  assert.throws(() => osKeyringSeal({ service: 'Umer', keyring: unavailable }), code('unavailable'));
  const key = randomBytes(32);
  const copy = Buffer.from(key);
  let calls = 0;
  const seal = hostKeySeal({ key: () => { calls++; return key; }, service: 'Umer' });
  const first = Buffer.from(seal.encryptString(CANARY));
  const second = Buffer.from(seal.encryptString(CANARY));
  assert.notDeepEqual(first, second, 'each encryption has a fresh nonce');
  assert.equal(seal.decryptString(first), CANARY);
  assert.equal(seal.decryptString(Buffer.from(seal.encryptString('\ud800\n\0'))), '\ud800\n\0');
  const path = join(scratchDir('host-seal'), 'private', 'accounts.bin');
  const store = fileStore(path, seal);
  await store.modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const bytes = readFileSync(path);
  assert.ok(!bytes.includes(Buffer.from(CANARY)));
  assert.ok(!bytes.includes(key));
  assert.equal((await fileStore(path, hostKeySeal({ key, service: 'Umer' })).read('provider'))?.type, 'api_key');
  assert.ok(calls > 0);
  assert.deepEqual(key, copy, 'host-owned key is never zeroed');
  const wrong = fileStore(path, hostKeySeal({ key: randomBytes(32), service: 'Umer' }));
  await assert.rejects(wrong.delete('provider'), code('auth-failed'));
  assert.deepEqual(readFileSync(path), bytes);
  const tampered = Buffer.from(bytes);
  tampered[5] ^= 1; // Even unused host-key header bytes are authenticated.
  assert.throws(() => seal.decryptString(tampered), code('auth-failed'));
  assert.throws(() => hostKeySeal({ key, service: 'other' }).decryptString(bytes), code('auth-failed'));
  for (const bad of [new Uint8Array(31), new Uint8Array(33), 'secret', undefined]) {
    assert.throws(() => hostKeySeal({ key: bad as Uint8Array }), code('invalid'));
    assert.throws(() => hostKeySeal({ key: () => bad as Uint8Array }).encryptString(CANARY), code('invalid'));
  }
  const inaccessible = hostKeySeal({ key: () => { throw new Error(CANARY); } });
  assert.throws(() => inaccessible.encryptString(CANARY), code('unavailable'));
});
