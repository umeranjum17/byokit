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
import { Accounts, memoryStore, type Api, type Context, type Model } from '@byokit/accounts';
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
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit journey' });
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
    // The Code Assist project the sign-in discovered is non-secret account metadata, beside the email and plan: it
    // never enters the credential, and no token is inside it.
    const metadata = (await store.index()).accounts?.[rows[0].id];
    assert.equal(metadata?.project, 'recorded-project', 'the eligible project is kept as account metadata');
    assert.ok(metadata && !/recorded-(access|refresh)/.test(JSON.stringify(metadata)), 'the project metadata holds no token');
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

test('provisioning: no project yet goes through onboardUser and keeps the provisioned project', async () => {
  const { google, store, accounts } = await journey();
  google.state.provision = true;
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    const [account] = await accounts.list(OWNER);
    assert.equal((await store.index()).accounts?.[account.id]?.project, 'recorded-project', 'the provisioned project is kept');
    const calls = google.state.requests.map((r) => `${r.method} ${r.path}`);
    assert.ok(calls.includes('POST /v1internal:onboardUser'), 'onboardUser provisions the default tier');
    assert.ok(calls.includes('GET /v1internal/operations/recorded-onboard'), 'the operation is polled until done');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('ineligible: an individual account with no Code Assist tier is refused and keeps nothing', async () => {
  const { google, store, accounts } = await journey();
  google.state.ineligible = true;
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    assert.equal(accounts.view(OWNER, id)?.state, 'failed', 'the sign-in ends');
    assert.equal(accounts.view(OWNER, id)?.why, 'notIncluded', 'a typed refusal, not a generic failure');
    assert.equal(await store.read('google-gemini-cli'), undefined, 'no credential is kept');
    assert.deepEqual(await accounts.list(OWNER), [], 'no account row is kept');
    assert.deepEqual((await store.index()).accounts ?? {}, {}, 'no account metadata is kept');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('an ineligible tier beside an existing project keeps the project and signs in', async () => {
  const { google, store } = await journey();
  const realFetch = globalThis.fetch;
  // Real accounts can carry an ineligible free tier beside the paid tier or project they already have: the project is
  // taken first, and only an account with no project and no allowed tier is refused. The stand-in answers the rest.
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit journey',
    fetch: async (input, init) => String(input instanceof Request ? input.url : input).includes('/v1internal:loadCodeAssist')
      ? Response.json({ cloudaicompanionProject: 'recorded-project', ineligibleTiers: [{ tierId: 'free-tier', reasonMessage: 'This account is not eligible for Code Assist.' }] })
      : realFetch(input, init) });
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    const [row] = await accounts.list(OWNER);
    assert.equal(row?.state, 'ready', 'the sign-in completes');
    assert.equal((await store.index()).accounts?.[row.id]?.project, 'recorded-project', 'the existing project is kept');
    assert.ok(!google.state.requests.some((r) => r.path === '/v1internal:onboardUser'), 'no onboarding when a project already exists');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('an app-set callbackPort moves the listener and the redirect address together', async () => {
  const google = await mockGoogle();
  const store = memoryStore();
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit journey', callbackPort: 19085 });
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
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit journey',
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
    await assert.rejects(accounts.add(OWNER, 'google-gemini-cli', { via: 'cli' }), /Google uses a browser or a pasted address/);
    await assert.rejects(accounts.add(OWNER, 'google-gemini-cli:code'), /Google uses a browser or a pasted address/);
    await assert.rejects(accounts.add(OWNER, 'google-gemini-cli:setup_token'), /Google uses a browser or a pasted address/);
    await assert.rejects(accounts.add(OWNER, 'anthropic:browser'), /Choose a key route to add an account/);
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('an app that sets authBase still sends Google’s sign-in to Google’s own hosts; tokens never go to authBase', async () => {
  const sent: string[] = [];
  const google = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    sent.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600 });
    if (url.startsWith('https://www.googleapis.com/oauth2/v1/userinfo')) return Response.json({ email: 'umer@example.com' });
    if (url.startsWith('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'recorded-project' });
    if (url === 'https://oauth2.googleapis.com/revoke') return new Response('', { status: 200 });
    return new Response('not stubbed', { status: 599 });
  }) as typeof fetch;
  const accounts = new Accounts({ store: () => memoryStore(), authBase: 'http://127.0.0.1:9', app: 'byokit journey', fetch: google });
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    const url = new URL(signIn!.url!);
    assert.equal(url.origin, 'https://accounts.google.com');
    accounts.paste(OWNER, id, `http://127.0.0.1:8085/oauth2callback?code=c1&state=${url.searchParams.get('state')}`);
    await accounts.finished(OWNER, id);
    assert.equal((await accounts.list(OWNER))[0]?.email, 'umer@example.com');
    const auth = await (await accounts.runtime(OWNER)).getAuth('google-gemini-cli', { minOAuthValidityMs: 10 ** 9 });
    assert.equal(auth?.auth.apiKey, 'a1');
    // Sign-out revokes at Google's own host too, never at authBase.
    await accounts.logout(OWNER, 'google-gemini-cli');
    assert.equal(sent.at(-1), 'https://oauth2.googleapis.com/revoke');
    // The Code Assist project discovery also goes to Google's own host, never authBase.
    assert.deepEqual(sent.map((u) => new URL(u).origin), ['https://oauth2.googleapis.com', 'https://www.googleapis.com', 'https://cloudcode-pa.googleapis.com', 'https://oauth2.googleapis.com', 'https://oauth2.googleapis.com']);
    assert.ok(!sent.some((u) => u.startsWith('http://127.0.0.1:9')), 'authBase never receives a Google call');
  } finally {
    accounts.stop();
  }
});

test('browser: a redirect that arrives after the fallback window still completes the sign-in', async () => {
  const google = await mockGoogle();
  const accounts = new Accounts({ store: () => memoryStore(), googleBase: google.base, app: 'byokit journey', redirectMs: 100 });
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    const address = await callbackAddress(signIn!.url!);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(accounts.view(OWNER, id)?.via, 'code', 'the fallback offers a pasted address too');
    assert.equal((await fetch(address)).status, 200, 'the same listener still answers the same sign-in');
    await accounts.finished(OWNER, id);
    assert.equal((await accounts.list(OWNER))[0]?.state, 'ready');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('browser: a second Google sign-in on a port this process holds waits and offers paste at once', async () => {
  const { google, accounts } = await journey();
  try {
    const first = await accounts.add(OWNER, 'google-gemini-cli:browser');
    const second = await accounts.add(2, 'google-gemini-cli:browser');
    // The redirectMs fallback is minutes away: the pasted-address view is offered as soon as the held port is found.
    assert.equal(accounts.view(2, second.id)?.via, 'code', 'the held port offers the pasted address at once, not after the timer');
    const address = await callbackAddress(second.signIn!.url!);
    accounts.paste(2, second.id, address);
    await accounts.finished(2, second.id);
    assert.equal((await accounts.list(2))[0]?.state, 'ready');
    accounts.cancel(OWNER, first.id);
    await accounts.finished(OWNER, first.id);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('paste: a pasted error return is a declined sign-in that keeps nothing', async () => {
  const { google, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    const state = new URL(await callbackAddress(signIn!.url!)).searchParams.get('state');
    accounts.paste(OWNER, id, `http://127.0.0.1:8085/oauth2callback?error=access_denied&state=${state}`);
    await accounts.finished(OWNER, id);
    assert.equal(accounts.view(OWNER, id)?.why, 'declined');
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('paste: an error return for another sign-in is out of date, not declined', async () => {
  const { google, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    await callbackAddress(signIn!.url!);
    accounts.paste(OWNER, id, 'http://127.0.0.1:8085/oauth2callback?error=access_denied&state=some-other-sign-in');
    await accounts.finished(OWNER, id);
    assert.notEqual(accounts.view(OWNER, id)?.why, 'declined');
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('paste: a late paste after the browser redirect window still completes', async () => {
  const google = await mockGoogle();
  const accounts = new Accounts({ store: () => memoryStore(), googleBase: google.base, app: 'byokit journey', redirectMs: 100 });
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
    const address = await callbackAddress(signIn!.url!);
    await new Promise((r) => setTimeout(r, 300));
    accounts.paste(OWNER, id, address);
    await accounts.finished(OWNER, id);
    assert.equal((await accounts.list(OWNER))[0]?.state, 'ready');
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

test('a busy :8085 offers paste at once and serves the browser return once the port frees', async () => {
  const { google, accounts } = await journey();
  const blocker = createServer((_q, r) => r.end('busy'));
  await new Promise<void>((r) => blocker.listen(8085, '127.0.0.1', r));
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    assert.equal(accounts.view(OWNER, id)?.via, 'code', 'a port held by another app offers the pasted address at once');
    const address = await callbackAddress(signIn!.url!);
    // The wait for the port is the same OS lock used across processes: once it frees, the browser return completes it.
    await new Promise<void>((r) => blocker.close(() => r()));
    let served: Response | undefined;
    for (let i = 0; i < 60 && !served; i++) { try { served = await fetch(address); } catch { await new Promise((r) => setTimeout(r, 50)); } }
    assert.equal(served?.status, 200, 'the listener answers the browser return once the port is free');
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

test('logout revokes the stored refresh token at Google’s stand-in, then deletes it locally', async () => {
  const { google, store, accounts } = await journey();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    await fetch(await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    // A refresh rotates the stored grant, so sign-out revokes the token that is actually stored.
    await (await accounts.runtime(OWNER)).getAuth('google-gemini-cli', { minOAuthValidityMs: 10 ** 9 });
    await accounts.logout(OWNER, 'google-gemini-cli');
    const revokes = google.state.requests.filter((r) => r.path === '/revoke');
    assert.equal(revokes.length, 1, 'exactly one revoke request reaches Google');
    assert.ok(revokes[0].body.includes('token=rotated-refresh'), 'the stored refresh token is the one revoked');
    assert.deepEqual(google.state.revoked, ['rotated-refresh']);
    assert.equal(google.state.live.has('rotated-refresh'), false, 'Google no longer honours the revoked grant');
    assert.equal(await store.read('google-gemini-cli'), undefined, 'the local copy is deleted');
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('a refused Google revoke still deletes locally and reports honestly, without the token', async () => {
  const { google, store, accounts } = await journey();
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const logged: string[] = [];
  console.log = console.warn = console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:browser');
    await fetch(await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    google.state.refuseRevoke = true;
    const failure = await accounts.logout(OWNER, 'google-gemini-cli').then(() => undefined, (e: Error) => e);
    assert.match(failure?.message ?? '', /Google sign-out failed \(400\)/);
    assert.equal(await store.read('google-gemini-cli'), undefined, 'deleted here whatever Google answered');
    assert.equal(await accounts.signedIn(OWNER, 'google-gemini-cli'), false);
    const revoke = google.state.requests.find((r) => r.path === '/revoke');
    assert.ok(revoke?.body.includes('token=recorded-refresh'), 'Google was asked to revoke the stored refresh token');
    for (const leak of [failure?.message ?? '', ...logged])
      assert.ok(!/recorded-(access|refresh)|rotated-(access|refresh)/.test(leak), 'the token never reaches a thrown message or a log');
  } finally {
    accounts.stop();
    Object.assign(console, originalConsole);
    await google.close();
  }
});

// The Code Assist respond adapter through the BUILT @byokit/accounts: a streamed answer, the 403 tier refusal, and a
// 401 that one refresh clears (a second 401 reports signed out). The project id stands in for WP6-S4's stored metadata.
const streamFixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/pi-streams.json', import.meta.url), 'utf8')) as {
  families: { 'code-assist': { events: unknown[] } };
  codeAssistRefusals: { tier: unknown; unauthorized: unknown };
};
const respondModel = (): Model<Api> => ({ id: 'gemini-2.5-pro', name: 'Gemini', provider: 'google-gemini-cli',
  api: 'google-generative-ai', baseUrl: 'https://cloudcode-pa.googleapis.com', reasoning: false, input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 });
const context: Context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] };
const TOKEN_CANARY = /recorded-(access|refresh)|rotated-(access|refresh)/;
/** Sign in a Google account; the sign-in discovers and stores the Code Assist project the adapter answers with. */
const respondJourney = async () => {
  const google = await mockGoogle();
  const store = memoryStore();
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit respond' });
  const { id, signIn } = await accounts.add(OWNER, 'google-gemini-cli:paste');
  accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
  await accounts.finished(OWNER, id);
  const [row] = await accounts.list(OWNER);
  return { google, store, accounts, id: row.id };
};
const refreshes = (google: Awaited<ReturnType<typeof mockGoogle>>) =>
  google.state.requests.filter((r) => r.path === '/token' && r.body.includes('grant_type=refresh_token')).length;

test('respond: a Code Assist account streams an answer in order with usage, from the stored project', async () => {
  const { google, accounts, id } = await respondJourney();
  try {
    assert.deepEqual(google.answers.codeAssistStream, streamFixture.families['code-assist'].events, 'the SSE answer is the recorded one');
    const deltas: string[] = [];
    const result = await accounts.respond(OWNER, { account: id, model: respondModel(), context, onText: (d) => { deltas.push(d); } });
    assert.equal(result.stopReason, 'stop');
    assert.equal(result.content.filter((c) => c.type === 'text').map((c: any) => c.text).join(''), 'Hello world');
    assert.deepEqual(deltas, ['Hello', ' world'], 'the answer arrives in order');
    assert.deepEqual([result.usage.input, result.usage.output, result.usage.totalTokens], [3, 2, 5]);
    const sent = google.state.requests.find((r) => r.path === '/v1internal:streamGenerateContent')!;
    assert.equal(JSON.parse(sent.body).project, 'recorded-project', 'the stored project is carried');
    assert.equal(google.state.requests.filter((r) => r.path === '/v1internal:streamGenerateContent').length, 1, 'no refresh was needed');
    // Auto picks it because its billing is subscription; an API-billed account would be excluded by the same rule.
    const choice = await accounts.pick(OWNER, { account: 'auto', provider: 'google-gemini-cli' });
    assert.ok(choice.ok && choice.account.id === id);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('respond: each delta reaches onText as its frame lands (LF and CRLF), before the answer ends', async () => {
  for (const crlf of [false, true]) {
    const { google, accounts, id } = await respondJourney();
    try {
      google.state.frameDelayMs = 30;
      google.state.crlf = crlf;
      const deltas: string[] = [];
      let resolved = false, firstBeforeEnd = false;
      await accounts.respond(OWNER, { account: id, model: respondModel(), context,
        onText: (d) => { if (!deltas.length) firstBeforeEnd = !resolved; deltas.push(d); } }).then(() => { resolved = true; });
      assert.deepEqual(deltas, ['Hello', ' world'], `crlf=${crlf}`);
      assert.ok(firstBeforeEnd, `the first delta arrives before the answer ends, not buffered (crlf=${crlf})`);
    } finally {
      accounts.stop();
      await google.close();
    }
  }
});

test('respond: a 403 tier refusal is the typed not_included error, without the token', async () => {
  const { google, accounts, id } = await respondJourney();
  try {
    assert.deepEqual(google.answers.tierRefusal, streamFixture.codeAssistRefusals.tier);
    google.state.tierRefusal = true;
    const failure = await accounts.respond(OWNER, { account: id, model: respondModel(), context }).then(() => undefined, (e: any) => e);
    assert.equal(failure?.kind, 'not_included', 'a tier refusal is a typed error, not a generic one');
    assert.ok(!TOKEN_CANARY.test(failure?.message ?? ''), 'the token is absent from the error');
    assert.equal((await accounts.status(OWNER, id)).state, 'not_included');
  } finally {
    accounts.stop();
    await google.close();
  }
});

// The Antigravity client runs the same journey as Gemini Code Assist on its own client data: the loopback return is on
// :51121 /oauth-callback, the project is discovered the same way, and the identity rule (same person replaces, a new
// person adds) and the refusal rule (nothing kept) hold. Offline, against the same stand-in.
const antigravity = async () => {
  const google = await mockGoogle({ client: 'google-antigravity' });
  const store = memoryStore();
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit journey' });
  return { google, store, accounts };
};
/** Answer userinfo with another identity, so a second sign-in is a different person on the same provider. */
const emailing = (email: () => string) => {
  const realFetch = globalThis.fetch;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    return url.includes('/oauth2/v1/userinfo') ? Response.json({ email: email(), verified_email: true }) : realFetch(input, init);
  }) as typeof fetch;
};

test('antigravity browser sign-in: Google’s page, the return to :51121, list() ready with the project', async () => {
  const { google, store, accounts } = await antigravity();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-antigravity:browser');
    assert.equal(signIn?.state, 'waiting');
    const url = new URL(signIn!.url!);
    assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:51121/oauth-callback', 'the client’s own loopback port and path');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    const address = await callbackAddress(signIn!.url!);
    assert.match(address, /^http:\/\/127\.0\.0\.1:51121\/oauth-callback\?/);
    assert.equal((await fetch(address)).status, 200, 'the app’s listener on the Antigravity port answers');
    await accounts.finished(OWNER, id);
    const rows = await accounts.list(OWNER);
    assert.deepEqual([rows.length, rows[0].provider, rows[0].state, rows[0].email], [1, 'google-antigravity', 'ready', 'umer@example.com']);
    const metadata = (await store.index()).accounts?.[rows[0].id];
    assert.equal(metadata?.project, 'recorded-project', 'the eligible project is kept as account metadata');
    assert.ok(metadata && !/recorded-(access|refresh)/.test(JSON.stringify(metadata)), 'the project metadata holds no token');
    // The canary: no access or refresh token reaches list, status or the stored index.
    const status = await accounts.status(OWNER, 'google-antigravity');
    const index = JSON.stringify(await store.index());
    for (const canary of ['recorded-access', 'recorded-refresh']) {
      assert.ok(!JSON.stringify([rows, status]).includes(canary), `${canary} is absent from list and status`);
      assert.ok(!index.includes(canary), `${canary} is absent from the stored index`);
    }
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('respond: an Antigravity account answers from its own Code Assist host without a googleBase', async () => {
  const { google, store, accounts } = await antigravity();
  const { id, signIn } = await accounts.add(OWNER, 'google-antigravity:paste');
  accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
  await accounts.finished(OWNER, id);
  const [row] = await accounts.list(OWNER);
  accounts.stop();
  const sent: string[] = [];
  const toStandIn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes(':streamGenerateContent')) sent.push(url);
    return fetch(url.replace(/^https:\/\/[^/]+/, google.base), init);
  }) as typeof fetch;
  const answering = new Accounts({ store: () => store, fetch: toStandIn, app: 'byokit respond' });
  try {
    const result = await answering.respond(OWNER, { account: row.id, model: respondModel(), context });
    assert.equal(result.stopReason, 'stop');
    assert.deepEqual(sent.map((url) => new URL(url).origin + new URL(url).pathname), ['https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent'], 'the Antigravity client’s own host');
  } finally {
    answering.stop();
    await google.close();
  }
});

test('respond: a 401 refreshes the sign-in exactly once, then answers', async () => {
  const { google, accounts, id } = await respondJourney();
  try {
    assert.deepEqual(google.answers.unauthorized, streamFixture.codeAssistRefusals.unauthorized);
    google.state.unauthorized = 1;
    const deltas: string[] = [];
    const result = await accounts.respond(OWNER, { account: id, model: respondModel(), context, onText: (d) => { deltas.push(d); } });
    assert.equal(result.stopReason, 'stop');
    assert.deepEqual(deltas, ['Hello', ' world']);
    assert.equal(refreshes(google), 1, 'exactly one refresh');
    assert.equal(google.state.requests.filter((r) => r.path === '/v1internal:streamGenerateContent').length, 2, 'one refused call, one good one');
    assert.equal((await accounts.list(OWNER))[0].state, 'ready');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('antigravity paste: the same identity replaces the account and a different identity adds a second', async () => {
  const google = await mockGoogle({ client: 'google-antigravity' });
  const store = memoryStore();
  let email = 'umer@example.com';
  const accounts = new Accounts({ store: () => store, googleBase: google.base, app: 'byokit journey', fetch: emailing(() => email) });
  const paste = async () => {
    const { id, signIn } = await accounts.add(OWNER, 'google-antigravity:paste');
    accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    return id;
  };
  try {
    await paste();
    const [firstRow] = await accounts.list(OWNER);
    assert.equal(firstRow.provider, 'google-antigravity', 'the first sign-in adds one account');
    // The same person signs in again: the existing account is replaced, not added.
    await paste();
    const replaced = await accounts.list(OWNER);
    assert.equal(replaced.length, 1, 'the same identity replaces the account');
    assert.equal(replaced[0].id, firstRow.id, 'the account keeps its id');
    // A different person on the same provider is a second account.
    email = 'other@example.com';
    const second = await paste();
    const rows = await accounts.list(OWNER);
    assert.equal(rows.length, 2, 'a different identity adds a second account');
    assert.deepEqual(rows.map((r) => r.email).sort(), ['other@example.com', 'umer@example.com']);
    assert.equal((await store.index()).accounts?.[second]?.project, 'recorded-project', 'the second account keeps its own project');
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('respond: a 401 twice reports the account signed out, after one refresh, without the token', async () => {
  const { google, store, accounts, id } = await respondJourney();
  try {
    google.state.unauthorized = 2;
    const failure = await accounts.respond(OWNER, { account: id, model: respondModel(), context }).then(() => undefined, (e: any) => e);
    assert.equal(failure?.kind, 'signed_out');
    assert.ok(!TOKEN_CANARY.test(failure?.message ?? ''), 'the token is absent from the error');
    assert.equal(refreshes(google), 1, 'a second 401 does not refresh again');
    assert.equal(await store.read('google-gemini-cli'), undefined, 'the sign-in is deleted');
    assert.equal(await accounts.signedIn(OWNER, 'google-gemini-cli'), false);
  } finally {
    accounts.stop();
    await google.close();
  }
});

test('antigravity ineligible: a refused sign-in keeps nothing and its error names no token', async () => {
  const { google, store, accounts } = await antigravity();
  google.state.ineligible = true;
  const originalConsole = { log: console.log, warn: console.warn, error: console.error };
  const logged: string[] = [];
  console.log = console.warn = console.error = (...args) => { logged.push(args.map(String).join(' ')); };
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-antigravity:paste');
    accounts.paste(OWNER, id, await callbackAddress(signIn!.url!));
    await accounts.finished(OWNER, id);
    assert.equal(accounts.view(OWNER, id)?.state, 'failed', 'the sign-in ends');
    assert.equal(accounts.view(OWNER, id)?.why, 'notIncluded', 'a typed refusal, not a generic failure');
    assert.equal(await store.read('google-antigravity'), undefined, 'no credential is kept');
    assert.deepEqual(await accounts.list(OWNER), [], 'no account row is kept');
    assert.deepEqual((await store.index()).accounts ?? {}, {}, 'no account metadata is kept');
    for (const leak of [accounts.view(OWNER, id)?.error ?? '', ...logged])
      assert.ok(!/recorded-(access|refresh)/.test(leak), 'the token never reaches an error or a log');
  } finally {
    accounts.stop();
    Object.assign(console, originalConsole);
    await google.close();
  }
});

test('antigravity paste: a declined error return keeps nothing', async () => {
  const { google, accounts } = await antigravity();
  try {
    const { id, signIn } = await accounts.add(OWNER, 'google-antigravity:paste');
    const state = new URL(await callbackAddress(signIn!.url!)).searchParams.get('state');
    accounts.paste(OWNER, id, `http://127.0.0.1:51121/oauth-callback?error=access_denied&state=${state}`);
    await accounts.finished(OWNER, id);
    assert.equal(accounts.view(OWNER, id)?.why, 'declined');
    assert.deepEqual(await accounts.list(OWNER), []);
  } finally {
    accounts.stop();
    await google.close();
  }
});
