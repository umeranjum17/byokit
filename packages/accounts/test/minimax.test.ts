// The MiniMax user-code stand-in, driven the way the next slice's sign-in will be: import the BUILT
// @byokit/accounts/testing, start mockDevice({ dialect: 'minimax' }) for each region, and drive the device-code and
// token steps over fetch against 127.0.0.1. Every answer is the recorded one in
// fixtures/conformance/minimax-oauth-typescript.json (start, pending, success, error, expired), including the extreme
// case: a wrong PKCE code_verifier gets status 'error' and no token. No account and no real network.
//
// The sign-in itself is then driven end to end through the BUILT @byokit/accounts, on the default (computer) entry and
// on the phone/browser entry (the package's `react-native` condition): add -> approve -> list/status ready -> logout,
// plus decline, expiry and cancel, and the token canary checked over list, status and the stored index.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Accounts, deviceFlow, portable, recordStore, type EndingStore, type Platform } from '@byokit/accounts';
import { mockDevice } from '@byokit/accounts/testing';

type Region = 'global' | 'cn';
type CaseName = 'start' | 'pending' | 'success' | 'error' | 'expired';
type Answer = { status: number; cite: string; body: Record<string, unknown> };
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/minimax-oauth-typescript.json', import.meta.url), 'utf8')) as {
  grantType: string; scope: string; codeChallengeMethod: string;
  regions: Record<Region, { clientId: string }>;
  cases: Record<Region, Record<CaseName, Answer>>;
};
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash('sha256').update(verifier).digest());
const post = (base: string, path: string, form: Record<string, string>) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });

test('minimax user-code stand-in replays the fixture start, pending, success, error and expired answers for both regions', async () => {
  for (const region of ['global', 'cn'] as const) {
    const m = await mockDevice({ dialect: 'minimax', region });
    const at = (what: string) => `${region}: ${what}`;
    try {
      const cases = fixture.cases[region];
      const clientId = fixture.regions[region].clientId;
      const expected = Object.fromEntries(Object.entries(cases).map(([name, c]) => [name, { status: c.status, body: c.body }]));
      assert.deepEqual(m.answers, expected, at('the stand-in replays exactly the fixture cases'));
      const call = (code: string, codeVerifier = verifier) => post(m.base, '/oauth2/token', { grant_type: fixture.grantType, client_id: clientId, user_code: code, code_verifier: codeVerifier });

      const start = await post(m.base, '/oauth2/device/code', { response_type: 'code', client_id: clientId, scope: fixture.scope, code_challenge: challenge, code_challenge_method: fixture.codeChallengeMethod, state: 'st-1' });
      assert.equal(start.status, cases.start.status, at('start status'));
      const startBody = await start.json() as { user_code: string; verification_uri: string; expired_in: number };
      assert.deepEqual(startBody, cases.start.body, at('start: user_code, verification_uri and an absolute expired_in'));
      assert.ok(startBody.expired_in > 10 ** 12, at('expired_in is an absolute epoch-ms time, as the engine reads it'));

      // The extreme case: a wrong PKCE code_verifier gets status 'error' and no token.
      const wrong = await call(startBody.user_code, 'not-the-verifier');
      assert.equal(wrong.status, cases.error.status, at('error status'));
      const wrongBody = await wrong.json() as { status?: string; access_token?: string };
      assert.deepEqual(wrongBody, cases.error.body, at('error: a wrong code_verifier'));
      assert.equal(wrongBody.status, 'error', at('a wrong code_verifier is an error'));
      assert.equal(wrongBody.access_token, undefined, at('a wrong code_verifier gets no token'));

      // Before approval the code is pending; approving it answers the recorded success token.
      const pending = await call(startBody.user_code);
      assert.equal(pending.status, cases.pending.status, at('pending status'));
      assert.deepEqual(await pending.json(), cases.pending.body, at('pending: the code is not yet approved'));
      assert.equal(m.approve(startBody.user_code), true, at('approving the code'));
      const success = await call(startBody.user_code);
      assert.equal(success.status, cases.success.status, at('success status'));
      const successBody = await success.json() as { access_token?: string };
      assert.deepEqual(successBody, cases.success.body, at('success: a token'));
      assert.ok(successBody.access_token, at('the success answer carries a token'));

      // An expired user code answers the provider's error envelope, with no token.
      m.state.expire = true;
      const expired = await call(startBody.user_code);
      assert.equal(expired.status, cases.expired.status, at('expired status'));
      const expiredBody = await expired.json() as { access_token?: string };
      assert.deepEqual(expiredBody, cases.expired.body, at('expired: no token'));
      assert.equal(expiredBody.access_token, undefined, at('an expired code gets no token'));
    } finally {
      await m.close();
    }
  }
});

// The token the stand-in hands out; a leak anywhere a person or an app reads is unmistakable.
const CANARY = 'recorded-access';
const ROUTES = [['minimax:code', 'global'], ['minimax:code:cn', 'cn']] as const;
const stored = () => {
  let data: any = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  return { store, index: () => (store as EndingStore).index() };
};

test('a person signs in to their MiniMax plan by user code through the built kit, on a computer and in portable Accounts', async () => {
  // Both regions share one client: `:cn` picks the China host. Data-only, so a route change is one place.
  assert.equal(deviceFlow('minimax', 'cn')!.authorization, 'https://account.minimaxi.com/oauth2/device/code');
  assert.equal(deviceFlow('minimax')!.authorization, 'https://account.minimax.io/oauth2/device/code');
  for (const [key, region] of ROUTES) {
    for (const platform of [undefined, portable] as const) {
      const where = platform ? 'portable' : 'computer';
      const m = await mockDevice({ dialect: 'minimax', region });
      const { store, index } = stored();
      const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, platform as Platform | undefined);
      const at = (what: string) => `${where} ${key}: ${what}`;
      try {
        // add -> the code shows and the MiniMax page opens on the region's own host.
        const { id } = await accounts.add(1, key);
        const shown = accounts.view(1, id)!;
        assert.deepEqual([shown.state, shown.via], ['waiting', 'code'], at('the code and page to show'));
        assert.equal(shown.code, 'FIXTURE-MINIMAX-CODE', at('the code'));
        assert.equal(shown.url, region === 'cn' ? 'https://account.minimaxi.com/activate' : 'https://account.minimax.io/activate', at('the region host'));

        // They approve it on MiniMax's page; the app notices the sign-in finished by itself.
        assert.equal(m.approve(shown.code!), true, at('approving the code'));
        await accounts.finished(1, id);
        assert.equal((await accounts.status(1, id)).state, 'ready', at('ready'));
        const [row] = await accounts.list(1);
        assert.deepEqual([row.provider, row.billing, row.state], ['minimax', 'subscription', 'ready'], at('a ready subscription account'));
        // The token is absent from list, status and the stored index.
        assert.ok(!JSON.stringify([await accounts.list(1), await accounts.status(1, id), await index()]).includes(CANARY), at('no token in list/status/index'));

        // Signing out removes it.
        await accounts.logout(1, id);
        assert.equal(await accounts.signedIn(1, id), false, at('signed out'));
        assert.deepEqual(await accounts.list(1), [], at('removed'));
      } finally {
        accounts.stop();
        await m.close();
      }
    }
  }
});

test("the provider entry is login(member, 'minimax'); a decline, an expiry or a cancel mid-poll keeps nothing and shows one plain sentence", async () => {
  for (const what of ['decline', 'expiry', 'cancel'] as const) {
    const m = await mockDevice({ dialect: 'minimax' });
    const { store } = stored();
    const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
    try {
      // The provider entry point, exactly as the README names it.
      const shown = (await accounts.login(1, 'minimax'))!;
      assert.deepEqual([shown.state, shown.via], ['waiting', 'code'], `${what}: the code to show`);
      if (what === 'decline') assert.equal(m.approve(shown.code!, true), true, 'declined on the page');
      else if (what === 'expiry') m.state.expire = true;
      else accounts.cancel(1, 'minimax');
      await accounts.finished(1, 'minimax');

      assert.equal(await accounts.signedIn(1, 'minimax'), false, `${what}: nothing kept`);
      assert.deepEqual(await accounts.list(1), [], `${what}: no account`);
      if (what === 'cancel') {
        // Cancelling forgets the sign-in outright: there is no flow left to show.
        assert.equal(accounts.view(1, 'minimax'), null, 'cancel: the sign-in is forgotten');
        return;
      }
      const view = accounts.view(1, 'minimax')!;
      assert.equal(view.state, 'failed', `${what}: failed`);
      // One plain sentence, with no token, address or jargon in it.
      assert.ok(view.error && view.error.length > 0 && !/token|http|error\(|localhost/i.test(view.error), `${what}: one plain sentence`);
    } finally {
      accounts.stop();
      await m.close();
    }
  }
});

test('signing in again to a MiniMax region replaces that region\'s account; the other region adds one', async () => {
  const m = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  try {
    const signIn = async (key: string) => {
      const { id } = await accounts.add(1, key);
      assert.equal(m.approve(accounts.view(1, id)!.code!), true, `${key}: approving the code`);
      await accounts.finished(1, id);
    };
    const rows = async () => (await accounts.list(1)).map((r) => r.id);
    await signIn('minimax:code');
    const [global] = await rows();
    await signIn('minimax:code');
    assert.deepEqual(await rows(), [global], 'the same region replaces its account');
    await signIn('minimax:code:cn');
    const both = await accounts.list(1);
    assert.equal(both.length, 2, 'the other region adds one');
    assert.ok(both.some((r) => r.id === global), 'the global account is still there');
    assert.deepEqual(both.map((r) => r.state), ['ready', 'ready'], 'two accounts, both ready');
  } finally {
    accounts.stop();
    await m.close();
  }
});

test('a China MiniMax account signs in on the China host after a restart', async () => {
  const m = await mockDevice({ dialect: 'minimax', region: 'cn' });
  const { store } = stored();
  // The requests the app makes go to the real hosts, which are never reached: the stand-in answers them, and the
  // hosts the app asked for are recorded.
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push(`${url.host}${url.pathname}`);
    return real(new URL(url.pathname, m.base), init);
  }) as typeof fetch;
  const open = () => new Accounts<any, number>({ app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  try {
    const first = open();
    const { id } = await first.add(1, 'minimax:code:cn');
    assert.equal(first.view(1, id)!.url, 'https://account.minimaxi.com/activate', 'the China page to open');
    assert.equal(m.approve(first.view(1, id)!.code!), true, 'approving the code');
    await first.finished(1, id);
    first.stop();

    // A fresh Accounts on the same store knows nothing from this process: the region is the saved account's.
    const restarted = open();
    try {
      sent.length = 0;
      await restarted.login(1, id);
      assert.equal(sent[0], 'account.minimaxi.com/oauth2/device/code', 'the China host after a restart');
    } finally {
      restarted.cancel(1, id);
      await restarted.finished(1, id);
      restarted.stop();
    }
  } finally {
    globalThis.fetch = real;
    await m.close();
  }
});

test('a MiniMax sign-in whose token has run out needs signing in again, and nothing is sent to refresh it', async () => {
  const m = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const open = () => new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  const first = open();
  const { id } = await first.add(1, 'minimax:code');
  assert.equal(m.approve(first.view(1, id)!.code!), true, 'approving the code');
  await first.finished(1, id);
  first.stop();
  const realNow = Date.now;
  try {
    const before = open();
    assert.equal((await before.status(1, id)).state, 'ready', 'ready before the token runs out');
    before.stop();

    // The stand-in's token lasts 3600 seconds.
    Date.now = () => realNow() + 3_601_000;
    const after = open();
    try {
      assert.equal((await after.status(1, id)).state, 'signed_out', 'signed out once the token has run out');
    } finally {
      after.stop();
    }
  } finally {
    Date.now = realNow;
    await m.close();
  }
  assert.ok(m.state.requests.every((r) => new URLSearchParams(r.body).get('grant_type') !== 'refresh_token'), 'no refresh was sent');
});

test('login and then add to the global region leave one MiniMax account', async () => {
  const m = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  try {
    const shown = (await accounts.login(1, 'minimax'))!;
    assert.equal(m.approve(shown.code!), true, 'approving the login code');
    await accounts.finished(1, 'minimax');
    const { id } = await accounts.add(1, 'minimax:code');
    assert.equal(m.approve(accounts.view(1, id)!.code!), true, 'approving the added code');
    await accounts.finished(1, id);
    assert.deepEqual((await accounts.list(1)).map((r) => r.state), ['ready'], 'one ready account');
  } finally {
    accounts.stop();
    await m.close();
  }
});

test('each MiniMax code step carries its own random state', async () => {
  const m = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { id } = await accounts.add(1, 'minimax:code');
      assert.equal(m.approve(accounts.view(1, id)!.code!), true, 'approving the code');
      await accounts.finished(1, id);
    }
    const states = m.state.requests.filter((r) => r.path === '/oauth2/device/code').map((r) => new URLSearchParams(r.body).get('state'));
    assert.equal(states.length, 2, 'one code step per sign-in');
    assert.ok(states.every((state) => state && state.length >= 16), 'a state on every code step');
    assert.notEqual(states[0], states[1], 'a fresh state each time');
  } finally {
    accounts.stop();
    await m.close();
  }
});

test('an expired MiniMax sign-in ends signed out in the instance that signed in, on the next refresh', async () => {
  const m = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  const { id } = await accounts.add(1, 'minimax:code');
  assert.equal(m.approve(accounts.view(1, id)!.code!), true, 'approving the code');
  await accounts.finished(1, id);
  const realNow = Date.now;
  try {
    await accounts.keepFresh([1]);
    assert.equal((await accounts.status(1, id)).state, 'ready', 'ready before the token runs out');
    // The stand-in's token lasts 3600 seconds.
    Date.now = () => realNow() + 3_601_000;
    await accounts.keepFresh([1]);
    assert.equal((await accounts.status(1, id)).state, 'needs_again', 'needs signing in again once the token has run out');
    assert.ok(m.state.requests.every((r) => new URLSearchParams(r.body).get('grant_type') !== 'refresh_token'), 'no refresh was sent');
  } finally {
    Date.now = realNow;
    accounts.stop();
    await m.close();
  }
});
