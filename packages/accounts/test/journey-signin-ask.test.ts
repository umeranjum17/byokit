// A consumer's own journey against the built @byokit/accounts: the README quickstart, run as a user would run it.
// Every import is a published entry (the package's dist, never the package's own src modules), the provider is the
// kit's own loopback stand-in OpenAI, and the sign-in is kept in a real encrypted file store. The failures and the
// store's safety the person depends on are asserted in the same journey rather than in separate unit tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Accounts, KeyRouteError, SignInReturnError, WORDS, billingWords, classify, fileStore, isolate, launchEnv, memoryStore, offered, portable, PROVIDERS, say } from '@byokit/accounts';
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
    const answer = await accounts.respond(1, { model: 'gpt-6-sol', instructions: 'Answer briefly.', input: 'Plan my day', onText: (piece) => { streamed += piece; } });
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

test("on a phone, one button: ChatGPT's own page in the app's in-app browser, and the address it comes back to signs in", async () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/chatgpt-redirect-typescript.json', import.meta.url), 'utf8'));
  const openai = await mockOpenAI();
  const options = { authBase: openai.base, apiBase: openai.base, app: 'byokit journey', store: () => memoryStore() };
  const accounts = new Accounts<any, number>(options, portable);
  // The app's in-app browser: it follows the page until the page sends it to the address the app watches for, and stops there.
  const browse = async (shown: { url?: string; returnTo?: string }) => {
    const next = (await fetch(shown.url!, { redirect: 'manual' })).headers.get('location')!;
    assert.ok(next.startsWith(shown.returnTo!), next);
    return next;
  };
  const refused = (code: string) => (e: unknown) => e instanceof SignInReturnError && e.code === code && !!e.message;
  try {
    // The stand-in refuses every other return address, as OpenAI's page does.
    for (const other of fixture.refused) {
      const asked = new URL(`${openai.base}/oauth/authorize`);
      for (const [k, v] of Object.entries({ ...fixture.authorize, redirect_uri: other, code_challenge: 'c', state: 's' })) asked.searchParams.set(k, v as string);
      assert.equal((await fetch(asked, { redirect: 'manual' })).status, 400, other);
    }
    // The device code stays the phone's default.
    assert.equal((await accounts.login(3, 'chatgpt'))?.via, 'code');
    accounts.cancel(3, 'chatgpt');

    // One button: the page to open and the address to watch for; the PKCE verifier never leaves the kit.
    const shown = (await accounts.login(1, 'chatgpt', { via: 'redirect' }))!;
    assert.deepEqual([shown.state, shown.via, shown.returnTo], ['waiting', 'browser', fixture.returnTo]);
    const page = new URL(shown.url!);
    for (const [k, v] of Object.entries(fixture.authorize)) assert.equal(page.searchParams.get(k), v, k);
    assert.ok(page.searchParams.get('state') && page.searchParams.get('code_challenge'));
    assert.ok(shown.expiresAt! > Date.now());
    assert.doesNotMatch(JSON.stringify(shown), /verifier/);
    const back = await browse(shown);

    // An address from another sign-in is turned away and the real one carries on.
    await assert.rejects(accounts.complete(1, 'chatgpt', back.replace(/state=[^&]+/, 'state=another')), refused(fixture.outcomes["another sign-in's state"]));
    assert.equal(accounts.view(1, 'chatgpt')?.state, 'waiting');
    assert.equal((await accounts.complete(1, 'chatgpt', back))?.state, 'done');
    assert.equal((await accounts.status(1, 'chatgpt')).words, 'ChatGPT is connected.');
    assert.equal(await accounts.respond(1, { model: 'gpt-6-sol', instructions: 'Answer briefly.', input: 'Plan my day' }), 'You said: Plan my day');
    // Handed over twice, or with no sign-in waiting: turned away, and the sign-in made stays.
    await assert.rejects(accounts.complete(1, 'chatgpt', back), refused(fixture.outcomes['the same address twice']));
    await assert.rejects(accounts.complete(2, 'chatgpt', back), refused(fixture.outcomes['no redirect sign-in waiting']));
    assert.equal(await accounts.signedIn(1, 'chatgpt'), true);

    // Declined on the page: one plain sentence, nothing kept.
    openai.state.decline = true;
    const declined = await accounts.complete(2, 'chatgpt', await browse((await accounts.login(2, 'chatgpt', { via: 'redirect' }))!));
    assert.deepEqual([declined?.state, declined?.why], ['failed', 'declined']);
    assert.equal(await accounts.signedIn(2, 'chatgpt'), false);
    openai.state.decline = false;

    // Too late: the sign-in has ended, and the address is turned away as expired.
    const slow = new Accounts<any, number>({ ...options, signInMs: 200 }, portable);
    const late = await browse((await slow.login(1, 'chatgpt', { via: 'redirect' }))!);
    await new Promise((r) => setTimeout(r, 300));
    await assert.rejects(slow.complete(1, 'chatgpt', late), refused(fixture.outcomes['after signInMs']));
    assert.deepEqual([slow.view(1, 'chatgpt')?.state, slow.view(1, 'chatgpt')?.why, await slow.signedIn(1, 'chatgpt')], ['failed', 'tooLong', false]);
    slow.stop();

    // Only ChatGPT has this way in, and a computer keeps its own listener on the same address.
    await assert.rejects(accounts.login(1, 'grok', { via: 'redirect' }), /no in-app browser sign-in/);
    await assert.rejects(new Accounts<any, number>({ store: () => memoryStore() }).login(1, 'chatgpt', { via: 'redirect' }), /On a computer/);
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
    // An OpenCode Go key with several workspaces: the typed pick in every wording, and it rests nothing.
    assert.equal(classify(new KeyRouteError('needs_workspace').message)?.kind, 'needs_workspace');
    assert.equal(classify('Workspace selection is required')?.kind, 'needs_workspace');
    assert.equal(classify('403 Workspace selection is required')?.kind, 'needs_workspace');
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
