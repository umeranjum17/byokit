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
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Accounts, KeyRouteError, ResponseError, computer, deviceFlow, memoryStore, portable, recordStore, resolveModel, route, type AssistantMessageEvent, type Context, type EndingStore, type Model, type Platform } from '@byokit/accounts';
import { withKeys } from '@byokit/accounts/keys';
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

test('with only a China MiniMax account saved, login(member, \'minimax\') signs in the global account and leaves the China one', async () => {
  const cn = await mockDevice({ dialect: 'minimax', region: 'cn' });
  const global = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const sent: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    sent.push(url.host);
    return real(new URL(url.pathname, url.host.endsWith('minimaxi.com') ? cn.base : global.base), init);
  }) as typeof fetch;
  const open = () => new Accounts<any, number>({ app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  try {
    const first = open();
    const { id } = await first.add(1, 'minimax:code:cn');
    assert.equal(cn.approve(first.view(1, id)!.code!), true, 'approving the China code');
    await first.finished(1, id);
    first.stop();

    const accounts = open();
    try {
      sent.length = 0;
      const shown = (await accounts.login(1, 'minimax'))!;
      assert.equal(sent[0], 'account.minimax.io', 'the global host, not the China one');
      assert.equal(global.approve(shown.code!), true, 'approving the global code');
      await accounts.finished(1, 'minimax');
      assert.deepEqual((await accounts.list(1)).map((r) => r.state), ['ready', 'ready'], 'two rows, both ready');
      assert.ok((await accounts.list(1)).some((r) => r.id === id), 'the China account is still there');
    } finally {
      accounts.stop();
    }
  } finally {
    globalThis.fetch = real;
    await cn.close();
    await global.close();
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

test('an expired MiniMax sign-in ends signed out in the instance that signed in, on the next status', async () => {
  const m = await mockDevice({ dialect: 'minimax' });
  const { store } = stored();
  const accounts = new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store }, portable);
  const { id } = await accounts.add(1, 'minimax:code');
  assert.equal(m.approve(accounts.view(1, id)!.code!), true, 'approving the code');
  await accounts.finished(1, id);
  const realNow = Date.now;
  try {
    assert.equal((await accounts.status(1, id)).state, 'ready', 'ready before the token runs out');
    // The stand-in's token lasts 3600 seconds.
    Date.now = () => realNow() + 3_601_000;
    // No keepFresh: a plain status must not trust a cached ready for a sign-in that has no way to refresh itself.
    assert.equal((await accounts.status(1, id)).state, 'signed_out', 'signed out once the token has run out');
    assert.deepEqual((await accounts.list(1)).map((r) => r.state), ['signed_out'], 'list agrees');
    assert.ok(m.state.requests.every((r) => new URLSearchParams(r.body).get('grant_type') !== 'refresh_token'), 'no refresh was sent');
  } finally {
    Date.now = realNow;
    accounts.stop();
    await m.close();
  }
});

test('a phone app signs in to its MiniMax plan with the Web Crypto it passes, and asks it one question', async () => {
  // React Native has getRandomValues (expo-crypto's polyfill) but no crypto.subtle: the app passes SHA-256 itself.
  assert.deepEqual(['minimax:code', 'minimax:code:cn'].map((id) => route(id, { platform: 'rn' }).readiness), ['ready', 'ready'], 'a phone picker offers both MiniMax plan routes');
  assert.equal(route('minimax:code', { platform: 'rn' }).billing, 'subscription', 'the phone route is the plan, not the API key');
  const m = await mockDevice({ dialect: 'minimax' });
  const real = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  const webcrypto = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
  const digests: string[] = [];
  const appCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto),
    subtle: { digest: (algorithm: string, data: BufferSource) => { digests.push(algorithm); return webcrypto.subtle.digest(algorithm, data); } } } as unknown as Crypto;
  const answers: string[] = [];
  const api = createServer(async (req, res) => {
    for await (const _ of req);
    answers.push(String(req.headers.authorization));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([
      { type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'fixture-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello Umer' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ].map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  const { store } = stored();
  const phone = (crypto?: Crypto) => new Accounts<any, number>({ deviceBase: m.base, app: 'byokit journey', offer: ['minimax'], store: () => store, ...(crypto ? { crypto } : {}) }, withKeys(portable));
  let accounts = phone();
  try {
    // Without the app's SHA-256 the sign-in is refused before it starts, naming the cause, and nothing is sent or kept.
    await assert.rejects(accounts.add(1, 'minimax:code'), { message: 'This sign-in needs secure random bytes and SHA-256 on this device: pass crypto to Accounts.' });
    assert.deepEqual([m.state.requests.length, await accounts.list(1)], [0, []], 'nothing sent, nothing kept');
    accounts.stop();

    // With it: the code shows, the person approves it on MiniMax's page, and the account is saved as a plan.
    accounts = phone(appCrypto);
    const { id } = await accounts.add(1, 'minimax:code');
    const shown = accounts.view(1, id)!;
    assert.deepEqual([shown.code, shown.url], ['FIXTURE-MINIMAX-CODE', 'https://account.minimax.io/activate']);
    assert.equal(m.approve(shown.code!), true);
    await accounts.finished(1, id);
    assert.deepEqual(digests, ['SHA-256'], "the PKCE challenge came from the app's own Web Crypto");
    const [row] = await accounts.list(1);
    assert.deepEqual([row.provider, row.billing, row.state], ['minimax', 'subscription', 'ready']);

    // One question, answered through the plan's own bearer.
    const model: Model<'anthropic-messages'> = { id: 'MiniMax-M2.7', name: 'MiniMax', provider: 'minimax', api: 'anthropic-messages',
      baseUrl: `http://127.0.0.1:${(api.address() as AddressInfo).port}`, reasoning: false, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 };
    const deltas: string[] = [];
    const result = await accounts.respond(1, { account: id, model, context: { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }, onText: (d) => deltas.push(d) });
    assert.deepEqual([deltas.join(''), result.stopReason], ['Hello Umer', 'stop']);
    assert.deepEqual(answers, [`Bearer ${CANARY}`], 'one request, with the signed-in plan token as a bearer');
  } finally {
    Object.defineProperty(globalThis, 'crypto', real);
    accounts.stop();
    await new Promise((resolve) => api.close(resolve));
    await m.close();
  }
});

for (const platform of [undefined, portable] as const) test(`MiniMax respond on ${platform ? 'portable' : 'computer'}: saved regions, bearer-only streaming, expiry and account-local 429`, async () => {
  const g = await mockDevice({ dialect: 'minimax', region: 'global' });
  const c = await mockDevice({ dialect: 'minimax', region: 'cn' });
  // The app asks the real hosts; each region's stand-in answers its own host.
  const real = globalThis.fetch;
  globalThis.fetch = ((input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === 'account.minimax.io') return real(new URL(url.pathname + url.search, g.base), init);
    if (url.host === 'account.minimaxi.com') return real(new URL(url.pathname + url.search, c.base), init);
    return real(input as string, init);
  }) as typeof fetch;
  // Each region's own Responses stand-in: the recorded anthropic answer, or a 429 (echoing the bearer) for a limited one.
  const anthropicEvents = [
    { type: 'message_start', message: { id: 'fixture', role: 'assistant', model: 'fixture-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  const fake = async () => {
    const tokens: string[] = [];
    const headers: { authorization?: string; apiKey?: string }[] = [];
    const limited = new Set<string>();
    const server = createServer(async (req, res) => {
      for await (const _ of req);
      const token = String(req.headers.authorization ?? '').replace(/^Bearer /i, '') || String(req.headers['x-api-key'] ?? '');
      tokens.push(token);
      headers.push({ authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] as string | undefined });
      if (limited.has(token)) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
        return res.end(JSON.stringify({ error: { message: `Rate limit reached for ${token}`, type: 'rate_limit_exceeded' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(anthropicEvents.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tokens, headers, limited,
      close: () => new Promise((resolve) => server.close(resolve)) };
  };
  const globalApi = await fake();
  const cnApi = await fake();
  const { store, index } = stored();
  const open = () => new Accounts<any, number>({ app: 'byokit journey', offer: ['minimax'], store: () => store }, platform ? withKeys(platform) : undefined);
  let accounts = open();
  const GLOBAL = 'minimax-global-bearer-canary-001';
  const CN = 'minimax-cn-bearer-canary-002';
  const seen: unknown[] = [];
  try {
    const signIn = async (key: 'minimax:code' | 'minimax:code:cn', standin: { approve: (code: string) => boolean }) => {
      const { id } = await accounts.add(1, key);
      const code = accounts.view(1, id)!.code!;
      assert.equal(standin.approve(code), true, `${key}: approving the code`);
      await accounts.finished(1, id);
      return id;
    };
    const global = await signIn('minimax:code', g);
    const cn = await signIn('minimax:code:cn', c);
    // Distinct bearers, one per region account.
    await store.modify(global, async (c: any) => ({ ...c, access: GLOBAL }));
    await store.modify(cn, async (c: any) => ({ ...c, access: CN }));
    accounts.stop();
    accounts = open(); // Region selection must survive restart, not depend on the sign-in's in-memory region.
    const bases = { minimax: globalApi.base, 'minimax-cn': cnApi.base } as const;
    const model = (provider: 'minimax' | 'minimax-cn'): Model<'anthropic-messages'> => ({ id: 'MiniMax-M2.7', name: 'MiniMax',
      provider, api: 'anthropic-messages', baseUrl: bases[provider], reasoning: false, input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 });
    const context: Context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] };
    const ask = async (account: string, provider: 'minimax' | 'minimax-cn') => {
      const deltas: string[] = [], evts: AssistantMessageEvent[] = [];
      const result = await accounts.respond(1, { account, model: model(provider), context,
        onText: (d) => deltas.push(d), onEvent: (e) => evts.push(e) });
      return { result, deltas, evts };
    };

    // Each region's base receives its own account's bearer, through its own pinned Models path.
    for (const [id, provider, token, api] of [[global, 'minimax', GLOBAL, globalApi], [cn, 'minimax-cn', CN, cnApi]] as const) {
      const { result, deltas, evts } = await ask(id, provider);
      assert.deepEqual(deltas, ['Hello'], `${id}: streamed into onText`);
      assert.equal(result.stopReason, 'stop', `${id}: answered`);
      assert.equal(api.tokens.at(-1), token, `${id}: its own bearer at its own base`);
      assert.ok(api.headers.at(-1)?.authorization === `Bearer ${token}` && api.headers.at(-1)?.apiKey === undefined, 'OAuth token is only a bearer, never an API key');
      seen.push(result, evts);
    }
    assert.ok(!globalApi.tokens.includes(CN) && !cnApi.tokens.includes(GLOBAL), 'neither base saw the other account bearer');

    // A model from the other region is refused before any request; the Grok/Kimi mismatch rule is unchanged.
    const sent = globalApi.tokens.length + cnApi.tokens.length;
    await assert.rejects(accounts.respond(1, { account: global, model: model('minimax-cn'), context }),
      (e: unknown) => e instanceof KeyRouteError && e.code === 'provider');
    assert.equal(globalApi.tokens.length + cnApi.tokens.length, sent, 'a cross-region model never reaches either base');

    // A 429 on the China account rests only it, typed, never retried; the global one still answers.
    cnApi.limited.add(CN);
    const calls = cnApi.tokens.length;
    const over = await accounts.respond(1, { account: cn, model: model('minimax-cn'), context, onEvent: (e) => { seen.push(e); } })
      .then(() => assert.fail('a 429 answered'), (e: unknown) => e);
    assert.ok(over instanceof ResponseError && over.kind === 'rate_limit' && over.status === 429, 'a 429 is typed rate_limit');
    assert.ok(over.until! > Date.now() + 60_000 && over.until! <= Date.now() + 120_000, 'until the retry-after');
    assert.equal(cnApi.tokens.length, calls + 1, 'never retried');
    assert.equal((await accounts.status(1, cn)).state, 'resting', 'only the China account rests');
    assert.equal((await accounts.status(1, global)).state, 'ready', 'the global account does not rest');
    const still = await ask(global, 'minimax');
    assert.equal(still.result.stopReason, 'stop', 'the global account still answers');
    assert.equal(globalApi.tokens.at(-1), GLOBAL, 'its own bearer again');
    seen.push(over, over.message);
    cnApi.limited.clear();

    // MiniMax has no refresh: an expired token ends signed_out with nothing sent, and the account reads needs_again.
    const tokenCalls = () => [...g.state.requests, ...c.state.requests].filter((r) => r.path === '/oauth2/token').length;
    const polls = tokenCalls();
    const modelCalls = globalApi.tokens.length + cnApi.tokens.length;
    await store.modify(global, async (c: any) => ({ ...c, expires: 0 }));
    const expired = await accounts.respond(1, { account: global, model: model('minimax'), context, onEvent: (e) => { seen.push(e); } })
      .then(() => assert.fail('an expired token answered'), (e: unknown) => e);
    assert.ok(expired instanceof ResponseError && expired.kind === 'signed_out', 'expired ends signed_out, typed');
    assert.equal(tokenCalls(), polls, 'no refresh was sent');
    assert.equal(globalApi.tokens.length + cnApi.tokens.length, modelCalls, 'no expired bearer was sent');
    assert.equal((await accounts.status(1, global)).state, 'needs_again', 'the account reads needs_again');
    seen.push(expired, expired.message);

    // Neither bearer appears anywhere a person or an app reads.
    const pub = JSON.stringify([seen, await accounts.list(1), await accounts.status(1, global), await accounts.status(1, cn), await index()]);
    for (const token of [GLOBAL, CN]) assert.ok(!pub.includes(token), `no bearer in answers, events, errors, list, status or the index`);
  } finally {
    globalThis.fetch = real;
    accounts.stop();
    await globalApi.close();
    await cnApi.close();
    await g.close();
    await c.close();
  }
});

test('the computer engine answers an id its catalogue lacks on a known route, from the live list when it has one, else safe defaults', async () => {
  const engine = computer.engine(memoryStore() as never) as unknown as Parameters<typeof resolveModel>[0];
  // Known route, off-catalogue id: MiniMax's Anthropic Messages route lists no limits, so the defaults stand.
  for (const [provider, host] of [['minimax', 'api.minimax.io'], ['minimax-cn', 'api.minimaxi.com']] as const) {
    for (const id of ['MiniMax-M3.1-Flash', 'MiniMax-M3.1-Flash-Preview']) {
      const m = engine.getModel(provider, id)!;
      assert.deepEqual([m.id, m.provider, m.api], [id, provider, 'anthropic-messages']);
      assert.ok(m.baseUrl.includes(host));
      assert.deepEqual([m.contextWindow, m.maxTokens, m.cost.input, m.input, m.reasoning], [128_000, 16_384, 0, ['text', 'image'], true], "the vendor's own models take images: an unknown one keeps that");
    }
    assert.equal(engine.getModel(provider, 'MiniMax-M3')!.contextWindow, 1_000_000, 'a catalogue id is the catalogue row');
  }
  assert.equal(engine.getModel('no-such-provider', 'x'), undefined, 'an unknown route gets nothing');
  assert.equal(engine.getModel('minimax', '  '), undefined);
  // Live list: an OpenAI-compatible route's /models carries the limits and price; a missing id or a failed list keeps the defaults.
  const seen: string[] = [];
  const list = (data: unknown, status = 200): typeof fetch => (async (url: string, init: { headers: { authorization: string } }) => {
    seen.push(`${url} ${init.headers.authorization}`);
    return new Response(JSON.stringify({ data }), { status });
  }) as never;
  const row = { id: 'fresh/model', context_length: 400_000, top_provider: { max_completion_tokens: 64_000 }, pricing: { prompt: '0.000001', completion: '0.000004' }, architecture: { input_modalities: ['text'] } };
  const live = await resolveModel(engine, 'groq', 'fresh/model', { apiKey: 'k', fetch: list([row]) });
  assert.deepEqual(seen, ['https://api.groq.com/openai/v1/models Bearer k']);
  assert.deepEqual([live!.listed, live!.model.contextWindow, live!.model.maxTokens, live!.model.cost.input, live!.model.cost.output], [true, 400_000, 64_000, 1, 4]);
  assert.deepEqual(live!.model.input, ['text'], 'the live list can narrow the capability');
  const lagging = await resolveModel(engine, 'groq', 'fresh/other', { apiKey: 'k', fetch: list([row]) });
  assert.deepEqual([lagging!.listed, lagging!.model.id, lagging!.model.contextWindow], [false, 'fresh/other', 128_000], 'warn, never block');
  assert.equal((await resolveModel(engine, 'groq', 'fresh/model', { apiKey: 'k', fetch: list([row], 500) }))!.listed, false);
  assert.equal(await resolveModel(engine, 'no-such-provider', 'x', { apiKey: 'k' }), undefined);
});
