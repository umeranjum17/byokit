// A test author's journey against the built @byokit/accounts/testing Google stand-in: PKCE authorize, the loopback
// callback, code exchange and refresh, userinfo, and the Cloud Code Assist project calls, for both Google clients
// (google-gemini-cli on :8085 and google-antigravity on :51121), over fetch against 127.0.0.1. Every answer is the
// recorded one in fixtures/conformance/google-oauth-typescript.json, and the extremes (a refused refresh and an
// individual account with no Code Assist tier) are driven in the same journey. No account and no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { Accounts, memoryStore } from '@byokit/accounts';
import { mockGoogle, type MockGoogleClient } from '@byokit/accounts/testing';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/google-oauth-typescript.json', import.meta.url), 'utf8')) as {
  clients: Record<MockGoogleClient, { metadata: Record<string, string>; callback: { path: string } }>;
  exchange: Record<string, unknown>; rotation: Record<string, unknown>; invalidGrant: Record<string, unknown>;
  userinfoBody: Record<string, unknown>; eligible: Record<string, unknown>;
  provision: { loadCodeAssist: Record<string, unknown>; onboardUser: Record<string, unknown>; operation: Record<string, unknown> }; ineligible: Record<string, unknown>;
};
const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const pkce = () => { const verifier = b64url(randomBytes(32)); return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) }; };
const post = (url: string, form: Record<string, string>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) });
const postJson = (url: string, body: Record<string, unknown>) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

for (const client of Object.keys(fixture.clients) as MockGoogleClient[]) {
  test(`${client}: PKCE authorize, loopback callback, exchange, refresh and Code Assist project answers`, async () => {
    const m = await mockGoogle({ client });
    try {
      // The client facts the kit reuses match the fixture, and every endpoint answers its recorded body.
      assert.deepEqual(m.protocol, fixture.clients[client], 'the client facts match the fixture');
      assert.deepEqual(m.answers.exchange, fixture.exchange);
      assert.deepEqual(m.answers.rotation, fixture.rotation);
      assert.deepEqual(m.answers.eligible, fixture.eligible);
      assert.deepEqual(m.answers.provision, fixture.provision);
      assert.deepEqual(m.answers.ineligible, fixture.ineligible);

      // Authorize with PKCE on Google's page; it returns to the loopback callback with the code and state.
      const { verifier, challenge } = pkce();
      const redirectUri = `${m.base}${fixture.clients[client].callback.path}`;
      const auth = await fetch(m.authorizeUrl({ redirectUri, state: 'st-1', codeChallenge: challenge }), { redirect: 'manual' });
      assert.equal(auth.status, 303);
      assert.deepEqual([m.state.authorize?.access_type, m.state.authorize?.prompt, m.state.authorize?.code_challenge_method], ['offline', 'consent', 'S256']);
      const location = new URL(auth.headers.get('location')!);
      assert.equal(location.searchParams.get('state'), 'st-1');
      const code = location.searchParams.get('code')!;
      assert.equal((await fetch(location)).status, 200, 'the callback on the loopback port answers');
      assert.equal(m.state.callback?.code, code);

      // A wrong PKCE verifier is refused; the right one exchanges for the recorded token and email.
      assert.equal((await post(`${m.base}/token`, { grant_type: 'authorization_code', code, code_verifier: 'wrong', redirect_uri: redirectUri })).status, 400);
      assert.deepEqual(await (await post(`${m.base}/token`, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri })).json(), fixture.exchange);
      assert.deepEqual(await (await fetch(`${m.base}/oauth2/v1/userinfo`, { headers: { authorization: `Bearer ${String(fixture.exchange.access_token)}` } })).json(), fixture.userinfoBody);

      // Code Assist: an existing project, then a provisioning run through onboardUser and its operation poll.
      assert.deepEqual(await (await postJson(`${m.base}/v1internal:loadCodeAssist`, { metadata: fixture.clients[client].metadata })).json(), fixture.eligible);
      m.state.provision = true;
      assert.deepEqual(await (await postJson(`${m.base}/v1internal:loadCodeAssist`, { metadata: fixture.clients[client].metadata })).json(), fixture.provision.loadCodeAssist);
      const operation = await (await postJson(`${m.base}/v1internal:onboardUser`, { tierId: 'free-tier', metadata: fixture.clients[client].metadata })).json() as { name: string };
      assert.deepEqual(operation, fixture.provision.onboardUser);
      assert.deepEqual(await (await fetch(`${m.base}/v1internal/${operation.name}`)).json(), fixture.provision.operation);
      m.state.provision = false;

      // A refresh rotates the grant; after the provider refuses, it answers invalid_grant.
      assert.deepEqual(await (await post(`${m.base}/token`, { grant_type: 'refresh_token', refresh_token: String(fixture.exchange.refresh_token) })).json(), fixture.rotation);
      m.state.refuse = true;
      const refused = await post(`${m.base}/token`, { grant_type: 'refresh_token', refresh_token: String(fixture.rotation.refresh_token) });
      assert.equal(refused.status, 400);
      assert.deepEqual(await refused.json(), fixture.invalidGrant);
      m.state.refuse = false;

      // An individual account with no Code Assist tier answers ineligible.
      m.state.ineligible = true;
      assert.deepEqual(await (await postJson(`${m.base}/v1internal:loadCodeAssist`, { metadata: fixture.clients[client].metadata })).json(), fixture.ineligible);
    } finally {
      await m.close();
    }
  });
}

// A consumer's journey through the BUILT @byokit/accounts on a computer, against the same stand-in: add() opens Google's
// page, the browser returns to the client's loopback port, and list() shows the account ready with the email from the
// sign-in. The same stand-in covers the paste route, the busy-port wait and a cancel. No account and no real network.
const OWNER = 1;
const journey = async () => {
  const google = await mockGoogle();
  const store = memoryStore();
  const accounts = new Accounts({ store: () => store, authBase: google.base, app: 'byokit journey' });
  return { google, store, accounts };
};
/** Drive the stand-in's page and read the redirect address it sends the browser to. */
const callbackAddress = async (authorize: string) => {
  const auth = await fetch(authorize, { redirect: 'manual' });
  assert.equal(auth.status, 303);
  return auth.headers.get('location')!;
};

test('browser sign-in: Google’s page, the return to :8085, list() ready with the email, refresh, logout', async () => {
  const { google, store, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    assert.equal(signIn?.state, 'waiting');
    const url = new URL(signIn!.url!);
    assert.equal(url.pathname, '/o/oauth2/v2/auth', 'the client’s own authorize page, stood in for offline');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:8085/oauth2callback');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const address = await callbackAddress(signIn!.url!);
    assert.match(address, /^http:\/\/127\.0\.0\.1:8085\/oauth2callback\?/);
    assert.equal((await fetch(address)).status, 200, 'the app’s own page on the loopback port');
    await accounts.finished(OWNER, id);
    const rows = await accounts.list(OWNER);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].provider, rows[0].state, rows[0].email], ['google-gemini-cli', 'ready', 'umer@example.com']);
    // The canary: no access or refresh token reaches list, status, the stored index or a status word.
    const status = await accounts.status(OWNER, 'google-gemini-cli');
    const index = JSON.stringify(await store.index());
    for (const canary of ['recorded-access', 'recorded-refresh']) {
      assert.ok(!JSON.stringify([rows, status]).includes(canary), `${canary} is absent from list and status`);
      assert.ok(!index.includes(canary), `${canary} is absent from the stored index`);
    }
    // A refresh rotates the grant in the store; the account is still ready.
    const rt = await accounts.runtime(OWNER);
    const auth = await rt.getAuth('google-gemini-cli', { minOAuthValidityMs: 10 ** 9 });
    assert.equal(auth?.auth.apiKey, 'rotated-access');
    assert.ok(google.state.requests.some((r) => r.body.includes('grant_type=refresh_token')));
    assert.equal((await accounts.list(OWNER))[0].state, 'ready');
    // Logout ends it here and keeps nothing.
    await accounts.logout(OWNER, 'google-gemini-cli');
    assert.equal(await store.read('google-gemini-cli'), undefined);
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('an app-set callbackPort moves the listener and the redirect address together', async () => {
  const google = await mockGoogle();
  const store = memoryStore();
  const accounts = new Accounts({ store: () => store, authBase: google.base, app: 'byokit journey', callbackPort: 19085 });
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    assert.equal(new URL(signIn!.url!).searchParams.get('redirect_uri'), 'http://127.0.0.1:19085/oauth2callback');
    assert.equal((await fetch(await callbackAddress(signIn!.url!))).status, 200, 'the listener on the app port answers');
    await accounts.finished(OWNER, id);
    assert.equal((await accounts.list(OWNER))[0].state, 'ready');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('a failed email lookup still signs in; the account is ready without an email', async () => {
  const google = await mockGoogle();
  const store = memoryStore();
  const realFetch = globalThis.fetch;
  const accounts = new Accounts({ store: () => store, authBase: google.base, app: 'byokit journey',
    fetch: (input, init) => String(input).includes('/oauth2/v1/userinfo') ? Promise.reject(new TypeError('fetch failed')) : realFetch(input, init) });
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    await fetch(await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    const rows = await accounts.list(OWNER);
    assert.deepEqual([rows[0]?.state, rows[0]?.email], ['ready', undefined]);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('paste: an address pasted without its http:// still completes', async () => {
  const { google, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    const address = await callbackAddress(signIn!.url!);
    accounts.paste(OWNER, id, address.replace(/^http:\/\//, ''));
    await accounts.finished(OWNER, id);
    assert.equal((await accounts.list(OWNER))[0]?.state, 'ready');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('a Google sign-in takes only the browser or paste route; other providers keep their key-route message', async () => {
  const { google, accounts } = await journey();
  try {
    await assert.rejects(accounts.add(OWNER, 'google-gemini-cli', { via: 'code' }), /Google uses a browser or a pasted address/);
    await assert.rejects(accounts.add(OWNER, 'anthropic:browser'), /Choose a key route to add an account/);
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('paste: the person pastes the redirect address, and :8085 is never opened', async () => {
  const { google, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    assert.equal(signIn?.state, 'waiting');
    const address = await callbackAddress(signIn!.url!);
    // The paste route never listens: the port is free while the sign-in waits.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(8085, '127.0.0.1', r));
    await new Promise<void>((r) => probe.close(() => r()));
    accounts.paste(OWNER, id, address);
    await accounts.finished(OWNER, id);
    const rows = await accounts.list(OWNER);
    assert.deepEqual([rows[0]?.state, rows[0]?.email], ['ready', 'umer@example.com']);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('a busy :8085 waits for the port and then completes; the OS lock is the port rule', async () => {
  const { google, accounts } = await journey();
  const blocker = createServer((_q, r) => r.end('busy'));
  await new Promise<void>((r) => blocker.listen(8085, '127.0.0.1', r));
  try {
    let returned = false;
    const pending = accounts.add(OWNER, 'google-gemini-cli:browser').then((v) => { returned = true; return v; });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(returned, false, 'a busy callback port makes the sign-in wait, never fail');
    await new Promise<void>((r) => blocker.close(() => r()));
    const { id, signIn } = await pending;
    const address = await callbackAddress(signIn!.url!);
    assert.equal((await fetch(address)).status, 200);
    await accounts.finished(OWNER, id);
    assert.equal((await accounts.list(OWNER))[0].state, 'ready');
  } finally {
    accounts.stop();
    await new Promise<void>((r) => blocker.close(() => r()));
    await google.close();
  }
});

test('cancel closes the listener and keeps nothing', async () => {
  const { google, store, accounts } = await journey();
  try {
    const { id } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    accounts.cancel(OWNER, id);
    await accounts.finished(OWNER, id);
    assert.equal(await store.read('google-gemini-cli'), undefined);
    assert.deepEqual(await accounts.list(OWNER), []);
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(8085, '127.0.0.1', r));
    await new Promise<void>((r) => probe.close(() => r()));
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('a refused refresh reports signed out, and its error never quotes the token', async () => {
  const { google, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    await fetch(await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    google.state.refuse = true;
    const rt = await accounts.runtime(OWNER);
    await assert.rejects(rt.getAuth('google-gemini-cli', { minOAuthValidityMs: 10 ** 9 }),
      (e: Error) => !/recorded-(access|refresh)/.test(e.message));
  } finally {
    accounts.stop();
    await google.close();
  }
});
