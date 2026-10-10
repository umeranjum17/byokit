// Consumer journeys for the published @byokit/secrets surface, driven the way a host app uses it:
// `keyringStore`, `fileStore`, `overrideStore`, `osKeyringStore`, and the sealing adapters
// (`osKeyringSeal`, `hostKeySeal`, `hostKeyFileSeal`) are what a host passes around; `@byokit/secrets/web` and
// `@byokit/secrets/native` are the browser and phone entries; `@byokit/accounts` is the accounts file a sealing
// adapter protects. The journeys import those published entries plus three test helpers: `fake-cli.ts` (fake keyring
// tools), `private-session.ts` (the real-keyring guard) and `scratchDir` from test-support. Cross-process cases spawn
// the built `dist/index.js`. Each journey folds the security and correctness contracts it covers into its assertions.
// The journeys never touch the owner's keyring: keyring work drives fake CLIs, or a private D-Bus session started
// for the test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { webcrypto, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import { openSecretBox } from '@byokit/seal';
import { fileStore as accountFileStore } from '@byokit/accounts';
import {
  KeystoreError, keyringEnv, keyringStore, fileStore, overrideStore, writeFileAtomic,
  osKeyring, osKeyringStore, osKeyringSeal, hostKeySeal, hostKeyFileSeal, type KeyringBackend,
} from '@byokit/secrets';
import { webStore } from '@byokit/secrets/web';
import { nativeStore, type SecureStoreLike } from '@byokit/secrets/native';
import { scratchDir } from '../../test-support.ts';
import { writeFakeCli, type FakeTool } from './fake-cli.ts';
import { assertPrivateKeyringSession } from './private-session.ts';

const CANARY = 'sk-canary-secrets-6b1f';
// A canary never appears in an error's text, and the code is the typed one the caller branches on.
const code = (want: string) => (e: unknown) => e instanceof KeystoreError && e.code === want && !String((e as Error).message).includes(CANARY);
const key32 = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) & 0xff);
const distIndex = new URL('../dist/index.js', import.meta.url).href;

function bench(tool: FakeTool, extra: Record<string, string> = {}) {
  const dir = scratchDir(`secrets-${tool}`);
  const bin = writeFakeCli(dir, tool);
  const log = join(dir, 'invocations.jsonl');
  const state = join(dir, 'state.json');
  const canaryFile = join(dir, 'canary.txt');
  writeFileSync(canaryFile, CANARY);
  const env = { FAKE_TOOL: tool, FAKE_LOG: log, FAKE_STATE: state, FAKE_CANARY_FILE: canaryFile, ...extra };
  const make = (service = 'byokit-secrets') => keyringStore({ bin, tool, service, env });
  const calls = () => invocations(log);
  return { dir, bin, tool, env, make, calls };
}

type Invocation = { argv: string[]; env: Record<string, string>; stdinBytes: number; selfCheck?: string };
function invocations(log: string): Invocation[] {
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation);
}

function runChild(file: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: Buffer; output: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], all: Buffer[] = [];
    child.stdout.on('data', (b) => { stdout.push(b); all.push(b); });
    child.stderr.on('data', (b) => all.push(b));
    child.on('error', reject);
    child.on('close', (status) => resolveRun({ status, stdout: Buffer.concat(stdout), output: Buffer.concat(all).toString() }));
  });
}

async function withPatchedFs<K extends 'fstatSync' | 'renameSync'>(name: K, patch: (real: (typeof fs)[K]) => (typeof fs)[K], run: () => unknown): Promise<void> {
  const real = fs[name];
  fs[name] = patch(real);
  syncBuiltinESMExports();
  try { await run(); }
  finally { fs[name] = real; syncBuiltinESMExports(); }
}

function walk(dir: string, visit: (path: string, name: string) => void): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit); else visit(path, entry.name);
  }
}

function snapshot(home: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  walk(home, (path) => files.set(path, readFileSync(path)));
  return files;
}

function keyFiles(root: string): string[] {
  const found: string[] = [];
  walk(root, (path, name) => { if (name.endsWith('.key')) found.push(path); });
  return found;
}

function onlyKey(root: string): string {
  const found = keyFiles(root);
  assert.equal(found.length, 1, `expected exactly one key under ${root}`);
  return found[0];
}

function fakeRing() {
  const data = new Map<string, string>();
  const state = { locked: false };
  const calls = { get: 0, set: 0, delete: 0 };
  const backend: KeyringBackend = {
    get: (name) => { calls.get++; if (state.locked) throw new Error('locked'); return data.get(name) ?? null; },
    set: (name, value) => { calls.set++; if (state.locked) throw new Error('locked'); data.set(name, value); },
    delete: (name) => { calls.delete++; if (state.locked) throw new Error('locked'); return data.delete(name); },
  };
  return { backend, data, state, calls };
}

test('an app keeps one secret per name in the OS keyring, with the value only ever on stdin', async (ctx) => {
  for (const tool of ['secret-tool', 'security'] as const) {
    const { make, calls } = bench(tool);
    const store = make();
    assert.equal(await store.get('openai'), null);
    assert.equal(await store.delete('openai'), false);
    await store.set('openai', CANARY);
    assert.equal(await store.get('openai'), CANARY);
    // The keyring is partitioned by service: another app's namespace never sees this secret.
    assert.equal(await make('other-app').get('openai'), null);
    // Unicode and inner newlines round-trip unchanged.
    const multiline = 'line one\nline two ✓\nno trailing';
    await store.set('multi', multiline);
    assert.equal(await store.get('multi'), multiline);
    assert.equal(await store.delete('openai'), true);
    assert.equal(await store.get('openai'), null);
    assert.equal(await store.delete('openai'), false);

    // Label scoping is visible on the wire as the tool's own service/account fields.
    const seen = calls();
    assert.ok(seen.length >= 4);
    if (tool === 'security') {
      assert.ok(seen.some((c) => c.argv[0] === 'add-generic-password' && c.argv.includes('-s') && c.argv.includes('byokit-secrets') && c.argv.includes('-a') && c.argv.includes('openai')));
    } else {
      assert.ok(seen.some((c) => c.argv[0] === 'store' && c.argv.includes('--label=byokit:byokit-secrets:openai')));
      assert.ok(seen.some((c) => c.argv.includes('service') && c.argv.includes('account')));
    }
    // D-C: the secret reaches the CLI on stdin only — never its argv or its environment.
    for (const call of seen) {
      assert.equal(call.selfCheck, undefined, 'the CLI saw the secret in argv or env');
      for (const arg of call.argv) assert.ok(!arg.includes(CANARY), `secret in argv: ${arg}`);
      for (const value of Object.values(call.env)) assert.ok(!String(value).includes(CANARY), 'secret in spawn env');
    }
    assert.ok(seen.some((c) => c.stdinBytes === Buffer.byteLength(CANARY)), 'the secret arrived on stdin');
  }

  // Every spawn gets exactly the base env plus host extras; process.env is never consulted.
  const extra = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/fake' };
  const { make, calls } = bench('secret-tool', extra);
  await make().set('openai', CANARY);
  for (const env of calls().map((c) => c.env)) {
    assert.deepEqual(Object.keys(env).sort(),
      ['FAKE_CANARY_FILE', 'FAKE_LOG', 'FAKE_STATE', 'FAKE_TOOL', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'PATH'].sort());
    assert.equal(env.PATH, '/usr/bin:/bin');
    assert.equal(env.LANG, 'C.UTF-8');
    assert.equal(env.DBUS_SESSION_BUS_ADDRESS, extra.DBUS_SESSION_BUS_ADDRESS);
  }
  assert.deepEqual(keyringEnv(), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
  assert.deepEqual(keyringEnv({ A: '1' }), { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', A: '1' });
  assert.throws(() => keyringEnv({ A: 'has\0nul' }), code('invalid'));

  // Names and secrets are validated before any spawn; a bad binary fails with its own code.
  const bad = bench('secret-tool');
  await assert.rejects(bad.make().get(''), code('invalid'));
  await assert.rejects(bad.make().get('has\0nul'), code('invalid'));
  await assert.rejects(bad.make().set('ok', 'x'.repeat(1024 * 1024 + 1)), code('invalid'));
  assert.throws(() => keyringStore({ bin: 'relative/fake', tool: 'secret-tool' }), code('invalid'));
  assert.throws(() => keyringStore({ bin: join(bad.dir, 'nope'), tool: 'secret-tool' }), code('unavailable'));
  const plain = join(bad.dir, 'plain.txt');
  writeFileSync(plain, 'x');
  assert.throws(() => keyringStore({ bin: plain, tool: 'secret-tool' }), code('unavailable'));

  // The native backend forces persistent Secret Service on every call and never reports entry text in errors.
  const nativeCalls: { service: string; name: string; options: unknown }[] = [];
  const nativeData = new Map<string, string>();
  const native = osKeyringStore({ service: 'Umer', entry(service, name, options) {
    nativeCalls.push({ service, name, options });
    return {
      getPassword: () => nativeData.get(name) ?? null,
      setPassword: (secret) => { nativeData.set(name, secret); },
      deleteCredential: () => nativeData.delete(name),
    };
  } });
  assert.equal(await native.get('api'), null);
  assert.equal(await native.delete('api'), false);
  await native.set('api', CANARY);
  assert.equal(await native.get('api'), CANARY);
  assert.equal(await native.delete('api'), true);
  for (const call of nativeCalls) assert.deepEqual(call, { service: 'Umer', name: 'api', options: { linux: { store: 'secret-service' } } });
  assert.ok(!JSON.stringify(nativeCalls).includes(CANARY));
  const unavailable = osKeyring({ service: 'Umer', entry() { throw new Error(CANARY); } });
  assert.throws(() => unavailable.get('api'), code('unavailable'));
  assert.throws(() => unavailable.set('api', CANARY), code('unavailable'));
  assert.throws(() => unavailable.delete('api'), code('unavailable'));
  assert.throws(() => unavailable.get(''), code('invalid'));

  // The real-keyring guard refuses the owner's bus and inherited desktop settings before any native call.
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
  if (process.platform !== 'linux' || spawnSync('dbus-run-session', ['--version']).status !== 0) ctx.diagnostic('skipped: the private Secret Service probe needs Linux and dbus-run-session');
  else await privateSecretService();
});

test('a poisoned environment changes nothing: no secret is read from it and no spawn inherits it', async () => {
  const dir = scratchDir('secrets-env');
  const saved = { ...process.env };
  const MARKER = 'env-poison-marker-zz9';
  try {
    process.env.PATH = `/nonexistent-${MARKER}`;
    process.env.HOME = join(dir, 'decoy-home');
    process.env.VICTIM_NAME = CANARY;
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) process.env[name] = CANARY;
    process.env.DBUS_SESSION_BUS_ADDRESS = `${MARKER}-bus`;

    // The override backend consults only the map the host passes, never the environment.
    const over = overrideStore({});
    assert.equal(await over.get('VICTIM_NAME'), null);
    assert.equal(await over.get('OPENAI_API_KEY'), null);

    // The file backend works under the poisoned env (absolute paths, no env reads).
    const file = fileStore({ path: join(dir, 'keys.json'), passphrase: 'pass' });
    await file.set('openai', CANARY);
    assert.equal(await file.get('openai'), CANARY);

    // The keyring spawn inherits nothing: the fake sees no poison marker.
    const { make, calls } = bench('secret-tool');
    const ring = make();
    await ring.set('openai', CANARY);
    assert.equal(await ring.get('openai'), CANARY);
    const seen = calls();
    assert.ok(seen.length >= 2);
    for (const call of seen) {
      assert.ok(!('VICTIM_NAME' in call.env) && !('OPENAI_API_KEY' in call.env), 'process.env leaked into the spawn');
      assert.ok(!Object.values(call.env).some((v) => String(v).includes(MARKER)), 'poison value in spawn env');
    }

    // The automatic helpers keep their mode and round-trip under credential variables, and no credential reaches a file.
    const offline = osKeyring({ service: 'byokit-env', entry() { throw new Error(CANARY); } });
    const auto = { service: 'byokit-env', stateDir: join(dir, 'auto'), keyring: offline };
    const autoSeal = osKeyringSeal(auto);
    assert.equal(autoSeal.mode, 'host-key-file');
    const autoBytes = Buffer.from(autoSeal.encryptString('round-trip'));
    const hostOpts = { service: 'byokit-env', stateDir: join(dir, 'host') };
    const hostSeal = hostKeyFileSeal(hostOpts);
    assert.equal(hostSeal.mode, 'host-key-file');
    const hostBytes = Buffer.from(hostSeal.encryptString('round-trip'));
    const reopen = () => {
      assert.equal(osKeyringSeal(auto).decryptString(autoBytes), 'round-trip');
      assert.equal(hostKeyFileSeal(hostOpts).decryptString(hostBytes), 'round-trip');
    };
    reopen();
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY']) delete process.env[name];
    reopen();
    for (const bytes of [...snapshot(auto.stateDir).values(), ...snapshot(hostOpts.stateDir).values()]) {
      assert.ok(!bytes.includes(Buffer.from(CANARY)), 'a credential variable reached a sealed file');
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('secrets live in a passphrase-sealed file or a host override; a wrong passphrase, tampering or truncation fails closed', async () => {
  // The override is a validated copy the host passes, one secret per name.
  const over = overrideStore({ openai: CANARY });
  assert.equal(await over.get('openai'), CANARY);
  assert.equal(await over.get('missing'), null);
  await over.set('new', 'x');
  assert.equal(await over.get('new'), 'x');
  assert.equal(await over.delete('new'), true);
  assert.equal(await over.delete('new'), false);
  assert.throws(() => overrideStore({ '': 'x' }), code('invalid'));
  assert.throws(() => overrideStore(null as never), code('invalid'));

  // The sealed file round-trips, missing is null/false, several names coexist.
  const dir = scratchDir('secrets-file');
  const path = join(dir, 'sub', 'keys.json');
  const store = fileStore({ path, passphrase: 'correct horse' });
  assert.equal(await store.get('openai'), null);
  assert.equal(await store.delete('openai'), false);
  await store.set('openai', CANARY);
  await store.set('second', 'value-2');
  assert.equal(await store.get('openai'), CANARY);
  assert.equal(await store.get('second'), 'value-2');
  assert.equal(await store.delete('openai'), true);
  assert.equal(await store.get('openai'), null);
  assert.equal(await store.get('second'), 'value-2');

  // The file at rest holds no plaintext, and its header names its version and KDF.
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes(CANARY), 'plaintext secret in the sealed file');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.kdf, 'scrypt-16384-8-1');

  // A wrong passphrase fails closed and writes nothing; the right one still reads.
  const wrong = fileStore({ path, passphrase: 'wrong' });
  const before = readFileSync(path);
  await assert.rejects(wrong.get('second'), code('auth-failed'));
  await assert.rejects(wrong.set('second', 'attacker'), code('auth-failed'));
  await assert.rejects(wrong.delete('second'), code('auth-failed'));
  assert.deepEqual(readFileSync(path), before, 'a failed open wrote something');
  assert.equal(await fileStore({ path, passphrase: 'correct horse' }).get('second'), 'value-2');

  // Tampering and truncation of the sealed box are refused.
  const tamperedPath = join(dir, 'tampered.json');
  writeFileAtomic(tamperedPath, JSON.stringify({ ...parsed, box: Buffer.from('tampered-box-bytes-padded!!').toString('base64') }));
  await assert.rejects(fileStore({ path: tamperedPath, passphrase: 'correct horse' }).get('openai'), code('auth-failed'));
  const truncatedPath = join(dir, 'truncated.json');
  writeFileAtomic(truncatedPath, JSON.stringify({ ...parsed, box: Buffer.from(parsed.box, 'base64').subarray(0, 8).toString('base64') }));
  await assert.rejects(fileStore({ path: truncatedPath, passphrase: 'correct horse' }).get('openai'), code('auth-failed'));

  // Corrupt files are a plain failure, never an authentication failure.
  const garbage = join(dir, 'garbage.json');
  writeFileAtomic(garbage, 'not json at all');
  await assert.rejects(fileStore({ path: garbage, passphrase: 'x' }).get('a'), code('failed'));
  const wrongShape = join(dir, 'shape.json');
  writeFileAtomic(wrongShape, JSON.stringify({ v: 2 }));
  await assert.rejects(fileStore({ path: wrongShape, passphrase: 'x' }).get('a'), code('failed'));

  // Byte passphrases work; empty passphrases and relative paths are refused.
  const bytes = fileStore({ path: join(dir, 'bytes.json'), passphrase: new TextEncoder().encode('bytes-pass') });
  await bytes.set('a', 'b');
  assert.equal(await bytes.get('a'), 'b');
  assert.throws(() => fileStore({ path: join(dir, 'k.json'), passphrase: '' }), code('invalid'));
  assert.throws(() => fileStore({ path: join(dir, 'k.json'), passphrase: new Uint8Array(0) }), code('invalid'));
  assert.throws(() => fileStore({ path: 'relative/k.json', passphrase: 'x' }), code('invalid'));

  // The exported atomic writer makes 0700 folders and 0600 files and replaces in place.
  const atomic = join(dir, 'deep', 'nested', 'keys.json');
  writeFileAtomic(atomic, '{"a":1}');
  assert.equal(readFileSync(atomic, 'utf8'), '{"a":1}');
  assert.equal((statSync(join(dir, 'deep')).mode & 0o777).toString(8), '700');
  assert.equal((statSync(atomic).mode & 0o777).toString(8), '600');
  writeFileAtomic(atomic, new TextEncoder().encode('bytes'));
  assert.equal(readFileSync(atomic, 'utf8'), 'bytes');
  assert.throws(() => writeFileAtomic('relative.json', 'x'), code('invalid'));
});

test('sealing keeps credentials encrypted and fails closed: wrong, tampered, missing or locked keys never expose or replace data', async (ctx) => {
  // An explicit host key: fresh nonce each time, wrong key and tampered/truncated input refused.
  const key = key32(7);
  const host = hostKeySeal({ key, service: 'byokit-test' });
  const first = Buffer.from(host.encryptString(CANARY));
  const second = Buffer.from(host.encryptString(CANARY));
  assert.notDeepEqual(first, second, 'each encryption has a fresh nonce');
  assert.equal(host.decryptString(first), CANARY);
  assert.equal(host.decryptString(Buffer.from(host.encryptString('\ud800\n\0'))), '\ud800\n\0');
  assert.ok(!first.includes(Buffer.from(CANARY)) && !first.includes(Buffer.from(key)), 'key or secret in the envelope');
  const tampered = Buffer.from(first);
  tampered[5] ^= 1;
  assert.throws(() => host.decryptString(tampered), code('auth-failed'));
  assert.throws(() => host.decryptString(first.subarray(0, 20)), code('auth-failed'));
  assert.throws(() => hostKeySeal({ key, service: 'other' }).decryptString(first), code('auth-failed'));
  for (const bad of [new Uint8Array(31), new Uint8Array(33), 'secret', undefined]) {
    assert.throws(() => hostKeySeal({ key: bad as never }), code('invalid'));
    assert.throws(() => hostKeySeal({ key: () => bad as never }).encryptString(CANARY), code('invalid'));
  }
  assert.throws(() => hostKeySeal({ key: () => { throw new Error('gone'); } }).encryptString(CANARY), code('unavailable'));
  // The host's key is only borrowed: the adapter never zeroes bytes it was handed.
  const owned = randomBytes(32);
  const ownedCopy = Buffer.from(owned);
  hostKeySeal({ key: owned, service: 'byokit-test' }).encryptString(CANARY);
  assert.deepEqual(owned, ownedCopy, 'host-owned key was zeroed');
  // A host key seals an accounts file at rest; a wrong key cannot delete or rewrite it.
  const hostAccounts = join(scratchDir('host-seal'), 'private', 'accounts.bin');
  await accountFileStore(hostAccounts, hostKeySeal({ key: owned, service: 'Umer' })).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const hostBytes = readFileSync(hostAccounts);
  assert.ok(!hostBytes.includes(Buffer.from(CANARY)));
  assert.ok(!hostBytes.includes(owned), 'the host key never lands in the accounts file');
  assert.equal((await accountFileStore(hostAccounts, hostKeySeal({ key: owned, service: 'Umer' })).read('provider'))?.type, 'api_key');
  await assert.rejects(accountFileStore(hostAccounts, hostKeySeal({ key: randomBytes(32), service: 'Umer' })).delete('provider'), code('auth-failed'));
  assert.deepEqual(readFileSync(hostAccounts), hostBytes);
  assert.deepEqual(await accountFileStore(hostAccounts, hostKeySeal({ key: owned, service: 'Umer' })).list(), [{ providerId: 'provider', type: 'api_key' }]);
  let resolverCalls = 0;
  const resolved = hostKeySeal({ key: () => { resolverCalls++; return owned; }, service: 'byokit-test' });
  const resolvedPath = join(scratchDir('host-resolver'), 'private', 'accounts.bin');
  await accountFileStore(resolvedPath, resolved).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  assert.equal((await accountFileStore(resolvedPath, resolved).read('provider'))?.type, 'api_key');
  assert.ok(resolverCalls > 0, 'the resolver supplies the key on every use');

  // Automatic selection falls back to a private host key file when no keyring is available.
  const unavailable: KeyringBackend = { get() { throw new Error('none'); }, set() { throw new Error('none'); }, delete() { throw new Error('none'); } };
  const fbDir = scratchDir('secrets-fallback');
  const fb = osKeyringSeal({ service: 'byokit-fallback', stateDir: fbDir, keyring: unavailable });
  assert.equal(fb.mode, 'host-key-file');
  const fbSealed = Buffer.from(fb.encryptString(CANARY));
  const fbKey = readFileSync(onlyKey(fbDir));
  const late = osKeyringSeal({ service: 'byokit-fallback', stateDir: fbDir, keyring: fakeRing().backend });
  assert.equal(late.mode, 'host-key-file', 'mode cannot flip when a keyring becomes available');
  assert.equal(late.decryptString(fbSealed), CANARY);
  assert.deepEqual(readFileSync(onlyKey(fbDir)), fbKey, 'the host key file is unchanged across instances');
  assert.equal(fbKey.length, 32);
  assert.ok(!JSON.stringify(fb).includes(fbKey.toString('hex')) && !JSON.stringify(fb).includes(fbKey.toString('base64')));
  assert.throws(() => osKeyringSeal({ service: 'x', stateDir: scratchDir('secrets-mandatory'), keyring: unavailable, fallback: false }), code('unavailable'));

  // The automatic host-key file is private on disk, survives restart and never exposes key bytes.
  const stateDir = scratchDir('secrets-host-key');
  const o = { service: 'byokit-test', stateDir };
  const fileSeal = hostKeyFileSeal(o);
  assert.equal(fileSeal.mode, 'host-key-file');
  const ciphertext = Buffer.from(fileSeal.encryptString(CANARY));
  assert.equal(hostKeyFileSeal(o).decryptString(ciphertext), CANARY, 'one persisted key opens every instance');
  const keyPath = onlyKey(stateDir);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(dirname(keyPath)).mode & 0o777, 0o700);
  assert.ok(!ciphertext.includes(Buffer.from(CANARY)) && !ciphertext.includes(readFileSync(keyPath)));
  // Rotation re-seals under a fresh key and retires the old generation.
  const storePath = join(stateDir, 'store.bin');
  writeFileAtomic(storePath, fileSeal.encryptString(CANARY));
  fileSeal.rotate([storePath]);
  assert.equal(hostKeyFileSeal(o).decryptString(readFileSync(storePath)), CANARY);
  assert.equal(keyFiles(stateDir).length, 1);
  assert.throws(() => fileSeal.decryptString(ciphertext), code('unavailable'));
  // Insecure key permissions and a symlinked key are refused.
  const currentKey = onlyKey(stateDir);
  chmodSync(currentKey, 0o640);
  assert.throws(() => hostKeyFileSeal(o), code('invalid'));
  chmodSync(currentKey, 0o600);
  const target = join(stateDir, 'target');
  writeFileSync(target, readFileSync(currentKey), { mode: 0o600 });
  rmSync(currentKey);
  symlinkSync(target, currentKey);
  assert.throws(() => hostKeyFileSeal(o), code('invalid'));

  // Eight processes racing on first use publish one complete key, and each opens the others' envelopes.
  const race = { service: 'byokit-race', stateDir: scratchDir('secrets-race') };
  const program = `import { hostKeyFileSeal } from ${JSON.stringify(distIndex)}; const s = hostKeyFileSeal(${JSON.stringify(race)}); process.stdout.write(Buffer.from(s.encryptString('race')).toString('base64'));`;
  const outputs = await Promise.all(Array.from({ length: 8 }, async () => {
    const { status, stdout, output } = await runChild(process.execPath, ['--input-type=module', '-e', program]);
    if (status !== 0) throw new Error(output);
    return Buffer.from(stdout.toString(), 'base64');
  }));
  const raceSeal = hostKeyFileSeal(race);
  for (const output of outputs) assert.equal(raceSeal.decryptString(output), 'race');
  assert.equal(keyFiles(race.stateDir).length, 1);

  // Rotation resumes after an interrupted second replacement: the old key stays until every store is rewritten.
  const rot = { service: 'byokit-rotate', stateDir: scratchDir('secrets-rotate') };
  const rotating = hostKeyFileSeal(rot);
  const retired = onlyKey(rot.stateDir);
  const retiredBytes = Buffer.from(rotating.encryptString(CANARY));
  const rotPaths = ['store', 'archive'].map((name) => join(rot.stateDir, name));
  for (const path of rotPaths) writeFileAtomic(path, retiredBytes);
  await withPatchedFs('renameSync', (real) => ((from, to) => { if (to === rotPaths[1]) throw new Error(CANARY); return real(from, to); }) as typeof fs.renameSync,
    () => assert.throws(() => rotating.rotate(rotPaths), code('unavailable')));
  assert.ok(existsSync(retired), 'the old key stays until every store is rewritten');
  const resumed = hostKeyFileSeal(rot);
  for (const path of rotPaths) assert.equal(resumed.decryptString(readFileSync(path)), CANARY, 'a mixed-generation store stays readable');
  assert.throws(() => resumed.encryptString('new write'), code('unavailable'), 'writes wait for the rotation to finish');
  resumed.rotate();
  assert.equal(existsSync(retired), false, 'the old key is retired on completion');
  for (const path of rotPaths) assert.equal(rotating.decryptString(readFileSync(path)), CANARY);
  assert.throws(() => rotating.decryptString(retiredBytes), code('unavailable'));
  assert.equal(keyFiles(rot.stateDir).length, 1);
  rotating.rotate(rotPaths);
  for (const path of rotPaths) assert.equal(resumed.decryptString(readFileSync(path)), CANARY);

  // The OS keyring seal encrypts, rotates and refuses a wrong service, tampering and truncation.
  const ring = fakeRing();
  const ringDir = scratchDir('secrets-ring');
  const ro = { service: 'byokit-test', stateDir: ringDir, keyring: ring.backend };
  const idle = fakeRing();
  osKeyringSeal({ service: 'byokit-idle', stateDir: scratchDir('secrets-idle'), keyring: idle.backend });
  assert.equal(idle.data.size, 0, 'construction probes availability without creating a key');
  const seal = osKeyringSeal(ro);
  assert.equal(seal.mode, 'keyring');
  const sealed = Buffer.from(seal.encryptString(CANARY));
  assert.equal(seal.decryptString(sealed), CANARY);
  assert.ok(!sealed.includes(Buffer.from(CANARY)));
  assert.ok(!JSON.stringify([...ring.data.values()]).includes(CANARY), 'the keyring holds data keys, never the secret');
  assert.throws(() => osKeyringSeal({ ...ro, service: 'other' }).decryptString(sealed), code('auth-failed'));
  for (const at of [0, 4, 5, sealed.length - 1]) {
    const t = Buffer.from(sealed);
    t[at] ^= 1;
    assert.throws(() => seal.decryptString(t), code('auth-failed'));
  }
  for (const length of [0, 20, 60]) assert.throws(() => seal.decryptString(sealed.subarray(0, length)), code('auth-failed'));
  const id = seal.rotateKey();
  assert.match(id, /^[a-f0-9]{32}$/);
  assert.equal(seal.decryptString(sealed), CANARY, 'rotation retains old keys');
  const rotated = Buffer.from(seal.encryptString(CANARY));
  assert.notDeepEqual(rotated, sealed);
  assert.equal(rotated.subarray(5, 21).toString('hex'), id, 'writes after rotation carry the new active key id');

  // Wrong, missing or corrupt data keys fail closed: the accounts file is preserved and no replacement key is generated.
  const wrongDir = scratchDir('secrets-wrong');
  const wrongPath = join(wrongDir, 'private', 'accounts.bin');
  const wrongRing = fakeRing();
  const wrongSeal = osKeyringSeal({ service: 'byokit-wrong', stateDir: wrongDir, keyring: wrongRing.backend });
  await accountFileStore(wrongPath, wrongSeal).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const original = readFileSync(wrongPath);
  for (const at of [0, 4, 5, 21, 45, original.length - 1]) {
    const t = Buffer.from(original);
    t[at] ^= 1;
    assert.throws(() => wrongSeal.decryptString(t), code('auth-failed'));
  }
  for (const length of [0, 20, 60]) assert.throws(() => wrongSeal.decryptString(original.subarray(0, length)), code('auth-failed'));
  assert.throws(() => osKeyringSeal({ service: 'another-service', stateDir: wrongDir, keyring: wrongRing.backend }).decryptString(original), code('auth-failed'));
  const dataKeyName = `byokit-seal-key-v1-${original.subarray(5, 21).toString('hex')}`;
  const realKey = wrongRing.data.get(dataKeyName)!;
  for (const wrong of [randomBytes(32).toString('hex'), 'corrupt', null]) {
    if (wrong === null) wrongRing.data.delete(dataKeyName); else wrongRing.data.set(dataKeyName, wrong);
    await assert.rejects(accountFileStore(wrongPath, wrongSeal).read('provider'), code('auth-failed'));
    await assert.rejects(accountFileStore(wrongPath, wrongSeal).modify('provider', async () => ({ type: 'api_key', key: 'replace' })), code('auth-failed'));
    assert.deepEqual(readFileSync(wrongPath), original);
    assert.equal(wrongRing.data.get(dataKeyName), wrong ?? undefined, 'no replacement key is generated');
  }
  wrongRing.data.set(dataKeyName, realKey);
  assert.equal(JSON.parse(wrongSeal.decryptString(original)).provider.key, CANARY);

  // A failed activation leaves old keys usable; competing initialization cannot orphan ciphertext;
  // a keyring that drops writes fails the read-back.
  const activate = fakeRing();
  const activeOptions = { service: 'byokit-activate', stateDir: scratchDir('secrets-activate'), keyring: activate.backend };
  const a = osKeyringSeal(activeOptions);
  const old = Buffer.from(a.encryptString(CANARY));
  const active = activate.data.get('byokit-seal-active-v1');
  const originalSet = activate.backend.set;
  activate.backend.set = (name, value) => {
    if (name === 'byokit-seal-active-v1') throw new Error(CANARY);
    originalSet(name, value);
  };
  assert.throws(() => a.rotateKey(), code('unavailable'));
  assert.equal(activate.data.get('byokit-seal-active-v1'), active);
  assert.equal(a.decryptString(old), CANARY);
  activate.backend.set = originalSet;
  const b = osKeyringSeal(activeOptions);
  const saved = b.rotateKey();
  const bFile = Buffer.from(b.encryptString('other process'));
  a.rotateKey();
  assert.equal(a.decryptString(bFile), 'other process');
  assert.ok(activate.data.has(`byokit-seal-key-v1-${saved}`));
  assert.equal(b.decryptString(old), CANARY);
  activate.backend.set = () => {};
  assert.throws(() => a.rotateKey(), code('auth-failed'), 'read-back rejects a keyring that drops writes');

  // Dual wrapping opens while the keyring is locked; a keyring-only store is bounded and fails closed.
  const strict = osKeyringSeal({ ...ro, fallback: false });
  const dual = osKeyringSeal({ ...ro, dualWrap: true });
  assert.equal(dual.mode, 'dual-wrap');
  const dbl = Buffer.from(dual.encryptString(CANARY));
  const writesBeforeLock = { set: ring.calls.set, delete: ring.calls.delete };
  ring.state.locked = true;
  try {
    assert.equal(dual.decryptString(dbl), CANARY);
    assert.equal(osKeyringSeal({ ...ro, dualWrap: true }).decryptString(dbl), CANARY);
    assert.throws(() => strict.decryptString(sealed), code('keyring-locked'));
    // A locked keyring is only ever read: the adapter never creates a key, unlocks or prompts.
    assert.deepEqual({ set: ring.calls.set, delete: ring.calls.delete }, writesBeforeLock);
  } finally {
    ring.state.locked = false;
  }

  // Locked keyring: a store read or delete fails with keyring-locked and leaves its bytes unchanged.
  const lockedDir = scratchDir('locked-open');
  const lockedPath = join(lockedDir, 'private', 'accounts.bin');
  const lockedRing = fakeRing();
  const lockedOptions = { service: 'locked-open', stateDir: lockedDir, keyring: lockedRing.backend };
  await accountFileStore(lockedPath, osKeyringSeal(lockedOptions)).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const lockedBytes = readFileSync(lockedPath);
  lockedRing.state.locked = true;
  const reopened = accountFileStore(lockedPath, osKeyringSeal(lockedOptions));
  await assert.rejects(reopened.read('provider'), code('keyring-locked'));
  await assert.rejects(reopened.delete('provider'), code('keyring-locked'));
  assert.deepEqual(readFileSync(lockedPath), lockedBytes);
  lockedRing.state.locked = false;
  assert.equal((await reopened.read('provider'))?.type, 'api_key');
  assert.equal((await accountFileStore(lockedPath, osKeyringSeal(lockedOptions)).read('provider'))?.type, 'api_key', 'a fallback cannot override a mode-1 header');
  assert.deepEqual(readFileSync(lockedPath), lockedBytes);

  // Dual wrap: a failed atomic rename during the upgrade leaves the store retryable; mode-2 stores are not upgraded;
  // tampering with the inaccessible keyring wrap is rejected.
  const upgradeRing = fakeRing();
  const upgradeOptions = { service: 'dual-test', stateDir: scratchDir('dual-wrap'), keyring: upgradeRing.backend };
  const upgradePath = join(upgradeOptions.stateDir, 'private', 'accounts.bin');
  await accountFileStore(upgradePath, osKeyringSeal(upgradeOptions)).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const modeOne = readFileSync(upgradePath);
  assert.equal(modeOne[4], 1);
  const dualOptions = osKeyringSeal({ ...upgradeOptions, dualWrap: true });
  const upgraded = accountFileStore(upgradePath, dualOptions);
  await withPatchedFs('renameSync', (real) => ((from, to) => { if (to === upgradePath) throw new Error('interrupted'); return real(from, to); }) as typeof fs.renameSync,
    () => assert.rejects(upgraded.read('provider'), /interrupted/));
  assert.deepEqual(readFileSync(upgradePath), modeOne);
  assert.equal((await upgraded.read('provider'))?.type, 'api_key');
  const upgradedBytes = readFileSync(upgradePath);
  assert.equal(upgradedBytes[4], 3);
  assert.ok(!upgradedBytes.includes(Buffer.from(CANARY)));
  const hostPath = join(upgradeOptions.stateDir, 'private', 'host.bin');
  await accountFileStore(hostPath, hostKeyFileSeal(upgradeOptions)).modify('provider', async () => ({ type: 'api_key', key: CANARY }));
  const hostFileBytes = readFileSync(hostPath);
  const directlySealed = Buffer.from(dualOptions.encryptString(CANARY));
  upgradeRing.state.locked = true;
  const locked = osKeyringSeal({ ...upgradeOptions, dualWrap: true });
  assert.equal(locked.decryptString(directlySealed), CANARY);
  assert.equal((await accountFileStore(hostPath, locked).read('provider'))?.type, 'api_key');
  assert.deepEqual(readFileSync(hostPath), hostFileBytes, 'mode-2 stores are not upgraded');
  assert.equal((await accountFileStore(upgradePath, locked).read('provider'))?.type, 'api_key');
  assert.deepEqual(readFileSync(upgradePath), upgradedBytes);
  // Even the inaccessible keyring wrap is bound into the payload authentication.
  for (const at of [0, 4, 5, 21, 25, 29, 55, 29 + upgradedBytes.readUInt32BE(21) + 50, upgradedBytes.length - 1]) {
    const tamperedDual = Buffer.from(upgradedBytes);
    tamperedDual[at] ^= at === 4 ? 128 : 1;
    assert.throws(() => locked.decryptString(tamperedDual), code('auth-failed'));
  }
  upgradeRing.state.locked = false;
  assert.equal(osKeyringSeal(upgradeOptions).decryptString(upgradedBytes), dualOptions.decryptString(upgradedBytes));
  assert.equal(dualOptions.decryptString(modeOne), osKeyringSeal(upgradeOptions).decryptString(modeOne));
  assert.throws(() => osKeyringSeal({ ...upgradeOptions, dualWrap: true, fallback: false }), code('invalid'));

  // The envelope past the 1 MiB chunk boundary: a surrogate pair straddling the boundary, with quotes,
  // backslashes and control characters, seals to exactly the JSON.stringify envelope and round-trips.
  const CHUNK = 1 << 20;
  const envelopeService = 'byokit-host-key';
  const envelopeKey = Buffer.alloc(32, 5);
  const envelopeSeal = hostKeySeal({ key: envelopeKey, service: envelopeService });
  const head = '"\\\n\u0001\u0007 quoted   tail';
  const text = head + 'y'.repeat(CHUNK - 1 - head.length) + '😀' + '"\\\u0002' + 'z'.repeat(CHUNK + 4096) + '\ud83d';
  assert.equal(text.charCodeAt(CHUNK - 1), 0xd83d, 'a surrogate pair starts at the last unit of the first chunk');
  const sealedText = Buffer.from(envelopeSeal.encryptString(text));
  const plain = openSecretBox(sealedText.subarray(21), envelopeKey);
  assert.ok(plain, 'the envelope authenticates under the key');
  assert.deepEqual(Buffer.from(plain.subarray(21)), Buffer.from(JSON.stringify({ service: envelopeService, text })));
  assert.equal(envelopeSeal.decryptString(sealedText), text);
  if (process.platform === 'win32') ctx.diagnostic('skipped: POSIX key and directory modes do not apply on win32');
  else await permissionModes();
});

async function permissionModes(): Promise<void> {
  // Insecure key or directory modes, and a key owned by another user, are refused on every use.
  const perm = { service: 'byokit-perm', stateDir: scratchDir('secrets-perm') };
  const permSeal = hostKeyFileSeal(perm);
  const permKey = onlyKey(perm.stateDir);
  for (const mode of [0o640, 0o604, 0o666]) {
    chmodSync(permKey, mode);
    assert.throws(() => hostKeyFileSeal(perm), code('invalid'));
    assert.throws(() => permSeal.encryptString(CANARY), code('invalid'));
  }
  chmodSync(permKey, 0o600);
  chmodSync(dirname(permKey), 0o750);
  assert.throws(() => hostKeyFileSeal(perm), code('invalid'));
  chmodSync(dirname(permKey), 0o700);
  await withPatchedFs('fstatSync', (real) => ((...args: Parameters<typeof fs.fstatSync>) => ({ ...real(...args), uid: process.getuid!() + 1, isFile: () => true })) as typeof fs.fstatSync,
    () => assert.throws(() => hostKeyFileSeal(perm), code('invalid')));
}

test('the browser and phone entries keep secrets at rest, and the published entry bundles with no Node code', async () => {
  // Browser: IndexedDB holds a non-extractable AES-256 key and authenticated ciphertext.
  const crypto = webcrypto as unknown as Crypto;
  const idb = new IDBFactory();
  const web = webStore({ indexedDB: idb, crypto, isSecureContext: true });
  assert.equal(await web.get('missing'), null);
  assert.equal(await web.delete('missing'), false);
  await web.set('provider/🔑', CANARY);
  assert.equal(await webStore({ indexedDB: idb, crypto, isSecureContext: true }).get('provider/🔑'), CANARY, 'a new instance opens the same store');
  assert.equal(await webStore({ indexedDB: idb, crypto, isSecureContext: true, database: 'other-app' }).get('provider/🔑'), null, 'apps are namespaced');
  await web.set('empty', '');
  assert.equal(await web.get('empty'), '');
  await web.set('unpaired', '\ud800');
  assert.equal(await web.get('unpaired'), '\ud800');
  assert.equal(await web.delete('empty'), true);
  assert.equal(await web.delete('empty'), false);
  const record = await idbRead(idb, 'item:provider/🔑');
  assert.equal(record.iv.byteLength, 12);
  // A fresh IV per write: rewriting the same entry never reuses the first IV (AES-GCM).
  await web.set('provider/🔑', CANARY);
  assert.notDeepEqual((await idbRead(idb, 'item:provider/🔑')).iv, record.iv, 'IV reuse across writes');
  assert.ok(!new TextDecoder().decode(record.ciphertext).includes(CANARY), 'plaintext in IndexedDB');
  const wrapKey = await idbRead(idb, 'device-wrap-key');
  assert.equal(wrapKey.extractable, false);
  assert.equal(wrapKey.algorithm.name, 'AES-GCM');
  assert.equal(wrapKey.algorithm.length, 256);
  await assert.rejects(crypto.subtle.exportKey('raw', wrapKey));
  await idbRead(idb, 'item:provider/🔑', (saved) => { new Uint8Array(saved.ciphertext)[0] ^= 1; return saved; });
  await assert.rejects(web.get('provider/🔑'), code('auth-failed'));
  await assert.rejects(webStore({ indexedDB: idb, crypto, isSecureContext: false }).set('x', CANARY), code('unavailable'));
  await assert.rejects(web.get(''), code('invalid'));
  await assert.rejects(web.delete('a\0b'), code('invalid'));
  await assert.rejects(web.set('x', '😀'.repeat(262145)), code('invalid'));

  // A fresh store never races into two device keys: eight concurrent first writes share one persisted key.
  const raced = new IDBFactory();
  const racers = Array.from({ length: 8 }, () => webStore({ indexedDB: raced, crypto, isSecureContext: true }));
  await Promise.all(racers.map((store, i) => store.set(`provider-${i}`, `${CANARY}${i}`)));
  for (let i = 0; i < racers.length; i++) assert.equal(await webStore({ indexedDB: raced, crypto, isSecureContext: true }).get(`provider-${i}`), `${CANARY}${i}`);
  assert.deepEqual(await Promise.all(racers.map((store) => store.delete('provider-0'))), [true, ...Array(7).fill(false)]);

  // Name binding: a ciphertext copied to another item name fails authentication, and a failed write keeps the stored record.
  const bound = new IDBFactory();
  const boundWeb = webStore({ indexedDB: bound, crypto, isSecureContext: true });
  await boundWeb.set('original', CANARY);
  await boundWeb.set('other', 'other-value');
  const copied = await idbRead(bound, 'item:original');
  await idbRead(bound, 'item:other', () => copied);
  await assert.rejects(boundWeb.get('other'), code('auth-failed'));
  assert.equal(await boundWeb.get('original'), CANARY);
  const broken = new IDBFactory();
  const brokenWeb = webStore({ indexedDB: broken, crypto, isSecureContext: true });
  await brokenWeb.set('original', CANARY);
  const storedRecord = await idbRead(broken, 'item:original');
  await idbRead(broken, 'device-wrap-key', () => ({ extractable: true }));
  await assert.rejects(brokenWeb.set('original', 'replacement'), code('auth-failed'));
  assert.deepEqual(await idbRead(broken, 'item:original'), storedRecord);
  await idbRead(broken, 'item:original', () => ({ v: 2 }));
  await assert.rejects(brokenWeb.get('original'), code('auth-failed'));

  // Unavailable APIs, aborted transactions and crypto failures map to typed codes without exposing the secret.
  const failing = webStore({ indexedDB: idb, crypto: { subtle: { generateKey: async () => { throw new Error(CANARY); } } } as unknown as Crypto, isSecureContext: true });
  await assert.rejects(failing.set('x', CANARY), code('failed'));
  const base = new IDBFactory();
  const aborting = {
    open(name: string, version?: number) {
      const request = base.open(name, version);
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
  await assert.rejects(webStore({ indexedDB: aborting, crypto, isSecureContext: true }).set('x', CANARY), code('failed'));
  assert.throws(() => webStore({ database: '' }), code('invalid'));

  // Phone: SecureStore receives only safe, collision-free keys and the host's options.
  const entries = new Map<string, string>();
  const calls: { key: string; options: unknown }[] = [];
  const fake: SecureStoreLike = {
    async getItemAsync(key, options) { calls.push({ key, options }); return entries.get(key) ?? null; },
    async setItemAsync(key, value, options) { calls.push({ key, options }); entries.set(key, value); },
    async deleteItemAsync(key, options) { calls.push({ key, options }); entries.delete(key); },
  };
  const secureOptions = { keychainService: 'app.keys', requireAuthentication: false };
  const phone = nativeStore({ secureStore: fake, options: secureOptions });
  assert.equal(await phone.get('missing'), null);
  assert.equal(await phone.delete('missing'), false);
  await phone.set('provider/🔑', CANARY);
  await phone.set('provider_🔑', '');
  assert.equal(await phone.get('provider/🔑'), CANARY);
  assert.equal(await phone.get('provider_🔑'), '');
  assert.equal(await nativeStore({ secureStore: fake, prefix: 'other', options: secureOptions }).get('provider/🔑'), null, 'another app prefix cannot read the secret');
  assert.equal(await phone.delete('provider/🔑'), true);
  assert.equal(await phone.delete('provider/🔑'), false);
  for (const call of calls) {
    assert.match(call.key, /^[A-Za-z0-9._-]+$/);
    assert.deepEqual(call.options, secureOptions);
  }
  assert.throws(() => nativeStore({ prefix: 'bad/prefix' }), code('invalid'));
  await assert.rejects(phone.set('x', 'a'.repeat(1024 * 1024 + 1)), code('invalid'));
  await assert.rejects(phone.get('x\0y'), code('invalid'));
  // The UTF-8 size cap matches Node's byte count, including unmatched surrogates.
  for (const unit of ['a', 'é', '字', '😀', '\ud800', '\udc00']) {
    const limit = Math.floor(1024 * 1024 / Buffer.byteLength(unit));
    await assert.doesNotReject(phone.set('size', unit.repeat(limit)));
    await assert.rejects(phone.set('size', unit.repeat(limit + 1)), code('invalid'));
  }
  // A failing SecureStore write reports a typed failure and never echoes the secret.
  fake.setItemAsync = async () => { throw new Error(CANARY); };
  await assert.rejects(phone.set('x', CANARY), code('failed'));

  // The optional SecureStore peer loads on demand: while it is missing a call maps to unavailable, and once it is
  // installed the next call retries the import and succeeds. The bundle keeps expo-secure-store external so its
  // import is resolved at run time, the way a host app resolves it.
  const peerDir = scratchDir('secrets-peer');
  const peerBundle = await build({
    stdin: { contents: "export { nativeStore } from '@byokit/secrets/native';", resolveDir: import.meta.dirname },
    bundle: true, platform: 'browser', format: 'esm', write: false, external: ['expo-secure-store'], logLevel: 'silent',
  });
  const peerPath = join(peerDir, 'native.mjs');
  writeFileSync(peerPath, peerBundle.outputFiles[0].text);
  const late = (await import(pathToFileURL(peerPath).href) as { nativeStore: typeof nativeStore }).nativeStore();
  await assert.rejects(late.get('k'), (e: any) => e?.code === 'unavailable' && !String(e.message).includes(CANARY));
  const peerModule = join(peerDir, 'node_modules', 'expo-secure-store');
  mkdirSync(peerModule, { recursive: true });
  writeFileSync(join(peerModule, 'package.json'), JSON.stringify({ name: 'expo-secure-store', type: 'module', main: 'index.js' }));
  writeFileSync(join(peerModule, 'index.js'), 'export async function getItemAsync() { return "peer-secret"; } export async function setItemAsync() {} export async function deleteItemAsync() {}');
  assert.equal(await late.get('k'), 'peer-secret', 'the failed peer load was cached instead of retried');

  // Both published cross-platform entries bundle for a phone and a browser with no Node code, and run in a fresh VM.
  for (const condition of ['browser', 'react-native']) {
    const bundle = await build({
      stdin: { contents: "import * as kit from '@byokit/secrets'; globalThis.kit = kit;", resolveDir: import.meta.dirname },
      bundle: true, platform: 'browser', format: 'iife', conditions: [condition], write: false, metafile: true, logLevel: 'silent',
      plugins: [{ name: 'fake-secure-store', setup(b) {
        b.onResolve({ filter: /^expo-secure-store$/ }, () => ({ path: 'expo-secure-store', namespace: 'fake' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export async function getItemAsync() { return "fake-device-secret"; } export async function setItemAsync() {} export async function deleteItemAsync() {}' }));
      } }],
    });
    const inputs = Object.keys(bundle.metafile!.inputs);
    assert.deepEqual(inputs.filter((file) => /^node:/.test(file)), [], `Node module in the ${condition} bundle`);
    assert.ok(!inputs.some((file) => /secrets\/dist\/(index|file|keyring|atomic|os-keyring|sealing|host-key-file)\.js$/.test(file)), `Node-only code in the ${condition} bundle`);
    const context: Record<string, unknown> = condition === 'browser'
      ? { indexedDB: new IDBFactory(), crypto, isSecureContext: true, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer }
      : {};
    runInNewContext(bundle.outputFiles[0].text, context);
    assert.equal(runInNewContext('typeof Buffer + ":" + typeof process + ":" + typeof require', context), 'undefined:undefined:undefined');
    const kit = context.kit as { overrideStore: typeof overrideStore; nativeStore: typeof nativeStore; webStore: typeof webStore };
    assert.equal(await kit.overrideStore({ token: CANARY }).get('token'), CANARY);
    if (condition === 'react-native') {
      assert.equal(runInNewContext('typeof TextEncoder', context), 'undefined');
      const bundled = kit.nativeStore();
      assert.equal(await bundled.get('token'), 'fake-device-secret');
      await bundled.set('unicode/🔑', CANARY);
    } else {
      const bundled = kit.webStore({ indexedDB: new IDBFactory(), crypto, isSecureContext: true });
      await bundled.set('token', CANARY);
      assert.equal(await bundled.get('token'), CANARY);
      assert.equal(await bundled.delete('token'), true);
    }
  }
});

test('a keystore run under a locked-down permission set never touches anyone else\'s sign-ins', async () => {
  const decoyHome = scratchDir('secrets-decoy');
  const decoys: Record<string, string> = {
    '.pi/agent/auth.json': JSON.stringify({ openai: 'decoy-pi-canary-aaa' }),
    '.codex/auth.json': JSON.stringify({ token: 'decoy-codex-canary-bbb' }),
    '.claude.json': JSON.stringify({ oauth: 'decoy-claude-canary-ccc' }),
  };
  for (const [rel, text] of Object.entries(decoys)) {
    const full = join(decoyHome, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  const before = snapshot(decoyHome);
  const repo = resolve(import.meta.dirname, '..', '..', '..');
  const fakeCliUrl = new URL('./fake-cli.ts', import.meta.url).href;

  // Control: under these flags, reading the decoy someone's sign-in is refused outright.
  const control = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${repo}`, '--input-type=module', '-e',
    `import { readFileSync } from 'node:fs'; readFileSync(${JSON.stringify(join(decoyHome, '.pi', 'agent', 'auth.json'))});`],
    { encoding: 'utf8', timeout: 20_000 });
  assert.match(control.stderr, /ERR_ACCESS_DENIED/);

  for (const tool of ['secret-tool', 'security'] as const) {
    const work = scratchDir(`secrets-isolation-${tool}`);
    const runFile = join(work, 'run.mjs');
    writeFileSync(runFile, `
      import { writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      import { fileStore, keyringStore } from ${JSON.stringify(distIndex)};
      import { writeFakeCli } from ${JSON.stringify(fakeCliUrl)};
      const [workDir, tool] = process.argv.slice(2);
      const CANARY = 'sk-canary-isolation-1c5d';
      const result = { tool };
      try {
        const bin = writeFakeCli(workDir, tool);
        const canaryFile = join(workDir, 'canary.txt');
        writeFileSync(canaryFile, CANARY);
        const ring = keyringStore({ bin, tool, env: { FAKE_TOOL: tool, FAKE_LOG: join(workDir, 'invocations.jsonl'), FAKE_STATE: join(workDir, 'state.json'), FAKE_CANARY_FILE: canaryFile } });
        await ring.set('openai', CANARY);
        result.keyringGet = await ring.get('openai');
        result.keyringDeleted = await ring.delete('openai');
        const file = fileStore({ path: join(workDir, 'keys.json'), passphrase: 'isolation-pass' });
        await file.set('openai', CANARY);
        result.fileGet = await file.get('openai');
        result.ok = result.keyringGet === CANARY && result.keyringDeleted === true && result.fileGet === CANARY;
      } catch (e) {
        result.ok = false;
        result.error = e?.message ?? String(e);
      }
      console.log(JSON.stringify(result));
    `);
    const allow = ['--permission', `--allow-fs-read=${repo}`, `--allow-fs-read=${work}`, `--allow-fs-write=${work}`, '--allow-child-process'];
    const r = spawnSync(process.execPath, [...allow, runFile, work, tool], { env: { PATH: '/usr/bin:/bin', HOME: decoyHome }, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `tool ${tool}: exit ${r.status}\n${r.stderr}`);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as { ok: boolean };
    assert.equal(out.ok, true, `tool ${tool}: ${JSON.stringify(out)}`);
    // The fakes logged every call: the canary reached them on stdin only.
    const logged = invocations(join(work, 'invocations.jsonl'));
    assert.ok(logged.length >= 3, `tool ${tool}: expected calls, saw ${logged.length}`);
    for (const call of logged) {
      assert.equal(call.selfCheck, undefined, `tool ${tool}: the fake saw the canary in argv or env`);
      for (const arg of call.argv) assert.ok(!arg.includes('sk-canary-isolation-1c5d'), `canary in argv: ${arg}`);
      for (const value of Object.values(call.env)) assert.ok(!String(value).includes('sk-canary-isolation-1c5d'), 'canary in env');
    }
  }

  const after = snapshot(decoyHome);
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'the decoy gained or lost files');
  for (const [path, bytes] of before) assert.deepEqual(after.get(path), bytes, `decoy file changed: ${path}`);
});

// A private Secret Service on a throwaway D-Bus session: a locked or hung collection is probed within a bound and is
// never unlocked, prompted or created, and a sealed file written while unlocked opens again once the keyring is back.
async function privateSecretService(): Promise<void> {
  const root = scratchDir('private-bus');
  const childProgram = `
    import assert from 'node:assert/strict';
    import { osKeyringSeal } from ${JSON.stringify(distIndex)};
    import { readFileSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    const [mode, stateDir, operation] = process.argv.slice(1);
    const start = Date.now();
    const seal = osKeyringSeal({ service: 'fake-service', stateDir, timeoutMs: 500 });
    const rawFile = join(stateDir, 'probe.sealed');
    if (operation === 'open') {
      const original = readFileSync(rawFile);
      if (mode === 'unlocked') assert.equal(seal.decryptString(original), 'key-canary');
      else assert.throws(() => seal.decryptString(original), (e) => e.code === 'keyring-locked');
      assert.deepEqual(readFileSync(rawFile), original);
    } else {
      assert.equal(seal.mode, mode === 'unlocked' ? 'keyring' : 'host-key-file');
      assert.ok(Date.now() - start < 2000, 'probe is bounded');
      const ciphertext = Buffer.from(seal.encryptString('key-canary'));
      assert.equal(seal.decryptString(ciphertext), 'key-canary');
      assert.equal(ciphertext.includes('key-canary'), false);
      writeFileSync(rawFile, ciphertext, { mode: 0o600 });
    }
    process.exit(0);
  `;
  const runner = join(root, 'runner.mjs');
  writeFileSync(runner, `
    import { createRequire } from 'node:module';
    import { spawn } from 'node:child_process';
    import { mkdirSync } from 'node:fs';
    import assert from 'node:assert/strict';
    const require = createRequire(${JSON.stringify(import.meta.url)});
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
    const run = (phase, stateDir, operation) => new Promise((resolve, reject) => {
      mode = phase;
      const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childProgram)}, phase, stateDir, operation], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(output)));
    });
    for (const phase of ['locked', 'hung', 'unlocked']) {
      const stateDir = ${JSON.stringify(root)} + '/' + phase;
      mkdirSync(stateDir, { mode: 0o700 });
      await run(phase, stateDir, 'seal');
    }
    const recoveryDir = ${JSON.stringify(root)} + '/recovery';
    mkdirSync(recoveryDir, { mode: 0o700 });
    await run('unlocked', recoveryDir, 'seal');
    for (const phase of ['locked', 'hung', 'unlocked']) await run(phase, recoveryDir, 'open');
    assert.equal(prompts, 0);
    bus.connection.stream.end();
    process.exit(0);
  `);
  // Inherited owner bus/control/XDG data are absent; dbus-run-session creates the only bus.
  const { status, output } = await runChild('dbus-run-session', ['--', process.execPath, runner], { PATH: '/usr/bin:/bin', HOME: root, TMPDIR: root, NODE_OPTIONS: process.env.NODE_OPTIONS });
  if (status !== 0) throw new Error(output);
}

async function idbRead(idb: IDBFactory, key: string, change?: (value: any) => any): Promise<any> {
  const db = await new Promise<IDBDatabase>((resolveDb, reject) => {
    const request = idb.open('byokit-secrets', 1);
    request.onsuccess = () => resolveDb(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolveTx, reject) => {
      const tx = db.transaction('wrapped', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('wrapped');
      const request = store.get(key);
      request.onsuccess = () => { if (change) store.put(change(request.result), key); };
      tx.oncomplete = () => resolveTx(request.result);
      tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}
