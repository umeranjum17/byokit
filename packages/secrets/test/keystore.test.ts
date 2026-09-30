// The override and passphrase-file backends, plus the exported atomic writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { fileStore, overrideStore, writeFileAtomic, KeystoreError } from '../src/index.ts';

const CANARY = 'sk-canary-file-4d1e';
const code = (want: string) => (e: any) => e?.code === want;

test('override: get/set/delete on a copy; construction validates', async () => {
  const store = overrideStore({ openai: CANARY });
  assert.equal(await store.get('openai'), CANARY);
  assert.equal(await store.get('missing'), null);
  await store.set('new', 'x');
  assert.equal(await store.get('new'), 'x');
  assert.equal(await store.delete('new'), true);
  assert.equal(await store.delete('new'), false);
  assert.throws(() => overrideStore({ '': 'x' }), code('invalid'));
  assert.throws(() => overrideStore(null as any), code('invalid'));
});

test('file: set/get/delete round-trips; missing is null/false', async () => {
  const dir = scratchDir('file-roundtrip');
  const store = fileStore({ path: join(dir, 'sub', 'keys.json'), passphrase: 'correct horse' });
  assert.equal(await store.get('openai'), null);
  assert.equal(await store.delete('openai'), false);
  await store.set('openai', CANARY);
  assert.equal(await store.get('openai'), CANARY);
  await store.set('second', 'value-2');
  assert.equal(await store.get('second'), 'value-2');
  assert.equal(await store.delete('openai'), true);
  assert.equal(await store.get('openai'), null);
  assert.equal(await store.get('second'), 'value-2');
});

test('file: a wrong passphrase fails closed', async () => {
  const dir = scratchDir('file-wrong-pass');
  const path = join(dir, 'keys.json');
  await fileStore({ path, passphrase: 'right' }).set('openai', CANARY);
  const wrong = fileStore({ path, passphrase: 'wrong' });
  const before = readFileSync(path);
  await assert.rejects(wrong.get('openai'), (e: any) => e instanceof KeystoreError && e.code === 'auth-failed');
  await assert.rejects(wrong.set('openai', 'attacker'), (e: any) => e instanceof KeystoreError && e.code === 'auth-failed');
  await assert.rejects(wrong.delete('openai'), (e: any) => e instanceof KeystoreError && e.code === 'auth-failed');
  assert.deepEqual(readFileSync(path), before, 'a failed open writes nothing');
  assert.equal(await fileStore({ path, passphrase: 'right' }).get('openai'), CANARY);
});

test('file: the sealed file holds no plaintext canary, and tampering fails closed', async () => {
  const dir = scratchDir('file-sealed');
  const path = join(dir, 'keys.json');
  await fileStore({ path, passphrase: 'right' }).set('openai', CANARY);
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes(CANARY), 'plaintext canary in the sealed file');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.v, 1);
  assert.equal(parsed.kdf, 'scrypt-16384-8-1');
  const tampered = { ...parsed, box: Buffer.from('tampered-box-bytes-padded!!').toString('base64') };
  const tamperedPath = join(dir, 'tampered.json');
  writeFileAtomic(tamperedPath, JSON.stringify(tampered));
  await assert.rejects(
    fileStore({ path: tamperedPath, passphrase: 'right' }).get('openai'),
    (e: any) => e instanceof KeystoreError && (e.code === 'auth-failed' || e.code === 'failed'),
  );
});

test('file: corrupt files reject failed, not auth-failed', async () => {
  const dir = scratchDir('file-corrupt');
  const garbage = join(dir, 'garbage.json');
  writeFileAtomic(garbage, 'not json at all');
  await assert.rejects(fileStore({ path: garbage, passphrase: 'x' }).get('a'), code('failed'));
  const wrongShape = join(dir, 'shape.json');
  writeFileAtomic(wrongShape, JSON.stringify({ v: 2 }));
  await assert.rejects(fileStore({ path: wrongShape, passphrase: 'x' }).get('a'), code('failed'));
});

test('file: Uint8Array passphrases work; empty passphrases and relative paths are invalid', async () => {
  const dir = scratchDir('file-pass-variants');
  const store = fileStore({ path: join(dir, 'k.json'), passphrase: new TextEncoder().encode('bytes-pass') });
  await store.set('a', 'b');
  assert.equal(await store.get('a'), 'b');
  assert.throws(() => fileStore({ path: join(dir, 'k.json'), passphrase: '' }), code('invalid'));
  assert.throws(() => fileStore({ path: join(dir, 'k.json'), passphrase: new Uint8Array(0) }), code('invalid'));
  assert.throws(() => fileStore({ path: 'relative/k.json', passphrase: 'x' }), code('invalid'));
});

test('writeFileAtomic: 0700 folders, 0600 file, atomic replace', () => {
  const dir = scratchDir('atomic');
  const path = join(dir, 'deep', 'nested', 'keys.json');
  writeFileAtomic(path, '{"a":1}');
  assert.equal(readFileSync(path, 'utf8'), '{"a":1}');
  assert.equal((statSync(join(dir, 'deep')).mode & 0o777).toString(8), '700');
  assert.equal((statSync(path).mode & 0o777).toString(8), '600');
  writeFileAtomic(path, '{"a":2}');
  assert.equal(readFileSync(path, 'utf8'), '{"a":2}');
  writeFileAtomic(path, new TextEncoder().encode('bytes'));
  assert.equal(readFileSync(path, 'utf8'), 'bytes');
  assert.throws(() => writeFileAtomic('relative.json', 'x'), code('invalid'));
});
