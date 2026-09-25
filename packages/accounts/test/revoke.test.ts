// Signing out ends the sign-in at ChatGPT too, against a mocked revoke endpoint: the shared cases in
// fixtures/conformance/revoke.json, which byokit-android passes as well.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, PROVIDERS, memoryStore, type Member } from '../src/index.ts';

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
  protected open(member: Member) { return new Accounts({ store: () => this.external }).runtime(member); }
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
