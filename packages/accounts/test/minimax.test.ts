// The MiniMax user-code stand-in, driven the way the next slice's sign-in will be: import the BUILT
// @byokit/accounts/testing, start mockDevice({ dialect: 'minimax' }) for each region, and drive the device-code and
// token steps over fetch against 127.0.0.1. Every answer is the recorded one in
// fixtures/conformance/minimax-oauth-typescript.json (start, pending, success, error, expired), including the extreme
// case: a wrong PKCE code_verifier gets status 'error' and no token. No account and no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
