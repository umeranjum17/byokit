// Opt-in integration ONLY: real Secret Service under a disposable OS session (CI's test-keyring.sh starts its
// own D-Bus/keyring daemon). Kept because these are the only tests that drive a real native OS keyring and its
// isolation guard; the offline keyring behaviour lives in journey-secrets.test.ts. The ordinary offline suite
// never inspects or changes the owner's keyring — every test here skips unless BYOKIT_REAL_KEYRING is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { randomUUID } from 'node:crypto';
import { osKeyring, osKeyringSeal } from '../src/index.ts';
import { assertPrivateKeyringSession } from './private-session.ts';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileStore as accountFileStore } from '../../accounts/src/node-stores.ts';
import { OpenClawKit } from '../../openclaw/src/kit.ts';
import { fakeGateway } from '../../openclaw/src/testing/fake-gateway.ts';

const CANARY = 'sk-canary-keyring-9f2c';
const code = (want: string) => (e: any) => e?.code === want;

test('real Secret Service: native API, accounts seal and rotation', { skip: !process.env.BYOKIT_REAL_KEYRING }, (t) => {
  if (process.platform !== 'linux') { t.skip('Linux Secret Service integration'); return; }
  assertPrivateKeyringSession(process.env);
  const service = `byokit-test-Umer-${randomUUID()}`;
  const ring = osKeyring({ service });
  try { assert.equal(ring.get('absent'), null); }
  catch (error) {
    if (process.env.BYOKIT_REAL_KEYRING === 'required') throw error;
    t.skip('No Secret Service available'); return;
  }
  const names = new Set(['api', 'byokit-seal-active-v1']);
  try {
    assert.equal(ring.delete('api'), false);
    ring.set('api', CANARY);
    assert.equal(ring.get('api'), CANARY);
    assert.equal(ring.delete('api'), true);
    const tracked = {
      get: (name: string) => ring.get(name),
      set(name: string, value: string) { names.add(name); ring.set(name, value); },
      delete: (name: string) => ring.delete(name),
    };
    const seal = osKeyringSeal({ stateDir: scratchDir('seal-state'), service, keyring: tracked });
    const old = Buffer.from(seal.encryptString(CANARY));
    seal.rotateKey();
    const newer = Buffer.from(seal.encryptString('rotated'));
    const restarted = osKeyringSeal({ stateDir: scratchDir('seal-state'), service });
    assert.equal(restarted.decryptString(old), CANARY);
    assert.equal(restarted.decryptString(newer), 'rotated');
    newer[newer.length - 1] ^= 1;
    assert.throws(() => restarted.decryptString(newer), code('auth-failed'));
  } finally {
    for (const name of names) ring.delete(name);
  }
});

test('private gnome-keyring: unlocked seal, locked startup, unlock recovery and dual-wrap upgrade', { skip: !process.env.BYOKIT_REAL_KEYRING }, async (t) => {
  if (process.platform !== 'linux') { t.skip('Linux Secret Service integration'); return; }
  assertPrivateKeyringSession(process.env);
  const require = createRequire(import.meta.url);
  const dbus = require('@homebridge/dbus-native');
  const bus = dbus.sessionBus({ busAddress: process.env.DBUS_SESSION_BUS_ADDRESS });
  const call = (path: string, iface: string, member: string, signature = '', body: unknown[] = []): Promise<any> => new Promise((resolve, reject) => {
    bus.invoke({ destination: 'org.freedesktop.secrets', path, interface: iface, member, signature, body, flags: 2 },
      (error: unknown, ...values: unknown[]) => error ? reject(new Error('private keyring test call failed')) : resolve(values.length === 1 ? values[0] : values));
  });
  const root = '/org/freedesktop/secrets';
  const iface = 'org.freedesktop.Secret.Service';
  const collection = await call(root, iface, 'ReadAlias', 's', ['default']);
  const lock = async () => {
    const [, prompt] = await call(root, iface, 'Lock', 'ao', [[collection]]);
    assert.equal(prompt, '/', 'locking needs no prompt');
  };
  const unlock = async () => {
    // Test-only private daemon control. Production never calls unlock or prompts.
    const [, session] = await call(root, iface, 'OpenSession', 'sv', ['plain', ['s', '']]);
    await call(root, 'org.gnome.keyring.InternalUnsupportedGuiltRiddenInterface', 'UnlockWithMasterPassword', 'o(oayays)',
      [collection, [session, Buffer.alloc(0), Buffer.from('Umer-test-keyring-password\n'), 'text/plain']]);
    const locked = await call(collection, 'org.freedesktop.DBus.Properties', 'Get', 'ss', ['org.freedesktop.Secret.Collection', 'Locked']);
    assert.equal(locked[1][0], false, 'private collection unlocked');
  };
  const stateDir = scratchDir('locked-real');
  const service = `locked-${randomUUID()}`;
  const o = { stateDir, service, timeoutMs: 1000 };
  const accounts = join(stateDir, 'private', 'accounts.bin');
  const seal = osKeyringSeal(o);
  assert.equal(seal.mode, 'keyring');
  await accountFileStore(accounts, seal).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const accountBytes = readFileSync(accounts);
  const engineRoot = join(stateDir, 'openclaw');
  mkdirSync(join(engineRoot, 'state'), { recursive: true });
  writeFileSync(join(engineRoot, 'state', 'auth.json'), CANARY, { mode: 0o600 });
  const initial = new OpenClawKit({ stateDir, authSeal: seal, spawnEngine: false });
  await initial.prepare();
  const engineFile = join(engineRoot, 'auth-store.sealed');
  const engineBytes = readFileSync(engineFile);
  try {
    await lock();
    const start = Date.now();
    const locked = osKeyringSeal(o);
    const store = accountFileStore(accounts, locked);
    await assert.rejects(store.read('provider'), code('keyring-locked'));
    await assert.rejects(store.delete('provider'), code('keyring-locked'));
    assert.ok(Date.now() - start < 5000, 'all locked probes are bounded');
    assert.deepEqual(readFileSync(accounts), accountBytes);
    const fake = fakeGateway();
    const kit = new OpenClawKit({ stateDir, authSeal: locked, spawnEngine: false, transport: fake.factory });
    await kit.prepare(); await kit.start();
    assert.equal(kit.state.phase, 'locked');
    assert.deepEqual(readFileSync(engineFile), engineBytes);
    assert.equal(existsSync(join(engineRoot, 'state', 'auth.json')), false);
    await unlock();
    // Same fallback-selected adapter and a fresh one both honor mode 1 after unlock.
    assert.equal((await store.read('provider'))?.type, 'api_key');
    assert.equal((await accountFileStore(accounts, osKeyringSeal(o)).read('provider'))?.type, 'api_key');
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.equal(readFileSync(join(engineRoot, 'state', 'auth.json'), 'utf8'), CANARY);
    await kit.stop();
    const dual = osKeyringSeal({ ...o, dualWrap: true });
    assert.equal((await accountFileStore(accounts, dual).read('provider'))?.type, 'api_key');
    const dualBytes = readFileSync(accounts);
    assert.equal(dualBytes[4], 3, 'read atomically upgraded the original mode-1 store');
    const direct = Buffer.from(dual.encryptString(CANARY));
    const dualKit = new OpenClawKit({ stateDir, authSeal: dual, spawnEngine: false, transport: fake.factory });
    await dualKit.prepare();
    assert.equal(readFileSync(engineFile)[4], 3);
    await lock();
    const lockedDual = osKeyringSeal({ ...o, dualWrap: true });
    assert.equal(lockedDual.decryptString(direct), CANARY);
    assert.equal((await accountFileStore(accounts, lockedDual).read('provider'))?.type, 'api_key');
    assert.deepEqual(readFileSync(accounts), dualBytes);
    await dualKit.start();
    assert.equal(dualKit.state.phase, 'ready');
    await unlock();
    await dualKit.stop();
  } finally { try { await unlock(); } finally { bus.connection.stream.end(); } }
});
