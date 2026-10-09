// A test author's journey against the built @byokit/accounts/testing Google stand-in: PKCE authorize, the loopback
// callback, code exchange and refresh, userinfo, and the Cloud Code Assist project calls, for both Google clients
// (google-gemini-cli on :8085 and google-antigravity on :51121), over fetch against 127.0.0.1. Every answer is the
// recorded one in fixtures/conformance/google-oauth-typescript.json, and the extremes (a refused refresh and an
// individual account with no Code Assist tier) are driven in the same journey. No account and no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
