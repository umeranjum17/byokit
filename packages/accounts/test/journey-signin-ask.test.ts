// A consumer's own journey against the built @byokit/accounts: the README quickstart, run as a user would run it.
// Every import is a published entry (the package's dist, never the package's own src modules), the provider is the
// kit's own loopback stand-in OpenAI, and the sign-in is kept in a real encrypted file store. The failures and the
// store's safety the person depends on are asserted in the same journey rather than in separate unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Accounts, WORDS, billingWords, classify, fileStore, isolate, launchEnv, memoryStore, offered, portable, PROVIDERS, say } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { scratchDir } from '../../test-support.ts';

// The test's own authenticated seal: an app's OS keychain seal stands in as AES-256-GCM. The key never leaves the run.
const key = randomBytes(32);
const sealing = {
  encryptString(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  },
  decryptString(data: Buffer) {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  },
};

test('a person signs in with the ChatGPT plan they already pay for, asks, and the sign-in is kept privately', async () => {
  const openai = await mockOpenAI();
  const dir = scratchDir('journey-signin');
  const storeOf = (member: number) => join(dir, `member-${member}.json`);
  const accounts = new Accounts<any, number>(
    { authBase: openai.base, apiBase: openai.base, app: 'byokit journey', store: (member) => fileStore(storeOf(member), sealing) },
    portable,
  );
  try {
    // The catalogue offers the subscriptions a person brought, and keeps API billing explicit.
    assert.deepEqual(offered().map((p) => p.key).slice(0, 6), ['chatgpt', 'grok', 'copilot', 'claude', 'kimi', 'meta']);

    // The code shows on the app's own page while the person opens the provider's page and types it.
    const shown = (await accounts.login(1, 'chatgpt'))!;
    assert.deepEqual([shown.state, shown.via], ['waiting', 'code']);
    assert.match(shown.code!, /^MOCK-/);
    assert.equal((await accounts.status(1, 'chatgpt')).words, 'Signing in to ChatGPT…');

    // They approve it on the provider's page; the app notices the sign-in finished by itself.
    openai.approve(shown.code!);
    await accounts.finished(1, 'chatgpt');
    const ready = await accounts.status(1, 'chatgpt');
    assert.deepEqual([ready.state, ready.words], ['ready', 'ChatGPT is connected.']);
    // One person's sign-in is their own: another member on the same machine still sees nothing.
    assert.equal((await accounts.status(2, 'chatgpt')).state, 'signed_out');

    // They ask a question: the answer streams in pieces, then the final answer is returned.
    let streamed = '';
    const answer = await accounts.respond(1, { instructions: 'Answer briefly.', input: 'Plan my day', onText: (piece) => { streamed += piece; } });
    assert.equal(answer, 'You said: Plan my day');
    assert.equal(streamed, answer);

    // The sign-in is kept privately: a 0600 file in a 0700 folder with nothing a reader could use.
    assert.equal(statSync(storeOf(1)).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.doesNotMatch(readFileSync(storeOf(1), 'latin1'), /umer@example|acct-1|access|refresh|rt_/i);
    // A write that leaves the value undefined must not erase the sign-in: a person stays signed in.
    const reopened = fileStore(storeOf(1), sealing);
    assert.equal((await reopened.modify('openai-codex', async () => undefined))?.type, 'oauth');

    // Signing out ends it, and removes it from the store.
    await accounts.logout(1, 'chatgpt');
    assert.equal(await accounts.signedIn(1, 'chatgpt'), false);
    assert.equal(await reopened.read('openai-codex'), undefined);
  } finally {
    accounts.stop();
    await openai.close();
  }
});

test("a declined sign-in is one plain sentence and keeps nothing; the words shown carry no jargon a person must look up", async () => {
  const openai = await mockOpenAI();
  const accounts = new Accounts<any, number>({ authBase: openai.base, app: 'byokit journey', store: () => memoryStore() }, portable);
  try {
    const shown = (await accounts.login(1, 'chatgpt'))!;
    openai.approve(shown.code!, true); // declined on the provider's page
    await accounts.finished(1, 'chatgpt');
    assert.deepEqual(
      [accounts.view(1, 'chatgpt')?.why, accounts.view(1, 'chatgpt')?.error],
      ['declined', 'The sign-in was declined on the ChatGPT page. Tap Sign in with ChatGPT to try again.'],
    );
    assert.equal(await accounts.signedIn(1, 'chatgpt'), false, 'a declined sign-in keeps nothing');

    // A sign-in that cannot reach its provider ends in one plain line, and the log carries no token or address.
    const logs: unknown[][] = [];
    const original = console.error;
    console.error = (...args) => { logs.push(args); };
    try {
      const unreachable = new Accounts<any, number>({ authBase: 'http://127.0.0.1:1', app: 'byokit journey', signInMs: 300, store: () => memoryStore() }, portable);
      await unreachable.login(1, 'chatgpt');
      await unreachable.finished(1, 'chatgpt');
      assert.equal(unreachable.view(1, 'chatgpt')?.why, 'offline');
      assert.ok(logs.some((line) => JSON.stringify(line).includes('Sign-in failed')));
      assert.doesNotMatch(JSON.stringify(logs), /token|refresh|access|https?:/i, 'no provider secret or address is ever logged');
      unreachable.stop();
    } finally {
      console.error = original;
    }

    // The sentences a person reads never expose codes, commands, paths, model ids or jargon.
    const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
    for (const [name, words] of Object.entries(WORDS)) assert.doesNotMatch(words.replace(/\{\w+\}/g, 'X'), banned, name);
    assert.equal(say('terms.grey', { name: 'ChatGPT', company: 'OpenAI' }), 'Uses your ChatGPT plan. OpenAI may change this at any time.');
    assert.equal(billingWords(PROVIDERS.chatgpt), 'Uses your ChatGPT plan.');
    // A failure is classified into the kind an app acts on, and no further.
    assert.equal(classify('429 Too Many Requests, try again in 2h')?.kind, 'rate_limit');
    assert.equal(classify('401 Unauthorized')?.kind, 'signed_out');
    assert.equal(classify('context window exceeded by your prompt'), null);
  } finally {
    accounts.stop();
    await openai.close();
  }
});

test('a store that cannot encrypt is refused, and a child process carries no ambient provider credential', () => {
  const dir = scratchDir('journey-store');
  const path = join(dir, 'auth.json');
  // No plaintext fallback: a missing, unavailable or weak seal is refused before any sign-in is written.
  assert.throws(() => fileStore(path, undefined as never), /sealing adapter/);
  assert.throws(() => fileStore(path, { ...sealing, isEncryptionAvailable: () => false }), /unavailable/);
  assert.throws(() => fileStore(path, { ...sealing, getSelectedStorageBackend: () => 'basic_text' }), /unavailable/);

  // isolate() makes the app's own private engine folder; launchEnv() strips every ambient credential from a child,
  // and touching neither ever changes the caller's own environment.
  const engine = isolate(join(dir, 'engine'));
  assert.equal(statSync(engine).mode & 0o777, 0o700);
  const ambient = ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'OPENROUTER_API_KEY', 'GITHUB_TOKEN'];
  const base = { PATH: '/usr/bin', HOME: '/app', KEEP: 'yes', ...Object.fromEntries(ambient.map((name) => [name, 'fake-credential'])) };
  const launch = launchEnv({ base, set: { NAME: 'Umer' } });
  assert.ok(ambient.every((name) => !(name in launch.env)));
  assert.equal(launch.env.PATH, '/usr/bin');
  assert.equal(launch.env.NAME, 'Umer');
  const before = JSON.stringify(process.env);
  launchEnv();
  assert.equal(JSON.stringify(process.env), before, 'the parent environment is never changed');
});
