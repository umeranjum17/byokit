// GitHub Copilot by device code on a phone, through the BUILT @byokit/accounts portable entry: the device grant
// answers an intermediate GitHub token, and a GET of the catalogue's exchange step turns it into the credential,
// re-minted by that same GET on every refresh. github.com is the default host; a per-account enterprise domain signs
// in on its own host and stays on the kept credential, so refresh re-mints there too. A decline keeps nothing and says
// so in one sentence; a revoked intermediate signs out once. Every answer is the recorded one in
// fixtures/conformance/device-code-rfc8628-typescript.json. No account and no real network.
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

test('a declined code keeps nothing and says so in one sentence; a malformed domain is refused before any store read', async () => {
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

    // A malformed enterprise domain is refused on a phone before any store is read, never fallen back to github.com.
    let touched = 0;
    const counting = new Proxy(store, { get: (target, p) =>
      typeof (target as any)[p] === 'function' ? (...args: any[]) => { touched++; return (target as any)[p](...args); } : (target as any)[p] });
    const phones = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', store: () => counting }, portable as Platform | undefined);
    try {
      await assert.rejects(phones.login(2, 'copilot', { enterpriseDomain: 'https://user:secret@company.ghe.com/path' }), /without a path or credentials/, 'malformed: refused');
      assert.equal(touched, 0, 'malformed: no store read');
    } finally {
      phones.stop();
    }
  } finally {
    accounts.stop();
    await m.close();
  }
});

/** The enterprise host answers with the fixture's copilot bodies, rendered on that host; every request URL is recorded. */
const GHE = 'company.ghe.com';
function gheStandIn() {
  const requests: string[] = [];
  let polls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    requests.push(url);
    if (url === `https://${GHE}/login/device/code`)
      return Response.json({ device_code: 'FIXTURE-GHE-DEVICE', user_code: 'FIXTURE-GHE-CODE', verification_uri: `https://${GHE}/login/device`, interval: 1, expires_in: 900 });
    if (url === `https://${GHE}/login/oauth/access_token`) {
      polls++;
      return Response.json(polls < 2 ? { error: 'authorization_pending' }
        : { access_token: 'FIXTURE-GITHUB-TOKEN', token_type: 'bearer', scope: 'read:user' });
    }
    if (url === `https://api.${GHE}/copilot_internal/v2/token`) {
      const bearer = String((init?.headers as any)?.authorization ?? '').replace(/^Bearer\s+/i, '');
      if (bearer !== 'FIXTURE-GITHUB-TOKEN') return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ token: 'FIXTURE-COPILOT-TOKEN', expires_at: 4102444800 });
    }
    throw new Error(`Unexpected enterprise request: ${url}`);
  }) as typeof fetch;
  return { requests, restore: () => { globalThis.fetch = realFetch; } };
}

test('an enterprise domain signs in per-account on portable, survives a metadata reload, and refreshes on its own host', { timeout: 30_000 }, async () => {
  const { requests, restore } = gheStandIn();
  const { store } = stored();
  const accounts = new Accounts<any, number>({ offer: ['copilot'], app: 'byokit journey', store: () => store }, portable as Platform | undefined);
  try {
    // The sign-in happens on the enterprise host, never github.com: the code and the enterprise device page.
    const shown = (await accounts.login(1, 'copilot', { enterpriseDomain: GHE }))!;
    assert.deepEqual([shown.state, shown.via, shown.code, shown.url], ['waiting', 'code', 'FIXTURE-GHE-CODE', `https://${GHE}/login/device`]);
    await accounts.finished(1, 'copilot');
    assert.equal((await accounts.status(1, 'copilot')).state, 'ready', 'ready');
    const [row] = await accounts.list(1);
    assert.deepEqual([row.provider, row.billing, row.state], ['copilot', 'subscription', 'ready'], 'Copilot ready in list');
    // The domain stays on the kept credential (the pinned computer engine keeps the same `enterpriseUrl` shape).
    assert.deepEqual(await store.read('github-copilot'),
      { type: 'oauth', access: 'FIXTURE-COPILOT-TOKEN', refresh: 'FIXTURE-GITHUB-TOKEN', expires: 4102444800 * 1000, enterpriseUrl: GHE }, 'domain kept on the credential');
    // Every request went to the enterprise host: device, token, and the exchange on its `api.` sibling.
    assert.deepEqual([...new Set(requests.map((u) => new URL(u).hostname))].sort(), [`api.${GHE}`, GHE], 'enterprise hosts only');
    assert.ok(requests.some((u) => u === `https://api.${GHE}/copilot_internal/v2/token`), 'exchange on the enterprise host');
    // Neither token appears where a person or an app reads.
    const pub = JSON.stringify([await accounts.list(1), await accounts.status(1, 'copilot'), await (store as EndingStore).index()]);
    assert.ok(!pub.includes('FIXTURE-GITHUB-TOKEN'), 'no intermediate GitHub token in list/status/index');
    assert.ok(!pub.includes('FIXTURE-COPILOT-TOKEN'), 'no Copilot token in list/status/index');

    // A metadata reload (a fresh Accounts over the same record) builds its refresh engine from the kept credential:
    // expiring it and running keepFresh re-mints with a GET on the enterprise exchange, never github.com.
    const reloaded = new Accounts<any, number>({ offer: ['copilot'], app: 'byokit journey', store: () => store }, portable as Platform | undefined);
    try {
      const exchanges = () => requests.filter((u) => u === `https://api.${GHE}/copilot_internal/v2/token`);
      await store.modify('github-copilot', async (c: any) => ({ ...c, access: 'STALE', expires: 0 }));
      const minted = exchanges().length;
      await reloaded.keepFresh([1]);
      assert.equal((await reloaded.status(1, 'copilot')).state, 'ready', 'still ready after the re-mint');
      assert.equal(exchanges().length, minted + 1, 'one re-mint GET on the enterprise exchange');
      assert.equal((await store.read('github-copilot') as any).access, 'FIXTURE-COPILOT-TOKEN', 're-minted from the stored intermediate');
      assert.deepEqual((await store.read('github-copilot') as any).enterpriseUrl, GHE, 'domain kept across the re-mint');
      assert.ok(!requests.some((u) => new URL(u).hostname === 'github.com' || new URL(u).hostname === 'api.github.com'), 'never the public host');
    } finally {
      reloaded.stop();
    }
  } finally {
    accounts.stop();
    restore();
  }
});

test('an enterprise account coexists with the github.com account, each refreshing its own credential', async () => {
  const m = await mockDevice({ dialect: 'copilot' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', store: () => store }, portable as Platform | undefined);
  try {
    const shown = (await accounts.login(1, 'copilot'))!;
    assert.equal(m.approve(shown.code!), true, 'approving the github.com code');
    await accounts.finished(1, 'copilot');
    // github.com keeps exactly the exchanged token and the intermediate: no enterprise marker.
    assert.deepEqual(await store.read('github-copilot'),
      { type: 'oauth', access: COPILOT_TOKEN, refresh: GITHUB_TOKEN, expires: 4102444800 * 1000 }, 'github.com credential unchanged');

    const added = await accounts.add(1, 'copilot', { enterpriseDomain: GHE });
    assert.equal(m.approve(added.signIn!.code!), true, 'approving the enterprise code');
    await accounts.finished(1, added.id);
    const dotted = (await store.list()).map((c) => c.providerId).find((id) => id !== 'github-copilot')!;
    assert.equal((await store.read(dotted) as any).enterpriseUrl, GHE, 'enterprise domain on its own account');
    assert.equal((await accounts.status(1, added.id)).state, 'ready', 'enterprise ready');

    // Expiring both re-mints each from its own stored intermediate.
    const exchanges = () => m.state.requests.filter((r) => r.path === '/copilot_internal/v2/token');
    await store.modify('github-copilot', async (c: any) => ({ ...c, access: 'STALE', expires: 0 }));
    await store.modify(dotted, async (c: any) => ({ ...c, access: 'STALE', expires: 0 }));
    const minted = exchanges().length;
    await accounts.keepFresh([1]);
    assert.equal(exchanges().length, minted + 2, 'both accounts re-minted');
    assert.equal((await accounts.status(1, 'copilot')).state, 'ready', 'github.com still ready');
    assert.equal((await accounts.status(1, added.id)).state, 'ready', 'enterprise still ready');
    assert.equal((await store.read(dotted) as any).enterpriseUrl, GHE, 'domain kept after refresh');
  } finally {
    accounts.stop();
    await m.close();
  }
});
