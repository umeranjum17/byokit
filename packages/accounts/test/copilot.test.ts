// GitHub Copilot by device code on a phone, through the BUILT @byokit/accounts portable entry: the device grant
// answers an intermediate GitHub token, and a GET of the catalogue's exchange step turns it into the credential,
// re-minted by that same GET on every refresh. github.com only: an enterprise domain is refused before any store is
// read. A decline keeps nothing and says so in one sentence; a revoked intermediate signs out once. Every answer is
// the recorded one in fixtures/conformance/device-code-rfc8628-typescript.json. No account and no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, deviceFlow, portable, recordStore, route, signInChoices, type EndingStore, type Platform } from '@byokit/accounts';
import { mockDevice } from '@byokit/accounts/testing';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/device-code-rfc8628-typescript.json', import.meta.url), 'utf8')) as {
  grantType: string; providers: { copilot: { pi: string; authorization: string; token: string; exchange: string; clientId: string; scope: string } } };
// The tokens the stand-in hands out; a leak anywhere a person or an app reads is unmistakable.
const GITHUB_TOKEN = 'FIXTURE-GITHUB-TOKEN';
const COPILOT_TOKEN = 'FIXTURE-COPILOT-TOKEN';
const stored = () => {
  let data: any = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  return { store, index: () => (store as EndingStore).index() };
};

test("Copilot's device row is the fixture's exchange contract, and the picker lists it", () => {
  const spec = fixture.providers.copilot;
  const flow = deviceFlow(spec.pi)!;
  assert.deepEqual({ authorization: flow.authorization, token: flow.token, exchange: flow.exchange, clientId: flow.clientId, scope: flow.scope },
    { authorization: spec.authorization, token: spec.token, exchange: spec.exchange, clientId: spec.clientId, scope: spec.scope });
  assert.deepEqual(signInChoices().map((p) => p.key), ['grok', 'copilot', 'kimi']);
  // The route a phone signs in on is ready; a browser signs in through the app's host side.
  assert.equal(route('github-copilot:code', { platform: 'rn' }).readiness, 'ready');
  assert.equal(route('github-copilot:code', { platform: 'browser' }).readiness, 'needs_host');
});

test("login(member, 'copilot') shows the code and the github.com device page; approval signs in, and keepFresh re-mints from the stored GitHub token", async () => {
  const m = await mockDevice({ dialect: 'copilot' });
  const { store, index } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', store: () => store }, portable as Platform | undefined);
  try {
    // The provider entry point, exactly as the README names it: a code and the github.com device page.
    const shown = (await accounts.login(1, 'copilot'))!;
    assert.deepEqual([shown.state, shown.via, shown.code, shown.url], ['waiting', 'code', 'FIXTURE-COPILOT-CODE', 'https://github.com/login/device']);

    // They approve it on GitHub's page; the exchange turns the intermediate GitHub token into the credential.
    assert.equal(m.approve(shown.code!), true, 'approving the code');
    await accounts.finished(1, 'copilot');
    assert.equal((await accounts.status(1, 'copilot')).state, 'ready', 'ready');
    const [row] = await accounts.list(1);
    assert.deepEqual([row.provider, row.billing, row.state], ['copilot', 'subscription', 'ready'], 'Copilot ready in list');
    // The kept credential is the exchanged token with the intermediate as its refresh; the grant's extra fields stay out.
    assert.deepEqual(await store.read('github-copilot'),
      { type: 'oauth', access: COPILOT_TOKEN, refresh: GITHUB_TOKEN, expires: 4102444800 * 1000 }, 'the exchanged credential, nothing else');
    // Neither token appears where a person or an app reads.
    const pub = JSON.stringify([await accounts.list(1), await accounts.status(1, 'copilot'), await index()]);
    assert.ok(!pub.includes(GITHUB_TOKEN), 'no intermediate GitHub token in list/status/index');
    assert.ok(!pub.includes(COPILOT_TOKEN), 'no Copilot token in list/status/index');

    // keepFresh re-mints the credential from the stored intermediate with the same GET, never a GitHub rotation.
    const exchanges = () => m.state.requests.filter((r) => r.path === '/copilot_internal/v2/token');
    await store.modify('github-copilot', async (c: any) => ({ ...c, access: 'STALE', expires: 0 }));
    const minted = exchanges().length;
    await accounts.keepFresh([1]);
    assert.equal((await accounts.status(1, 'copilot')).state, 'ready', 'still ready after the re-mint');
    assert.equal(exchanges().length, minted + 1, 'one re-mint GET');
    assert.equal(exchanges().at(-1)?.method, 'GET', 'the exchange is a GET');
    assert.equal((await store.read('github-copilot') as any).access, COPILOT_TOKEN, 're-minted from the stored intermediate');
    assert.ok(!m.state.requests.some((r) => r.body.includes('grant_type=refresh_token')), 'never a GitHub token rotation');

    // A revoked intermediate signs out once: onExpired fires a single time per grant, for 401 and for 403.
    const expired: unknown[] = [];
    accounts.onExpired = (member, key) => { expired.push([member, key]); };
    for (const status of [401, 403]) {
      const again = (await accounts.login(1, 'copilot'))!;
      assert.equal(m.approve(again.code!), true, `${status}: approving the code`);
      await accounts.finished(1, 'copilot');
      m.state.refuse = true;
      m.state.refuseStatus = status;
      await store.modify('github-copilot', async (c: any) => ({ ...c, expires: 0 }));
      await accounts.keepFresh([1]);
      await accounts.keepFresh([1]);
      m.state.refuse = false;
    }
    assert.deepEqual(expired, [[1, 'copilot'], [1, 'copilot']], 'said once per revoked grant');
    assert.equal((await accounts.status(1, 'copilot')).state, 'needs_again', 'signed out');
    assert.equal(await accounts.signedIn(1, 'copilot'), false, 'nothing left');

    // Signing out removes it.
    const last = (await accounts.login(1, 'copilot'))!;
    assert.equal(m.approve(last.code!), true, 'approving the code');
    await accounts.finished(1, 'copilot');
    await accounts.logout(1, 'copilot');
    assert.equal(await accounts.signedIn(1, 'copilot'), false, 'signed out');
    assert.deepEqual(await accounts.list(1), [], 'removed');
  } finally {
    accounts.stop();
    await m.close();
  }
});

test('a declined code keeps nothing and says so in one sentence; an enterprise domain is refused before any store read', async () => {
  const m = await mockDevice({ dialect: 'copilot' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', store: () => store }, portable as Platform | undefined);
  try {
    const shown = (await accounts.login(1, 'copilot'))!;
    assert.equal(m.approve(shown.code!, true), true, 'declined on the page');
    await accounts.finished(1, 'copilot');
    assert.equal(await accounts.signedIn(1, 'copilot'), false, 'decline: nothing kept');
    assert.deepEqual(await accounts.list(1), [], 'decline: no account');
    const view = accounts.view(1, 'copilot')!;
    assert.equal(view.state, 'failed', 'decline: failed');
    // One plain sentence, with no token, address or jargon in it.
    assert.ok(view.error && view.error.length > 0 && !/token|http|error\(|localhost|fixture/i.test(view.error), 'decline: one plain sentence');

    // A GitHub Enterprise domain is refused on a phone before any store is read, never fallen back to github.com.
    let touched = 0;
    const counting = new Proxy(store, { get: (target, p) =>
      typeof (target as any)[p] === 'function' ? (...args: any[]) => { touched++; return (target as any)[p](...args); } : (target as any)[p] });
    const phones = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', store: () => counting }, portable as Platform | undefined);
    try {
      for (const enterpriseDomain of ['company.ghe.com', 'not a domain!!']) {
        await assert.rejects(phones.login(2, 'copilot', { enterpriseDomain }), /not supported on this device yet/, `${enterpriseDomain}: refused`);
        assert.equal(touched, 0, `${enterpriseDomain}: no store read`);
      }
    } finally {
      phones.stop();
    }
  } finally {
    accounts.stop();
    await m.close();
  }
});
