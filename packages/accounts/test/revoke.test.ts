// Signing out ends the sign-in at ChatGPT too, against a mocked revoke endpoint: the shared cases in
// fixtures/conformance/revoke.json, which byokit-android passes as well.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, PROVIDERS, memoryStore, type AuthHost, type Member } from '../src/index.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/revoke.json', import.meta.url), 'utf8'));
let answer: number | 'offline' = 200;
const sent: { url: string; body: unknown }[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  sent.push({ url, body: JSON.parse(String(init?.body)) });
  if (answer === 'offline') throw new Error('fetch failed');
  return new Response('{}', { status: answer });
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

test('the catalogue revokes where the fixture says', () => {
  assert.equal(PROVIDERS.chatgpt.revoke, fixture.url);
  assert.equal(PROVIDERS.chatgpt.clientId, fixture.clientId);
});

for (const [i, c] of fixture.cases.entries()) test(`sign-out, revoke case ${i}: answer ${c.answer}, ${c.request ? 'one request' : 'no request'}`, async () => {
  const store = memoryStore();
  if (c.credential) await store.modify('openai-codex', async () => c.credential);
  const a = new Accounts({ store: () => store });
  answer = c.answer;
  sent.length = 0;
  if (c.request && c.answer !== 200) await assert.rejects(a.logout(1, 'chatgpt'), /sign-out failed|fetch failed/);
  else await a.logout(1, 'chatgpt');
  assert.deepEqual(sent, c.request ? [{ url: fixture.url, body: c.request }] : []);
  assert.equal(await store.read('openai-codex'), undefined, 'deleted here whatever ChatGPT answered');
  assert.equal(await a.signedIn(1, 'chatgpt'), false);
});

class ExternalKit extends Accounts {
  readonly external = memoryStore();
  protected open(member: Member) { return this.engine(member, this.external); }
}

test('an overridden engine revokes from its own store before deleting, including on failure', async () => {
  const a = new ExternalKit();
  for (const status of [200, 500]) {
    const credential = fixture.cases[0].credential;
    await a.external.modify('openai-codex', async () => credential);
    answer = status;
    sent.length = 0;
    assert.notEqual(await a.plan(1), null);
    if (status === 500) await assert.rejects(a.logout(1, 'chatgpt'), /sign-out failed \(500\)/);
    else await a.logout(1, 'chatgpt');
    assert.deepEqual(sent, [{ url: fixture.url, body: fixture.cases[0].request }]);
    assert.equal(await a.external.read('openai-codex'), undefined);
    assert.equal(await a.signedIn(1, 'chatgpt'), false);
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class RaceKit extends Accounts {
  readonly external = memoryStore();
  readonly refreshStarted = deferred<void>();
  readonly releaseRefresh = deferred<void>();
  readonly holdStarted = deferred<void>();
  readonly releaseHold = deferred<void>();
  readonly loginStarted = deferred<void>();
  readonly releaseLogin = deferred<void>();
  protected open(member: Member) {
    const credentials = this.boundStore(member, this.external);
    return Promise.resolve({
      credentialStore: credentials,
      readCredential: credentials.read,
      checkAuth: async (id: string) => (await credentials.read(id)) ? { type: 'oauth' } : undefined,
      logout: (id: string) => credentials.delete(id),
      getAuth: async (id: string) => {
        const credential = await credentials.modify(id, async (old) => {
          this.refreshStarted.resolve();
          await this.releaseRefresh.promise;
          return old?.type === 'oauth' ? { ...old, refresh: 'rt_rotated' } : undefined;
        });
        return credential ? { auth: {} } : undefined;
      },
      login: async (id: string, _type: string, interaction: any) => {
        interaction.notify({ type: 'device_code', userCode: 'ABCD', verificationUri: 'https://example.test', expiresInSeconds: 900 });
        this.loginStarted.resolve();
        await this.releaseLogin.promise;
        const credential = fixture.cases[0].credential;
        await credentials.modify(id, async () => credential, { signal: interaction.signal });
        return credential;
      },
    } as unknown as AuthHost);
  }
}

test('refresh completing after sign-out revokes the rotated token before deleting', async () => {
  const a = new RaceKit();
  await a.external.modify('openai-codex', async () => fixture.cases[0].credential);
  assert.equal(await a.signedIn(1, 'chatgpt'), true);
  answer = 200;
  sent.length = 0;
  const refresh = (await a.runtime(1)).getAuth('openai-codex');
  await a.refreshStarted.promise;
  const logout = a.logout(1, 'chatgpt');
  a.releaseRefresh.resolve();
  assert.equal(await refresh, undefined);
  await logout;
  assert.deepEqual(sent.map((s) => (s.body as any).token), ['rt_rotated', 'rt_1']);
  assert.equal(await a.external.read('openai-codex'), undefined);
});

test('a queued stale refresh cannot return the old stored credential', async () => {
  const a = new RaceKit();
  await a.external.modify('openai-codex', async () => fixture.cases[0].credential);
  answer = 200;
  sent.length = 0;
  const rt = await a.runtime(1);
  const hold = rt.credentialStore.modify('openai-codex', async () => {
    a.holdStarted.resolve();
    await a.releaseHold.promise;
    return undefined;
  });
  await a.holdStarted.promise;
  const refresh = rt.getAuth('openai-codex');
  const logout = a.logout(1, 'chatgpt');
  a.releaseRefresh.resolve();
  a.releaseHold.resolve();
  await hold;
  assert.equal(await refresh, undefined);
  await logout;
  assert.deepEqual(sent.map((s) => (s.body as any).token), ['rt_1']);
  assert.equal(await a.external.read('openai-codex'), undefined);
});

test('a late sign-in cannot restore credentials and reports a failed revoke', async () => {
  for (const status of [200, 500]) {
    const a = new RaceKit();
    const errors: string[] = [];
    a.onSignOutError = (member, key, error) => errors.push(`${member}:${key}: ${error.message}`);
    answer = status;
    sent.length = 0;
    await a.login(1, 'chatgpt', { via: 'code' });
    await a.loginStarted.promise;
    const finished = a.finished(1, 'chatgpt');
    await a.logout(1, 'chatgpt');
    a.releaseLogin.resolve();
    await finished;
    assert.deepEqual(sent.map((s) => (s.body as any).token), ['rt_1']);
    assert.deepEqual(errors, status === 200 ? [] : ['1:chatgpt: ChatGPT sign-out failed (500)']);
    assert.equal(await a.external.read('openai-codex'), undefined);
    assert.equal(await a.signedIn(1, 'chatgpt'), false);
  }
});
