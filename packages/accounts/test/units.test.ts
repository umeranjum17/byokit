import { sealing } from './sealing.ts';
// Stores, isolate(), classify and words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { join } from 'node:path';
import { PROVIDERS, WORDS, billingWords, classify, fileStore, isolate, say, signInError } from '../src/index.ts';

test('the file store: Pi\'s auth.json shape, 0600 in a 0700 folder, serialized writes', async () => {
  const dir = join(scratchDir('store'), 'people', '1');
  const path = join(dir, 'auth.json');
  const s = fileStore(path, sealing);
  assert.equal(await s.read('openai-codex'), undefined);
  const cred = { type: 'oauth' as const, access: 'a', refresh: 'r', expires: 1 };
  await Promise.all([s.modify('openai-codex', async () => cred), s.modify('xai', async () => ({ type: 'api_key', key: 'k' }))]);
  assert.deepEqual(JSON.parse(sealing.decryptString(readFileSync(path))), { 'openai-codex': cred, xai: { type: 'api_key', key: 'k' } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(await s.list(), [{ providerId: 'openai-codex', type: 'oauth' }, { providerId: 'xai', type: 'api_key' }]);
  assert.deepEqual(await s.modify('xai', async () => undefined), { type: 'api_key', key: 'k' }, 'undefined leaves it as it was');
  await s.delete('xai');
  assert.deepEqual(await fileStore(path, sealing).list(), [{ providerId: 'openai-codex', type: 'oauth' }]);
});

test("the file store sealed with Electron's safeStorage: no sign-in readable in the file, the same sign-ins back", async () => {
  const path = join(scratchDir('sealed'), 'auth.json');
  // Electron's safeStorage stands in: sealed with a key the OS keychain would hold.
  const safeStorage = {
    encryptString: (text: string) => Buffer.from([...Buffer.from(text)].map((b) => b ^ 0x5a)),
    decryptString: (data: Buffer) => Buffer.from([...data].map((b) => b ^ 0x5a)).toString(),
  };
  const cred = { type: 'oauth' as const, access: 'secret-access', refresh: 'secret-refresh', expires: 1 };
  await fileStore(path, safeStorage).modify('openai-codex', async () => cred);
  assert.doesNotMatch(readFileSync(path, 'latin1'), /secret|openai-codex/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(await fileStore(path, safeStorage).read('openai-codex'), cred);
});

test('file storage refuses plaintext fallback, insecure backends and unsafe filesystem entries', async () => {
  const dir = scratchDir('store-safety');
  const path = join(dir, 'auth.json');
  const victim = join(dir, 'victim');
  const cred = { type: 'oauth' as const, access: 'canary-access', refresh: 'canary-refresh', expires: 1 };
  assert.throws(() => fileStore(path, undefined as any), /sealing adapter/);
  assert.throws(() => fileStore(path, { ...sealing, isEncryptionAvailable: () => false }), /unavailable/);
  assert.throws(() => fileStore(path, { ...sealing, getSelectedStorageBackend: () => 'basic_text' }), /unavailable/);
  let available = true;
  const guarded = fileStore(path, { ...sealing, isEncryptionAvailable: () => available });
  available = false;
  await assert.rejects(guarded.modify('openai-codex', async () => cred), /unavailable/);
  assert.deepEqual(readdirSync(dir), []);
  writeFileSync(victim, 'untouched');
  symlinkSync(victim, path);
  await assert.rejects(fileStore(path, sealing).read('openai-codex'));
  await assert.rejects(fileStore(path, sealing).modify('openai-codex', async () => cred));
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  unlinkSync(path);
  // The old predictable temporary path is never opened or overwritten.
  symlinkSync(victim, `${path}.tmp`);
  await fileStore(path, sealing).modify('openai-codex', async () => cred);
  const before = readFileSync(path);
  assert.equal(readFileSync(victim, 'utf8'), 'untouched');
  assert.doesNotMatch(before.toString('latin1'), /canary-access|canary-refresh/);
  assert.deepEqual(readdirSync(dir).sort(), ['auth.json', 'auth.json.tmp', 'victim']);
  await assert.rejects(fileStore(path, { ...sealing, encryptString: () => { throw new Error('locked'); } }).delete('openai-codex'), /locked/);
  assert.deepEqual(readFileSync(path), before);
  chmodSync(path, 0o644);
  await assert.rejects(fileStore(path, sealing).read('openai-codex'), /private regular file/);
  chmodSync(path, 0o600);
  chmodSync(dir, 0o755);
  await assert.rejects(fileStore(path, sealing).read('openai-codex'), /private 0700 folder/);
  chmodSync(dir, 0o700);
  const linkedDir = join(scratchDir('linked-folder'), 'link');
  symlinkSync(dir, linkedDir);
  await assert.rejects(fileStore(join(linkedDir, 'auth.json'), sealing).read('openai-codex'), /private 0700 folder/);
});

test('isolate() scrubs inherited Pi settings and provider keys, and pins the engine folder', () => {
  Object.assign(process.env, { PI_CODING_AGENT_DIR: '/home/x/.pi/agent', PI_PACKAGE_DIR: '/x', OPENAI_API_KEY: 'k', GH_TOKEN: 't', AI_AGENT: 'pi', KEEP_ME: '1' });
  const dir = join(scratchDir('iso'), 'engine');
  assert.equal(isolate(dir), dir);
  assert.equal(process.env.PI_CODING_AGENT_DIR, dir);
  for (const k of ['PI_PACKAGE_DIR', 'OPENAI_API_KEY', 'GH_TOKEN', 'AI_AGENT']) assert.equal(process.env[k], undefined, k);
  assert.equal(process.env.KEEP_ME, '1');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('classify: the kinds an app acts on, and when the provider said to come back', () => {
  assert.equal(classify('You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.')?.kind, 'rate_limit');
  assert.ok(Math.abs(classify('429 Too Many Requests, try again in 2h')!.until - (Date.now() + 7_200_000)) < 1000);
  assert.deepEqual(classify('503 overloaded'), { kind: 'overloaded', until: 0 });
  assert.equal(classify('401 Unauthorized')?.kind, 'signed_out');
  assert.equal(classify('getaddrinfo ENOTFOUND chatgpt.com')?.kind, 'network');
  assert.equal(classify('context window exceeded by your prompt'), null);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
  assert.equal(say('terms.grey', { name: 'ChatGPT', company: 'OpenAI' }), 'Uses your ChatGPT plan. OpenAI may change this at any time.');
  assert.equal(billingWords(PROVIDERS.chatgpt), 'Uses your ChatGPT plan.');
  assert.equal(billingWords(PROVIDERS.openrouter), 'Charged per use to your OpenRouter account, not a plan.');
  assert.equal(signInError('ChatGPT', 'device code login is not enabled'), 'ChatGPT needs device sign-in turned on first: in ChatGPT, Settings, Security, turn on device code sign-in, then try again.');
});
