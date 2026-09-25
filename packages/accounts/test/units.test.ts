// Stores, isolate(), classify and words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORDS, classify, fileStore, isolate, say, signInError } from '../src/index.ts';

test('the file store: Pi\'s auth.json shape, 0600 in a 0700 folder, serialized writes', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'byokit-store-')), 'people', '1');
  const path = join(dir, 'auth.json');
  const s = fileStore(path);
  assert.equal(await s.read('openai-codex'), undefined);
  const cred = { type: 'oauth' as const, access: 'a', refresh: 'r', expires: 1 };
  await Promise.all([s.modify('openai-codex', async () => cred), s.modify('xai', async () => ({ type: 'api_key', key: 'k' }))]);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { 'openai-codex': cred, xai: { type: 'api_key', key: 'k' } });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.deepEqual(await s.list(), [{ providerId: 'openai-codex', type: 'oauth' }, { providerId: 'xai', type: 'api_key' }]);
  assert.deepEqual(await s.modify('xai', async () => undefined), { type: 'api_key', key: 'k' }, 'undefined leaves it as it was');
  await s.delete('xai');
  assert.deepEqual(await fileStore(path).list(), [{ providerId: 'openai-codex', type: 'oauth' }]);
});

test('isolate() scrubs inherited Pi settings and provider keys, and pins the engine folder', () => {
  Object.assign(process.env, { PI_CODING_AGENT_DIR: '/home/x/.pi/agent', PI_PACKAGE_DIR: '/x', OPENAI_API_KEY: 'k', GH_TOKEN: 't', AI_AGENT: 'pi', KEEP_ME: '1' });
  const dir = join(mkdtempSync(join(tmpdir(), 'byokit-iso-')), 'engine');
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
  assert.equal(signInError('ChatGPT', 'device code login is not enabled'), 'ChatGPT needs device sign-in turned on first: in ChatGPT, Settings, Security, turn on device code sign-in, then try again.');
});
