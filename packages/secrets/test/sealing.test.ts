import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs, { readFileSync, writeFileSync, readdirSync, statSync, chmodSync, existsSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileStore } from '../../accounts/src/node-stores.ts';
import { scratchDir } from '../../test-support.ts';
import { openSecretBox } from '@byokit/seal';
import { hostKeyFileDirectory } from '../src/host-key-file.ts';
import { decrypt, encrypt, makeHeader } from '../src/sealing.ts';
import { hostKeyFileSeal, hostKeySeal, osKeyring, osKeyringSeal, osKeyringStore, type KeyringBackend } from '../src/index.ts';
import { assertPrivateKeyringSession } from './private-session.ts';

const SEAL_STATE = scratchDir('seal-state');
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

test('keyring-only stores survive locked open and unlock without changing ciphertext', async () => {
  const { ring } = fakeRing();
  const o = { service: 'locked-open', stateDir: scratchDir('locked-open'), keyring: ring };
  const path = join(o.stateDir, 'private', 'accounts.bin');
  await fileStore(path, osKeyringSeal(o)).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const bytes = readFileSync(path);
  const get = ring.get;
  ring.get = () => { throw new Error('locked'); };
  const reopened = fileStore(path, osKeyringSeal(o));
  await assert.rejects(reopened.read('provider'), code('keyring-locked'));
  await assert.rejects(reopened.delete('provider'), code('keyring-locked'));
  assert.deepEqual(readFileSync(path), bytes);
  ring.get = get;
  assert.equal((await reopened.read('provider'))?.type, 'api_key');
  assert.ok(existsSync(hostKeyFileDirectory(o)), 'locked construction created a fallback directory');
  assert.equal((await fileStore(path, osKeyringSeal(o)).read('provider'))?.type, 'api_key', 'fallback directory cannot override a mode-1 header');
  assert.deepEqual(readFileSync(path), bytes);
});

test('dual wrapping opens while locked, authenticates both wraps and atomically upgrades keyring-only stores', async () => {
  const { ring } = fakeRing();
  const o = { service: 'dual-test', stateDir: scratchDir('dual-wrap'), keyring: ring };
  const path = join(o.stateDir, 'private', 'accounts.bin');
  await fileStore(path, osKeyringSeal(o)).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const original = readFileSync(path);
  assert.equal(original[4], 1);
  const dual = osKeyringSeal({ ...o, dualWrap: true });
  const upgraded = fileStore(path, dual);
  // A failed atomic rename leaves the original envelope/key intact and retryable.
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => { if (to === path) throw new Error('interrupted'); return rename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { await assert.rejects(upgraded.read('provider'), /interrupted/); }
  finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.deepEqual(readFileSync(path), original);
  assert.equal((await upgraded.read('provider'))?.type, 'api_key');
  const bytes = readFileSync(path);
  assert.equal(bytes[4], 3);
  assert.ok(!bytes.includes(Buffer.from(CANARY)));
  const hostPath = join(o.stateDir, 'private', 'host.bin');
  await fileStore(hostPath, hostKeyFileSeal(o)).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const hostBytes = readFileSync(hostPath);
  const directlySealed = Buffer.from(dual.encryptString(CANARY));
  const get = ring.get;
  ring.get = () => { throw new Error('locked'); };
  const locked = osKeyringSeal({ ...o, dualWrap: true });
  assert.equal(locked.decryptString(directlySealed), CANARY);
  assert.equal((await fileStore(hostPath, locked).read('provider'))?.type, 'api_key');
  assert.deepEqual(readFileSync(hostPath), hostBytes, 'mode-2 stores are not upgraded');
  assert.equal((await fileStore(path, locked).read('provider'))?.type, 'api_key');
  assert.deepEqual(readFileSync(path), bytes);
  // Even the inaccessible keyring wrap is bound into the payload authentication.
  for (const at of [0, 4, 5, 21, 25, 29, 55, 29 + bytes.readUInt32BE(21) + 50, bytes.length - 1]) {
    const tampered = Buffer.from(bytes); tampered[at] ^= at === 4 ? 128 : 1;
    assert.throws(() => locked.decryptString(tampered), code('auth-failed'));
  }
  ring.get = get;
  assert.equal(osKeyringSeal(o).decryptString(bytes), dual.decryptString(bytes));
  assert.equal(dual.decryptString(original), osKeyringSeal(o).decryptString(original));
  assert.throws(() => osKeyringSeal({ ...o, dualWrap: true, fallback: false }), code('invalid'));
});

test('real-keyring guard refuses the user bus, missing proof and inherited desktop settings before native calls', () => {
  const root = '/tmp/ks.Umer01';
  const bus = 'unix:path=/tmp/dbus-Umer123,guid=abcdef';
  const isolated = {
    BYOKIT_KEYRING_TEST_ROOT: root, DBUS_SESSION_BUS_ADDRESS: bus, BYOKIT_KEYRING_TEST_BUS: bus,
    BYOKIT_KEYRING_OWNER_BUS: 'unix:path=/run/user/1000/bus',
    XDG_RUNTIME_DIR: `${root}/runtime`, XDG_DATA_HOME: `${root}/data`,
    XDG_CONFIG_HOME: `${root}/config`, XDG_CACHE_HOME: `${root}/cache`,
  };
  assert.doesNotThrow(() => assertPrivateKeyringSession(isolated));
  for (const change of [
    { BYOKIT_KEYRING_TEST_BUS: undefined },
    { DBUS_SESSION_BUS_ADDRESS: isolated.BYOKIT_KEYRING_OWNER_BUS },
    { BYOKIT_KEYRING_OWNER_BUS: bus },
    { GNOME_KEYRING_CONTROL: '/run/user/1000/keyring' },
    { DBUS_STARTER_ADDRESS: isolated.BYOKIT_KEYRING_OWNER_BUS },
    { XDG_DATA_HOME: '/owner/data' },
    { XDG_CONFIG_HOME: '/owner/config' },
    { XDG_CACHE_HOME: '/owner/cache' },
    { XDG_RUNTIME_DIR: '/run/user/1000' },
    { BYOKIT_KEYRING_TEST_ROOT: '/owner/home' },
  ]) assert.throws(() => assertPrivateKeyringSession({ ...isolated, ...change }), /private OS session/);
  assert.throws(() => assertPrivateKeyringSession({ BYOKIT_REAL_KEYRING: '1' }), /private OS session/);
});

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
  const seal = osKeyringSeal({ stateDir: SEAL_STATE, service: 'Umer', keyring: ring });
  assert.equal(data.size, 0, 'construction probes availability without creating a key');
  const path = join(scratchDir('os-seal'), 'private', 'accounts.bin');
  const store = fileStore(path, seal);
  await store.modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const oldFile = readFileSync(path);
  assert.ok(!oldFile.includes(Buffer.from(CANARY)));
  assert.ok(!JSON.stringify([...data.values()]).includes(CANARY), 'keyring holds only data keys and an active id');
  assert.equal(data.size, 2);
  assert.equal((await fileStore(path, osKeyringSeal({ stateDir: SEAL_STATE, service: 'Umer', keyring: ring })).read('provider'))?.type, 'api_key');
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
  const seal = osKeyringSeal({ stateDir: SEAL_STATE, service: 'Umer', keyring: ring });
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
  assert.throws(() => osKeyringSeal({ stateDir: SEAL_STATE, service: 'another-service', keyring: ring }).decryptString(original), code('auth-failed'));
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
  const a = osKeyringSeal({ stateDir: SEAL_STATE, service: 'Umer', keyring: ring });
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
  const b = osKeyringSeal({ stateDir: SEAL_STATE, service: 'Umer', keyring: ring });
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
  assert.throws(() => osKeyringSeal({ stateDir: SEAL_STATE, service: 'Umer', keyring: unavailable, fallback: false }), code('unavailable'));
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


const unavailableRing: KeyringBackend = { get() { throw new Error(CANARY); }, set() { throw new Error(CANARY); }, delete() { throw new Error(CANARY); } };
function autoOptions() { return { service: 'headless-test', stateDir: scratchDir('auto-key'), keyring: unavailableRing }; }
const keyFile = (o: {service: string; stateDir: string}) => {
  const dir = hostKeyFileDirectory(o);
  return join(dir, readdirSync(dir).find((name) => name.endsWith('.key'))!);
};

test('headless fallback creates one private key, keeps it across instances and never exposes key bytes', () => {
  const o = autoOptions();
  const a = osKeyringSeal(o);
  assert.equal(a.mode, 'host-key-file');
  const key = readFileSync(keyFile(o));
  const bytes = Buffer.from(a.encryptString(CANARY));
  const b = osKeyringSeal({ ...o, keyring: fakeRing().ring });
  assert.equal(b.mode, 'host-key-file', 'mode cannot flip when keyring becomes available');
  assert.equal(b.decryptString(bytes), CANARY);
  assert.deepEqual(readFileSync(keyFile(o)), key);
  assert.equal(key.length, 32);
  if (process.platform !== 'win32') {
    assert.equal(statSync(keyFile(o)).mode & 0o777, 0o600);
    assert.equal(statSync(hostKeyFileDirectory(o)).mode & 0o777, 0o700);
  }
  assert.ok(!bytes.includes(key));
  assert.ok(!JSON.stringify(a).includes(key.toString('hex')));
  assert.ok(!JSON.stringify(a).includes(key.toString('base64')));
  const explicit = hostKeySeal({ key: Buffer.alloc(32, 7) });
  assert.equal(explicit.mode, 'host-key');
  assert.equal(osKeyringSeal({ service: 'other', stateDir: o.stateDir, keyring: fakeRing().ring }).mode, 'keyring');
});

test('insecure key/directory permissions, symlinks and foreign ownership are refused', { skip: process.platform === 'win32' }, () => {
  const o = autoOptions();
  const seal = hostKeyFileSeal(o);
  const key = keyFile(o);
  for (const mode of [0o640, 0o604, 0o666]) {
    chmodSync(key, mode);
    assert.throws(() => hostKeyFileSeal(o), code('invalid'));
    assert.throws(() => seal.encryptString(CANARY), code('invalid'));
  }
  chmodSync(key, 0o600);
  chmodSync(hostKeyFileDirectory(o), 0o750);
  assert.throws(() => hostKeyFileSeal(o), code('invalid'));
  chmodSync(hostKeyFileDirectory(o), 0o700);
  const originalFstat = fs.fstatSync;
  fs.fstatSync = ((...args: Parameters<typeof fs.fstatSync>) => ({ ...originalFstat(...args), uid: process.getuid!() + 1, isFile: () => true })) as typeof fs.fstatSync;
  syncBuiltinESMExports();
  try { assert.throws(() => hostKeyFileSeal(o), code('invalid')); }
  finally { fs.fstatSync = originalFstat; syncBuiltinESMExports(); }
  const bytes = readFileSync(key);
  const target = join(o.stateDir, 'target'); writeFileSync(target, bytes, { mode: 0o600 });
  rmSync(key); symlinkSync(target, key);
  assert.throws(() => hostKeyFileSeal(o), code('invalid'));
});

test('concurrent processes on first use publish one complete key and can open each others envelopes', async () => {
  const o = autoOptions();
  const module = new URL('../src/index.ts', import.meta.url).href;
  const program = `import { hostKeyFileSeal } from ${JSON.stringify(module)}; const s=hostKeyFileSeal(${JSON.stringify({ service: o.service, stateDir: o.stateDir })}); process.stdout.write(Buffer.from(s.encryptString('race')).toString('base64'));`;
  const outputs = await Promise.all(Array.from({ length: 8 }, () => new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program]);
    const output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on('data', (b) => output.push(b)); child.stderr.on('data', (b) => errors.push(b));
    child.on('error', reject);
    child.on('exit', (status) => status === 0 ? resolve(Buffer.from(Buffer.concat(output).toString(), 'base64')) : reject(new Error(Buffer.concat(errors).toString())));
  })));
  const seal = hostKeyFileSeal(o);
  for (const output of outputs) assert.equal(seal.decryptString(output), 'race');
  assert.equal(readdirSync(hostKeyFileDirectory(o)).filter((f) => f.endsWith('.key')).length, 1);
});

test('rotation reseals stores and archives, removes the old key and resumes after an interrupted write', () => {
  const o = autoOptions();
  const a = hostKeyFileSeal(o);
  const oldKey = keyFile(o), oldBytes = Buffer.from(a.encryptString(CANARY));
  const paths = ['store', 'archive'].map((name) => join(o.stateDir, name));
  for (const path of paths) writeFileSync(path, oldBytes, { mode: 0o600 });
  // A filesystem failure on the second replacement leaves a mixed-generation store.
  const originalRename = fs.renameSync;
  fs.renameSync = ((from, to) => { if (to === paths[1]) throw new Error(CANARY); return originalRename(from, to); }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try { assert.throws(() => a.rotate(paths), code('unavailable')); }
  finally { fs.renameSync = originalRename; syncBuiltinESMExports(); }
  assert.ok(existsSync(oldKey));
  assert.ok(existsSync(join(hostKeyFileDirectory(o), 'rotation')));
  const resumed = hostKeyFileSeal(o);
  for (const path of paths) assert.equal(resumed.decryptString(readFileSync(path)), CANARY);
  assert.throws(() => resumed.encryptString('new write'), code('unavailable'));
  resumed.rotate();
  assert.equal(existsSync(oldKey), false);
  assert.equal(existsSync(join(hostKeyFileDirectory(o), 'rotation')), false);
  for (const path of paths) assert.equal(a.decryptString(readFileSync(path)), CANARY);
  assert.throws(() => a.decryptString(oldBytes), code('unavailable'));
  assert.equal(readdirSync(hostKeyFileDirectory(o)).filter((f) => f.endsWith('.key')).length, 1);
  a.rotate(paths);
  for (const path of paths) assert.equal(resumed.decryptString(readFileSync(path)), CANARY);
});

test('private Secret Service: locked/hung probes never unlock or prompt; openclaw prepare uses automatic fallback', { skip: process.platform !== 'linux' || spawnSync('dbus-run-session', ['--version']).status !== 0 }, async () => {
  const root = scratchDir('private-bus');
  const index = new URL('../src/index.ts', import.meta.url).href;
  const engineModule = new URL('../../openclaw/src/engine.ts', import.meta.url).href;
  const testModule = import.meta.url;
  const runner = join(root, 'runner.mjs');
  const childProgram = `
    import assert from 'node:assert/strict';
    import { osKeyringSeal } from ${JSON.stringify(index)};
    import { Engine } from ${JSON.stringify(engineModule)};
    import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
    import { join } from 'node:path';
    const mode = process.argv[1];
    const stateDir = process.argv[2];
    const recovery = process.argv[3];
    const start = Date.now();
    const seal = osKeyringSeal({ service: 'fake-service', stateDir, timeoutMs: 500 });
    if (recovery === 'open') {
      const rawFile = join(stateDir, 'probe.sealed');
      const original = readFileSync(rawFile);
      const states = [];
      const engine = new Engine({ stateDir: join(stateDir, 'engine-state'), authSeal: seal, pluginId: 'byokit', tools: [], spawnEngine: false, onState(s) { states.push(s); }, onExit() {} });
      const file = join(engine.root, 'auth-store.sealed');
      const bytes = readFileSync(file);
      if (mode === 'unlocked') {
        assert.equal(seal.decryptString(original), 'key-canary');
        await engine.start();
        assert.equal(readFileSync(join(engine.root, 'state', 'auth.json'), 'utf8'), 'engine-auth-canary');
        await engine.stop();
      } else {
        assert.throws(() => seal.decryptString(original), e => e.code === 'keyring-locked');
        await engine.prepare();
        assert.equal(await engine.start(), undefined);
        assert.equal(states.at(-1).phase, 'locked');
        assert.deepEqual(readFileSync(file), bytes);
      }
      assert.deepEqual(readFileSync(rawFile), original);
      process.exit(0);
    }
    assert.equal(seal.mode, mode === 'unlocked' ? 'keyring' : 'host-key-file');
    assert.ok(Date.now() - start < 2000, 'probe is bounded');
    const ciphertext = Buffer.from(seal.encryptString('key-canary'));
    assert.equal(seal.decryptString(ciphertext), 'key-canary');
    assert.equal(ciphertext.includes('key-canary'), false);
    writeFileSync(join(stateDir, 'probe.sealed'), ciphertext, { mode: 0o600 });
    const engine = new Engine({ stateDir: join(stateDir, 'engine-state'), authSeal: seal, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} });
    const credentials = join(engine.root, 'state', 'auth.json');
    mkdirSync(join(engine.root, 'state'), { recursive: true });
    writeFileSync(credentials, 'engine-auth-canary');
    await engine.prepare();
    const sealed = join(engine.root, 'auth-store.sealed');
    assert.equal(existsSync(credentials), false);
    assert.equal(readFileSync(sealed).includes('engine-auth-canary'), false);
    await engine.start();
    assert.equal(readFileSync(credentials, 'utf8'), 'engine-auth-canary');
    await engine.stop();
  `;
  writeFileSync(runner, `
    import { createRequire } from 'node:module';
    import { spawn } from 'node:child_process';
    import { mkdirSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const require = createRequire(${JSON.stringify(testModule)});
    const dbus = require('@homebridge/dbus-native');
    const bus = dbus.sessionBus();
    let mode = 'locked', prompts = 0;
    const keys = new Map();
    const rootPath = '/org/freedesktop/secrets', col = rootPath + '/collection/default';
    const service = 'org.freedesktop.Secret.Service', item = 'org.freedesktop.Secret.Item';
    const register = (path, iface, member, signature, handler) => { const exported = bus.exportedObjects[path]?.[iface]; if (exported) { exported[0].methods[member] = ['', signature]; exported[1][member] = handler; } else bus.setMethodCallHandler(path, iface, member, [handler, signature]); };
    register(rootPath, service, 'ReadAlias', 'o', () => mode === 'hung' ? new Promise(() => {}) : col);
    bus.exportInterface({ get Locked() { return mode === 'locked'; } }, col, { name: 'org.freedesktop.Secret.Collection', methods: {}, properties: { Locked: 'b' } });
    register(rootPath, service, 'SearchItems', 'aoao', (attrs) => {
      const username = attrs.find(([name]) => name === 'username')[1];
      return [keys.has(username) ? [rootPath + '/item/' + Buffer.from(username).toString('hex')] : [], []];
    });
    register(rootPath, service, 'OpenSession', 'vo', () => [['s', ''], rootPath + '/session/test']);
    register(col, 'org.freedesktop.Secret.Collection', 'CreateItem', 'oo', (props, value) => {
      const attrs = props.find(([name]) => name.endsWith('.Attributes'))[1][1][0];
      const username = attrs.find(([name]) => name === 'username')[1];
      const path = rootPath + '/item/' + Buffer.from(username).toString('hex');
      keys.set(username, Buffer.from(value[2]));
      register(path, item, 'GetSecret', '(oayays)', () => [rootPath + '/session/test', Buffer.alloc(0), keys.get(username), 'text/plain']);
      register(path, item, 'Delete', 'o', () => { keys.delete(username); return '/'; });
      return [path, '/'];
    });
    register(rootPath, service, 'Unlock', 'aoo', () => { prompts++; throw new Error('unlock requested'); });
    bus.connection.on('message', (message) => { if (message.member === 'Prompt' || message.member === 'Unlock' || message.member === 'CreateCollection') prompts++; });
    await new Promise((resolve, reject) => bus.requestName('org.freedesktop.secrets', 0, (error) => error ? reject(error) : resolve()));
    for (mode of ['locked', 'hung', 'unlocked']) {
      const stateDir = ${JSON.stringify(root)} + '/' + mode;
      mkdirSync(stateDir, { mode: 0o700 });
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childProgram)}, mode, stateDir], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
      });
    }
    const recoveryDir = ${JSON.stringify(root)} + '/recovery';
    mkdirSync(recoveryDir, { mode: 0o700 });
    for (const phase of ['unlocked', 'locked', 'hung', 'unlocked']) {
      mode = phase;
      const operation = phase === 'unlocked' && !keys.has('recovery-created') ? 'seal' : 'open';
      keys.set('recovery-created', Buffer.alloc(0));
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childProgram)}, mode, recoveryDir, operation], { stdio: ['ignore', 'pipe', 'pipe'] });
        let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
      });
    }
    assert.equal(prompts, 0);
    bus.connection.stream.end();
    process.exit(0);
  `);
  await new Promise<void>((resolve, reject) => {
    // Inherited owner bus/control/XDG data are absent; dbus-run-session creates the only bus.
    const child = spawn('dbus-run-session', ['--', process.execPath, runner], { env: { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, NODE_OPTIONS: process.env.NODE_OPTIONS } });
    let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
    child.on('error', reject); child.on('exit', status => {
      assert.ok(!output.includes(CANARY));
      status === 0 ? resolve() : reject(new Error(output));
    });
  });
});

test('a payload past the envelope chunk seals to the exact JSON envelope and round-trips across the chunk boundary', () => {
  const CHUNK = 1 << 20;
  const service = 'byokit-host-key';
  const key = Buffer.alloc(32, 5);
  const header = makeHeader(0, Buffer.alloc(16));
  const head = '"\\\n\u0001\u0007 quoted   tail';
  const text = head + 'y'.repeat(CHUNK - 1 - head.length) + '😀' + '"\\\u0002' + 'z'.repeat(CHUNK + 4096) + '\ud83d';
  assert.equal(text.charCodeAt(CHUNK - 1), 0xd83d, 'a surrogate pair starts at the last unit of the first chunk');
  const sealed = Buffer.from(encrypt(text, key, header, service));
  const plain = openSecretBox(sealed.subarray(header.length), key);
  assert.ok(plain, 'the envelope authenticates under the key');
  assert.deepEqual(Buffer.from(plain.subarray(header.length)), Buffer.from(JSON.stringify({ service, text })));
  assert.equal(decrypt(sealed, key, header, service), text);
});
