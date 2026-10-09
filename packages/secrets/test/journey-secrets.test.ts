// Consumer journeys for the published @byokit/secrets surface, driven the way a host app uses it:
// `keyringStore`, `fileStore`, `overrideStore` and `osKeyring` are the stores a host passes around,
// `osKeyringSeal`/`hostKeySeal`/`hostKeyFileSeal` are the sealing adapters, and `@byokit/secrets/web` /
// `@byokit/secrets/native` are the browser and phone entries. Every import is a published entry — none from
// src or internals. The security and correctness contracts the old unit/mock-heavy cases held survive as
// assertions inside a journey: keyring lookup and label scoping, keystore read/write/delete, sealing and
// unsealing with wrong key / tampered / truncated input refused, process-env isolation, and the rule that a
// secret value never reaches argv, env, storage, logs or error text. Keyring tests stay isolated from the
// owner's real keyring by driving only the fake CLIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { build } from 'esbuild';
import { IDBFactory } from 'fake-indexeddb';
import {
  KeystoreError, keyringEnv, keyringStore, fileStore, overrideStore, writeFileAtomic,
  osKeyringSeal, hostKeySeal, hostKeyFileSeal, type KeyringBackend,
} from '@byokit/secrets';
import { webStore } from '@byokit/secrets/web';
import { nativeStore, type SecureStoreLike } from '@byokit/secrets/native';
import { scratchDir } from '../../test-support.ts';
import { writeFakeCli, type FakeTool } from './fake-cli.ts';

const CANARY = 'sk-canary-secrets-6b1f';
// A canary never appears in an error's text, and the code is the typed one the caller branches on.
const code = (want: string) => (e: unknown) => e instanceof KeystoreError && e.code === want && !String((e as Error).message).includes(CANARY);
const key32 = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) & 0xff);

function bench(tool: FakeTool, extra: Record<string, string> = {}) {
  const dir = scratchDir(`secrets-${tool}`);
  const bin = writeFakeCli(dir, tool);
  const log = join(dir, 'invocations.jsonl');
  const state = join(dir, 'state.json');
  const canaryFile = join(dir, 'canary.txt');
  writeFileSync(canaryFile, CANARY);
  const env = { FAKE_TOOL: tool, FAKE_LOG: log, FAKE_STATE: state, FAKE_CANARY_FILE: canaryFile, ...extra };
  const make = (service = 'byokit-secrets') => keyringStore({ bin, tool, service, env });
  const calls = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string>; stdinBytes: number; selfCheck?: string });
  return { dir, bin, tool, env, make, calls };
}

function snapshot(home: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else files.set(full, readFileSync(full));
    }
  };
  walk(home);
  return files;
}

function onlyKey(root: string): string {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.key')) found.push(full);
    }
  };
  walk(root);
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

test('an app keeps one secret per name in the OS keyring, with the value only ever on stdin', async () => {
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
});

test('a poisoned environment changes nothing: no secret is read from it and no spawn inherits it', async () => {
  const dir = scratchDir('secrets-env');
  const saved = { ...process.env };
  const MARKER = 'env-poison-marker-zz9';
  try {
    process.env.PATH = `/nonexistent-${MARKER}`;
    process.env.HOME = join(dir, 'decoy-home');
    process.env.VICTIM_NAME = CANARY;
    process.env.OPENAI_API_KEY = `${MARKER}-should-never-be-read`;
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

test('sealing keeps credentials encrypted and refuses a wrong key, tampering and truncation', async () => {
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
  }
  assert.throws(() => hostKeySeal({ key: () => { throw new Error('gone'); } }).encryptString(CANARY), code('unavailable'));

  // Automatic selection falls back to a private host key file when no keyring is available.
  const unavailable: KeyringBackend = { get() { throw new Error('none'); }, set() { throw new Error('none'); }, delete() { throw new Error('none'); } };
  const fbDir = scratchDir('secrets-fallback');
  const fb = osKeyringSeal({ service: 'byokit-fallback', stateDir: fbDir, keyring: unavailable });
  assert.equal(fb.mode, 'host-key-file');
  const fbSealed = Buffer.from(fb.encryptString(CANARY));
  assert.equal(osKeyringSeal({ service: 'byokit-fallback', stateDir: fbDir, keyring: unavailable }).decryptString(fbSealed), CANARY);
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
  assert.equal(readdirSync(dirname(keyPath)).filter((f) => f.endsWith('.key')).length, 1);
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

  // The OS keyring seal encrypts, rotates and refuses a wrong service, tampering and truncation.
  const ring = fakeRing();
  const ringDir = scratchDir('secrets-ring');
  const ro = { service: 'byokit-test', stateDir: ringDir, keyring: ring.backend };
  const seal = osKeyringSeal(ro);
  assert.equal(seal.mode, 'keyring');
  const sealed = Buffer.from(seal.encryptString(CANARY));
  assert.equal(seal.decryptString(sealed), CANARY);
  assert.ok(!sealed.includes(Buffer.from(CANARY)));
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
  assert.notDeepEqual(Buffer.from(seal.encryptString(CANARY)), sealed);

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
});

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
  await assert.rejects(web.set('x', '😀'.repeat(262145)), code('invalid'));

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
  assert.equal(await phone.delete('provider/🔑'), true);
  for (const call of calls) {
    assert.match(call.key, /^[A-Za-z0-9._-]+$/);
    assert.deepEqual(call.options, secureOptions);
  }
  assert.throws(() => nativeStore({ prefix: 'bad/prefix' }), code('invalid'));
  await assert.rejects(phone.set('x', 'a'.repeat(1024 * 1024 + 1)), code('invalid'));

  // Both published cross-platform entries bundle for a phone and a browser with no Node code.
  for (const condition of ['browser', 'react-native']) {
    const bundle = await build({
      stdin: { contents: "import * as kit from '@byokit/secrets'; globalThis.kit = kit;", resolveDir: import.meta.dirname },
      bundle: true, platform: 'browser', format: 'iife', conditions: [condition], write: false, metafile: true, logLevel: 'silent',
      plugins: [{ name: 'fake-secure-store', setup(b) {
        b.onResolve({ filter: /^expo-secure-store$/ }, () => ({ path: 'expo-secure-store', namespace: 'fake' }));
        b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export async function getItemAsync() { return null; } export async function setItemAsync() {} export async function deleteItemAsync() {}' }));
      } }],
    });
    const inputs = Object.keys(bundle.metafile!.inputs);
    assert.deepEqual(inputs.filter((file) => /^node:/.test(file)), [], `Node module in the ${condition} bundle`);
    assert.ok(!inputs.some((file) => /secrets\/dist\/(index|file|keyring|atomic|os-keyring|sealing|host-key-file)\.js$/.test(file)), `Node-only code in the ${condition} bundle`);
    assert.ok(bundle.outputFiles[0].text.length > 0);
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
  const distUrl = new URL('../dist/index.js', import.meta.url).href;
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
      import { fileStore, keyringStore } from ${JSON.stringify(distUrl)};
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
    const logged = readFileSync(join(work, 'invocations.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string>; selfCheck?: string });
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
