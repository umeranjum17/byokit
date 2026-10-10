// The kit's own logic on a scripted engine: sign-in with its fallbacks and failures, status, rests, the ladder, refresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AuthInteraction } from '@earendil-works/pi-ai';
import { Accounts, PROVIDERS, memoryStore, offered, ResponseError, type AuthHost, type Member } from '../src/index.ts';

/** A scripted engine: `script(interaction, attempt)` plays one login; credentials live in a plain map. */
function engine(script: (i: AuthInteraction, attempt: number) => Promise<void>) {
  const signed = new Set<string>();
  let attempts = 0, refresh: 'ok' | 'refused' | 'offline' = 'ok';
  const host: AuthHost = {
    readCredential: async () => undefined,
    credentialStore: { read: async () => undefined, list: async () => [], modify: async () => undefined,
      delete: async (id) => { signed.delete(id); }, signOut: async (id) => { signed.delete(id); } },
    login: async (id, _type, i) => { await script(i, ++attempts); signed.add(id); return { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 3_600_000 }; },
    logout: async (id) => { signed.delete(id); },
    checkAuth: async (id) => (signed.has(id) ? { type: 'oauth' } : undefined),
    getAuth: (async (id: string) => {
      if (refresh === 'refused') throw Object.assign(new Error('invalid_grant: refresh token revoked'), { status: 401 });
      if (refresh === 'offline') throw new Error('fetch failed');
      return signed.has(id) ? { auth: {} } : undefined;
    }) as AuthHost['getAuth'],
  };
  return { host, signed, set refresh(v: typeof refresh) { refresh = v; } };
}
// ChatGPT's redirect listener takes a free port here, never the real 1455.
const port = await new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => r(port)); }); });
class Kit extends Accounts {
  hosts = new Map<string, ReturnType<typeof engine>>();
  script: Parameters<typeof engine>[0];
  constructor(script: Parameters<typeof engine>[0], offer?: string[]) { super({ offer, signInMs: 500, callbackPort: port, store: () => memoryStore() }); this.script = script; }
  protected open(member: Member) { const e = engine(this.script); this.hosts.set(String(member), e); return Promise.resolve(e.host); }
}
const pick = (i: AuthInteraction) => i.prompt({ type: 'select', message: 'how', options: [{ id: 'browser', label: 'Browser' }, { id: 'device_code', label: 'Device code' }] });
const code = (i: AuthInteraction) => i.notify({ type: 'device_code', userCode: 'CREW-2026', verificationUri: 'https://example.test/device', expiresInSeconds: 900 });

test('the catalogue offers every subscription by default and keeps API billing opt-in', async () => {
  const subscriptions = ['chatgpt', 'grok', 'copilot', 'claude', 'kimi', 'meta', 'minimax', 'google-gemini-cli'];
  assert.deepEqual(offered().map((p) => p.key), subscriptions);
  assert.deepEqual(new Kit(async () => {}).providers.map((p) => p.key), subscriptions);
  assert.deepEqual(offered(['openrouter']).map((p) => p.key), ['openrouter']);
  assert.deepEqual(offered(['claude', 'grok']).map((p) => p.key), ['claude', 'grok']);
  const existing = ['chatgpt', 'grok', 'copilot', 'openrouter', 'minimax', 'claude'];
  assert.deepEqual(offered(existing).map((p) => p.key), existing, 'existing explicit account lists keep every provider');
  for (const p of Object.values(PROVIDERS)) {
    assert.ok(p.billing === 'subscription' || p.billing === 'api' || p.billing === 'unknown', p.key);
    assert.ok(p.source.startsWith('https://'), p.key);
    for (const removed of ['terms', 'hidden', 'why']) assert.ok(!(removed in p));
  }
  for (const key of ['openai', 'typesafe']) {
    assert.equal(PROVIDERS[key].billing, 'api');
    assert.equal(PROVIDERS[key].auth, 'api-key');
    assert.equal(PROVIDERS[key].offer, false);
  }
  assert.equal(PROVIDERS.chatgpt.models.strong, 'gpt-6-sol');
  assert.equal(PROVIDERS.anthropic.billing, 'api');
  assert.equal(PROVIDERS.anthropic.auth, 'api-key');
  assert.equal(PROVIDERS.anthropic.label, 'API key (billed per use)');
  assert.equal(PROVIDERS.anthropic.offer, false);
  assert.deepEqual(offered(['anthropic']).map((p) => p.key), ['anthropic']);
  assert.equal(PROVIDERS.claude.pi, 'byokit-claude-plan');
  await assert.rejects(new Kit(async () => {}, ['chatgpt']).login(1, 'grok'), /not offered/);
});

test('a code sign-in: the code shows at once, the sign-in finishes by itself, and it is one person\'s alone', async () => {
  const kit = new Kit(async (i) => { assert.equal(await pick(i), 'device_code'); code(i); await new Promise((r) => setTimeout(r, 20)); });
  const shown = await kit.login(1, 'chatgpt', { via: 'code' });
  assert.deepEqual([shown?.state, shown?.code, shown?.url], ['waiting', 'CREW-2026', 'https://example.test/device']);
  assert.equal((await kit.status(1, 'chatgpt')).words, 'Signing in to ChatGPT…');
  await kit.finished(1, 'chatgpt');
  assert.equal(kit.view(1, 'chatgpt')?.state, 'done');
  assert.deepEqual(await kit.status(1, 'chatgpt'), { id: 'chatgpt', provider: 'chatgpt', account: 'chatgpt', name: 'ChatGPT', state: 'ready', until: undefined, words: 'ChatGPT is connected.' });
  assert.equal((await kit.status(2, 'chatgpt')).state, 'signed_out');
  assert.equal(await kit.signedIn(2, 'chatgpt'), false);
});

test('a browser sign-in that cannot come back falls back to a code by itself (ChatGPT\'s own redirect: signin.test.ts); a pasted address finishes it too', async () => {
  const kit = new Kit(async (i, n) => {
    if (await pick(i) === 'browser') { i.notify({ type: 'auth_url', url: 'https://example.test/authorize' }); if (n === 1) throw new Error('its own listener could not start'); }
    else code(i);
  }, ['grok']);
  await kit.login(1, 'grok');
  await kit.finished(1, 'grok');
  assert.deepEqual([kit.view(1, 'grok')?.state, kit.view(1, 'grok')?.via], ['done', 'code']);

  let pasted = '';
  const paste = new Kit(async (i) => { await pick(i); i.notify({ type: 'auth_url', url: 'https://example.test/authorize' }); pasted = await i.prompt({ type: 'manual_code', message: 'paste' }); });
  assert.equal((await paste.login(1, 'chatgpt'))?.url, 'https://example.test/authorize');
  paste.paste(1, 'chatgpt', '  http://localhost:1455/auth/callback?code=x  ');
  await paste.finished(1, 'chatgpt');
  assert.equal(pasted, 'http://localhost:1455/auth/callback?code=x');
  assert.throws(() => paste.paste(1, 'chatgpt', 'again'), /no sign-in is waiting/);
});

test('every failure ends in one plain sentence, and a cancelled sign-in keeps nothing', async () => {
  const declined = new Kit(async () => { throw new Error('access_denied'); });
  await declined.login(1, 'chatgpt');
  assert.deepEqual([declined.view(1, 'chatgpt')?.why, declined.view(1, 'chatgpt')?.error], ['declined', 'The sign-in was declined on the ChatGPT page. Tap Sign in with ChatGPT to try again.']);

  const stalls = new Kit((i) => { code(i); return new Promise((_, no) => i.signal!.addEventListener('abort', () => no(new Error('aborted')))); });
  await stalls.login(1, 'chatgpt');
  await stalls.finished(1, 'chatgpt');
  assert.deepEqual([stalls.view(1, 'chatgpt')?.why, stalls.view(1, 'chatgpt')?.error], ['tooLong', 'The sign-in took too long. Tap Sign in with ChatGPT to start again.']);

  const cancel = new Kit((i) => { code(i); return new Promise((_, no) => i.signal!.addEventListener('abort', () => no(new Error('aborted')))); });
  await cancel.login(1, 'chatgpt');
  cancel.cancel(1, 'chatgpt');
  assert.equal(cancel.view(1, 'chatgpt'), null);
  assert.equal(await cancel.signedIn(1, 'chatgpt'), false);
});

test('limits: an account rests until it said, the ladder skips it, and a refusal signs it out', async () => {
  const kit = new Kit(async () => {}, ['chatgpt', 'grok']);
  const said = await kit.failed(1, 'chatgpt', 'You have hit your ChatGPT usage limit (plus plan). Try again in ~30 min.');
  assert.equal(said?.kind, 'rate_limit');
  assert.ok(Math.abs(kit.restingUntil(1, 'chatgpt') - (Date.now() + 30 * 60_000)) < 1000);
  assert.equal(kit.restingUntil(2, 'chatgpt'), 0, 'one person\'s limit is theirs alone');
  assert.match((await kit.status(1, 'chatgpt')).words, /^ChatGPT is resting until (?:(?:Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?\d+:\d\d\s?[ap]m\.$/);
  assert.equal(kit.ladder(1, ['chatgpt', 'grok']), 'grok');
  await kit.failed(1, 'grok', '503 overloaded');
  assert.equal((await kit.status(1, 'grok')).words, 'Grok is busy right now.');
  assert.equal(kit.ladder(1, [{ provider: 'chatgpt' }, { provider: 'grok' }], (b) => b.provider), undefined);
  assert.equal((await kit.failed(2, 'grok', '401 Unauthorized'))?.kind, 'signed_out', 'it no longer refreshes: signed out for real');
  assert.equal(kit.unready(2, 'grok'), true);
  assert.equal((await kit.status(2, 'grok')).words, 'Grok needs you to sign in again.');
  assert.equal(await kit.failed(2, 'chatgpt', 'context window exceeded by your prompt'), null);
  assert.equal((await kit.failed(2, 'chatgpt', 'fetch failed'))?.kind, 'network');
  assert.equal(kit.restingUntil(2, 'chatgpt'), 0, 'a network hiccup is not a rest');

  // The ChatGPT/Codex "Next reset in N hours" wording rests until that reset, not the 60-minute fallback.
  const reset = await kit.failed(1, 'chatgpt', "You've reached your Codex subscription usage limit. Next reset in 4 hours, 3:00 PM.");
  assert.equal(reset?.kind, 'rate_limit');
  assert.ok(Math.abs((reset?.until ?? 0) - (Date.now() + 4 * 3_600_000)) < 1000, `until ${reset?.until}`);
  assert.ok(Math.abs(kit.restingUntil(1, 'chatgpt') - (Date.now() + 4 * 3_600_000)) < 1000);
  // A rate limit that names no reset keeps the 60-minute fallback.
  const capped = await kit.failed(1, 'chatgpt', 'You have hit your ChatGPT usage limit (plus plan).');
  assert.equal(capped?.kind, 'rate_limit');
  assert.ok(Math.abs(kit.restingUntil(1, 'chatgpt') - (Date.now() + 60 * 60_000)) < 1000);

  // A refusal from an account that still refreshes was a passing one: a short rest, not a sign-out.
  await kit.login(3, 'chatgpt');
  await kit.finished(3, 'chatgpt');
  assert.equal((await kit.failed(3, 'chatgpt', '401 Unauthorized'))?.kind, 'overloaded');
  assert.equal((await kit.status(3, 'chatgpt')).words, 'ChatGPT is busy right now.');
  // A plan without this use: unusable until the person says they changed it, or signs in again.
  assert.equal((await kit.failed(3, 'grok', "You have hit your usage limit. Your plan doesn't include Codex."))?.kind, 'not_included');
  assert.equal(kit.unready(3, 'grok'), true);
  kit.notIncluded(3, 'grok', false);
  assert.equal(kit.unready(3, 'grok'), false);
});

test('keepFresh signs out only an account whose provider refuses, and says so once', async () => {
  const kit = new Kit(async () => {});
  await kit.login(1, 'chatgpt');
  await kit.finished(1, 'chatgpt');
  const expired: string[] = [];
  kit.onExpired = (m, k) => expired.push(`${m}:${k}`);
  kit.hosts.get('1')!.refresh = 'offline';
  await kit.keepFresh([1, 2]);
  assert.deepEqual(expired, []);
  kit.hosts.get('1')!.refresh = 'refused';
  await kit.keepFresh([1, 2]);
  await kit.keepFresh([1, 2]);
  assert.deepEqual(expired, ['1:chatgpt']);
  assert.equal((await kit.status(1, 'chatgpt')).state, 'needs_again');
});


test('sign-in failure logs contain no provider secrets, URLs, causes or member data', async () => {
  const secret = 'access-canary refresh-canary api-key-canary';
  const logs: unknown[][] = [];
  const original = console.error;
  console.error = (...args) => { logs.push(args); };
  const kit = new Kit(async () => {
    throw new Error(`provider returned ${secret} https://example.test/?token=${secret}`, { cause: { secret } });
  });
  try {
    await kit.login('private-member-canary', 'chatgpt', { via: 'code' });
    await kit.finished('private-member-canary', 'chatgpt');
    assert.equal(kit.view('private-member-canary', 'chatgpt')?.state, 'failed');
    assert.deepEqual(logs, [['Sign-in failed']]);
  } finally { kit.stop(); console.error = original; }
});

test('member key routes: sealed locally, consented, redacted, isolated, and handed to decide', async (t) => {
  const logs = [t.mock.method(console, 'error', () => {}), t.mock.method(console, 'log', () => {}), t.mock.method(console, 'warn', () => {})];
  const { fileStore: secretFile } = await import('../../secrets/src/file.ts');
  const { scratchDir } = await import('../../test-support.ts');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { jev } = await import('../../decide/src/jev.ts');
  const { openai } = await import('../../decide/src/openai.ts');
  const dir = scratchDir('member-keys');
  const keyStore = (member: Member) => secretFile({ path: join(dir, `${member}.json`), passphrase: new Uint8Array(32).fill(7) });
  const accounts = new Accounts({ offer: ['chatgpt', 'openai', 'typesafe', 'openrouter'], keyStore, store: () => memoryStore() });
  const observed: unknown[] = [];
  accounts.onChange = (member, route) => observed.push([member, route]);
  accounts.onSignedIn = (member, route) => observed.push([member, route]);
  const questions = { match: { kind: 'yesno' as const, question: 'Does this design fit Umer?' } };
  const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/member-keys-typescript.json', import.meta.url), 'utf8')) as { routes: { key: string; label: string }[] };
  for (const { key: route, label } of fixture.routes) {
    const secret = `fake-key-${route}-canary`;
    await assert.rejects(accounts.saveKey('Umer', route, secret, { billedPerUse: false } as any), /billing per use/);
    assert.equal((await accounts.status('Umer', route)).state, 'signed_out');
    observed.push(await accounts.saveKey('Umer', route, secret, { billedPerUse: true }));
    observed.push(await accounts.status('Umer', route), accounts.view('Umer', route));
    assert.equal((await accounts.status('Umer', route)).state, 'ready');
    assert.equal((await accounts.status('another-member', route)).state, 'signed_out');
    assert.equal(accounts.ladder('Umer', [route]), undefined);
    assert.equal(accounts.providers.find((p) => p.key === route)?.label, label);
    assert.ok(!readFileSync(join(dir, 'Umer.json'), 'utf8').includes(secret));
    assert.ok(!JSON.stringify(observed).includes(secret));
    const restored = new Accounts({ offer: [route], keyStore, store: () => memoryStore() });
    const key = await restored.key('Umer', route);
    let calls = 0;
    const fakeFetch: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${secret}`);
      assert.equal(String(url), route === 'openai' ? 'https://api.openai.com/v1/responses' : route === 'typesafe' ? 'https://api.typesafe.ai/v1/systemone' : 'https://openrouter.ai/api/v1/systemone');
      return Response.json(route === 'openai'
        ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ match: { probabilities: { true: 0.9, false: 0.1 }, pick: 'true' } }) }] }] }
        : { answers: { match: { noul: 0.9 } } });
    };
    const backend = route === 'openai' ? openai({ key, model: 'fake-model', fetch: fakeFetch })
      : jev({ key, via: route === 'typesafe' ? 'typesafe' : 'openrouter', fetch: fakeFetch });
    const answer = await backend.ask({ name: 'Umer' }, questions, new AbortController().signal);
    assert.equal(answer.match?.probabilities.true, 0.9);
    assert.equal(calls, 1);
    assert.equal((await accounts.failed('Umer', route, new ResponseError('Connect this account again.', 'signed_out')))?.kind, 'signed_out');
    assert.equal((await accounts.status('Umer', route)).state, 'needs_again');
    await accounts.saveKey('Umer', route, secret, { billedPerUse: true });
    await accounts.logout('Umer', route);
    await assert.rejects(restored.key('Umer', route), /isn't signed in/);
  }
  const leaking = new Accounts({ offer: ['openai'], keyStore: () => ({
    get: async () => { throw new Error('fake-key-openai-canary'); },
    set: async () => { throw new Error('fake-key-openai-canary'); },
    delete: async () => { throw new Error('fake-key-openai-canary'); },
  }) });
  for (const action of [() => leaking.saveKey('Umer', 'openai', 'fake-key-openai-canary', { billedPerUse: true }),
    () => leaking.key('Umer', 'openai'), () => leaking.status('Umer', 'openai'), () => leaking.logout('Umer', 'openai')]) {
    await assert.rejects(action(), (error: Error) => {
      assert.ok(!String(error.stack).includes('fake-key-openai-canary'));
      assert.equal((error as Error & { cause?: unknown }).cause, undefined);
      return true;
    });
  }
  await assert.rejects(new Accounts().saveKey('Umer', 'openai', 'fake', { billedPerUse: true }), /not offered/);
  await assert.rejects(new Accounts({ offer: ['openai'] }).saveKey('Umer', 'openai', 'fake', { billedPerUse: true }), /Saved keys/);
  assert.ok(!JSON.stringify(logs.flatMap((log) => log.mock.calls.map((call) => call.arguments))).includes('canary'));
});
