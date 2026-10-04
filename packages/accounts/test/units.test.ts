import { sealing } from './sealing.ts';
// Stores, isolate(), classify and words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { join } from 'node:path';
import { PROVIDERS, WORDS, billingWords, classify, classifyFailure, REST_MS, fileStore, isolate, launchEnv, say, signInError } from '../src/index.ts';

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

test('launch isolation copies and scrubs credentials; isolate never changes process.env', () => {
  const before = { ...process.env };
  const names = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_SESSION', 'CODEX_HOME',
    'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'XAI_TOKEN', 'OPENROUTER_API_KEY',
    'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'MINIMAX_TOKEN', 'KIMI_TOKEN', 'MOONSHOT_TOKEN',
    'QWEN_TOKEN', 'DASHSCOPE_TOKEN', 'META_TOKEN', 'AWS_SESSION_TOKEN', 'AZURE_TOKEN', 'HF_TOKEN',
    ...Object.values(PROVIDERS).flatMap((p) => [p.key, p.pi, p.company].map((name) => name.toUpperCase().replace(/[^A-Z0-9]+/g, '_') + '_TOKEN'))];
  const base = { PATH: '/usr/bin', HOME: '/app', LANG: 'C.UTF-8', KEEP: 'yes',
    ...Object.fromEntries(names.map((key) => [key, 'fake-credential'])) };
  const result = launchEnv({ base, account: { set: { CODEX_HOME: '/app/umer' }, unset: ['KEEP'] },
    set: { NAME: 'Umer', DROP: 'yes' }, unset: ['DROP', 'NOT_PRESENT'] });
  assert.ok(names.filter((key) => key !== 'CODEX_HOME').every((key) => !(key in result.env)));
  assert.ok(names.every((key) => base[key as keyof typeof base] === 'fake-credential'));
  assert.equal(result.env.CODEX_HOME, '/app/umer');
  assert.equal(result.env.PATH, base.PATH); assert.equal(result.env.HOME, base.HOME); assert.equal(result.env.LANG, base.LANG);
  assert.ok(['KEEP', 'DROP', 'NOT_PRESENT'].every((key) => result.unset.includes(key) && !(key in result.env)));
  assert.ok(!result.unset.includes('CODEX_HOME'));
  const dir = join(scratchDir('iso'), 'engine');
  assert.equal(isolate(dir), dir);
  launchEnv();
  assert.ok(JSON.stringify(process.env) === JSON.stringify(before), 'parent environment unchanged');
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.throws(() => launchEnv({ set: { 'bad=name': 'fake-credential' } }), /^Error: Invalid launch environment\.$/);
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


test('classifyFailure exports typed failures and fallback rest times without changing classify', () => {
  const now = 1_000;
  assert.deepEqual(classifyFailure('usage limit; try again in ~30 MIN', now), { kind: 'rate_limit', until: now + 1_800_000 });
  assert.deepEqual(classifyFailure('429 try again in 2 HOURS', now), { kind: 'rate_limit', until: now + 7_200_000 });
  assert.deepEqual(classifyFailure("your plan doesn't include helpers"), { kind: 'not_included', until: 0 });
  assert.deepEqual(classifyFailure('503 overloaded'), { kind: 'overloaded', until: 0 });
  assert.deepEqual(classifyFailure('invalid access token'), { kind: 'signed_out', until: 0 });
  assert.deepEqual(classifyFailure('socket hang up'), { kind: 'network', until: 0 });
  assert.equal(classifyFailure('context window exceeded'), null);
  assert.equal(classify, classifyFailure);
  assert.deepEqual(REST_MS, { rate_limit: 3_600_000, overloaded: 300_000, signed_out: 0, not_included: 0, network: 0 });
});
