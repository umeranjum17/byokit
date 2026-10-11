// The RFC 8628 device sign-in for Grok, Kimi and Copilot as data, replayed over real HTTP against the BUILT
// @byokit/accounts/testing stand-in. Every case comes from fixtures/conformance/device-code-rfc8628-typescript.json:
// Grok and Kimi are one grant (start, poll pending/success, refresh, decline) against the generic mockDevice();
// Copilot is the same grant on a named GitHub host (github.com and a GitHub Enterprise domain) whose device grant
// answers an intermediate GitHub token that a second exchange turns into the credential, plus the exchanged-token
// refusal (401 and 403) that means signed out, never a retry. No account and no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deviceFlow, signInChoices } from '@byokit/accounts';
import { mockDevice } from '@byokit/accounts/testing';

type Case = { name: string; status: number; error?: string; keys?: string[]; approve?: boolean; deny?: boolean; result?: string };
type Provider = { pi: string; authorization: string; token: string; clientId: string; scope?: string; form?: Record<string, string>;
  start: { status: number; keys: string[] }; poll: Case[]; refresh: { status: number; keys: string[] } };
type Copilot = { pi: string; authorization: string; token: string; exchange: string; clientId: string; scope: string; hosts: string[]; unauthorized: number[];
  cases: Record<'start' | 'pending' | 'success' | 'decline' | 'exchange' | 'unauthorized', { status: number; body: Record<string, unknown> }> };
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/device-code-rfc8628-typescript.json', import.meta.url), 'utf8')) as {
  grantType: string; providers: { grok: Provider; kimi: Provider; copilot: Copilot } };
const render = (value: unknown, host: string): any => JSON.parse(JSON.stringify(value).replaceAll('{host}', host));
const path = (url: string) => new URL(url).pathname;
const post = (base: string, url: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(`${base}${path(url)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams(form) });
const keys = (body: Record<string, unknown>) => Object.keys(body).sort();

test('the fixture data is the runtime catalogue data for Grok and Kimi; the four existing providers are unchanged', () => {
  for (const key of ['grok', 'kimi'] as const) {
    const spec = fixture.providers[key];
    const flow = deviceFlow(spec.pi)!;
    assert.deepEqual({ authorization: flow.authorization, token: flow.token, clientId: flow.clientId, scope: flow.scope, form: flow.form },
      { authorization: spec.authorization, token: spec.token, clientId: spec.clientId, scope: spec.scope, form: spec.form }, key);
  }
  // No device row was added or changed: the picker and every pinned endpoint stay as they were.
  assert.deepEqual(signInChoices().map((p) => p.key), ['grok', 'kimi']);
  assert.equal(deviceFlow('openai-codex'), undefined, 'ChatGPT keeps its own engine, not catalogue device data');
  assert.equal(deviceFlow('minimax')!.authorization, 'https://account.minimax.io/oauth2/device/code');
  assert.equal(deviceFlow('github-copilot'), undefined, 'Copilot is data in the fixture, not wired into the runtime yet');
});

test('Grok and Kimi replay their fixture start, poll, refresh and decline cases against the generic stand-in', async () => {
  for (const key of ['grok', 'kimi'] as const) {
    const spec = fixture.providers[key];
    const m = await mockDevice();
    const at = (what: string) => `${key}: ${what}`;
    try {
      const start = await post(m.base, spec.authorization, { client_id: spec.clientId, ...(spec.scope ? { scope: spec.scope } : {}), ...spec.form });
      assert.equal(start.status, spec.start.status, at('start status'));
      const code = await start.json() as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number };
      assert.deepEqual(keys(code), [...spec.start.keys].sort(), at('start fields'));
      assert.ok(code.device_code && code.user_code, at('a code to type'));
      assert.ok(code.verification_uri.startsWith(m.base), at('the stand-in page to open'));
      assert.ok(code.interval >= 0 && code.expires_in > 0, at('interval and expiry'));

      const poll = (deviceCode: string) => post(m.base, spec.token, { grant_type: fixture.grantType, client_id: spec.clientId, device_code: deviceCode });
      const [pending, success, decline] = spec.poll;
      const before = await poll(code.device_code);
      assert.equal(before.status, pending.status, at('pending status'));
      assert.equal((await before.json() as { error: string }).error, pending.error, at('pending error'));

      assert.equal(m.approve(code.user_code), true, at('approving the code'));
      const done = await poll(code.device_code);
      assert.equal(done.status, success.status, at('success status'));
      const token = await done.json() as { access_token: string; refresh_token: string; expires_in: number };
      assert.deepEqual(keys(token), [...success.keys!].sort(), at('success fields'));
      assert.ok(token.access_token && token.refresh_token, at('a token and its refresh'));

      const refreshed = await post(m.base, spec.token, { grant_type: 'refresh_token', client_id: spec.clientId, refresh_token: token.refresh_token });
      assert.equal(refreshed.status, spec.refresh.status, at('refresh status'));
      assert.deepEqual(keys(await refreshed.json() as Record<string, unknown>), [...spec.refresh.keys].sort(), at('refresh fields'));

      const second = await post(m.base, spec.authorization, { client_id: spec.clientId, ...(spec.scope ? { scope: spec.scope } : {}) });
      const refused = await second.json() as { device_code: string; user_code: string };
      assert.equal(m.approve(refused.user_code, true), true, at('declining on the page'));
      const denied = await poll(refused.device_code);
      assert.equal(denied.status, decline.status, at('decline status'));
      const deniedBody = await denied.json() as { error: string; access_token?: string };
      assert.equal(deniedBody.error, decline.error, at('decline error'));
      assert.equal(deniedBody.access_token, undefined, at('a decline keeps no token'));
    } finally {
      await m.close();
    }
  }
});

test('Copilot replays its fixture on github.com and an Enterprise host: exchange, re-mint on refresh, decline and the 401/403 refusal', async () => {
  const spec = fixture.providers.copilot;
  for (const host of spec.hosts) {
    const m = await mockDevice({ dialect: 'copilot', domain: host });
    const at = (what: string) => `${host}: ${what}`;
    const auth = render(spec.authorization, host);
    const token = render(spec.token, host);
    const exchange = render(spec.exchange, host);
    const cases = render(spec.cases, host) as Copilot['cases'];
    try {
      assert.deepEqual(m.answers, cases, at('the stand-in replays exactly the fixture cases'));

      const start = await post(m.base, auth, { client_id: spec.clientId, scope: spec.scope });
      assert.equal(start.status, cases.start.status, at('start status'));
      const code = await start.json() as { device_code: string; user_code: string; verification_uri: string };
      assert.deepEqual(code, cases.start.body, at('start body: the code and the host page'));
      assert.equal(new URL(code.verification_uri).host, host, at('the page is on the named host'));

      const poll = (deviceCode: string) => post(m.base, token, { grant_type: fixture.grantType, client_id: spec.clientId, device_code: deviceCode });
      const before = await poll(code.device_code);
      assert.equal(before.status, cases.pending.status, at('pending status'));
      assert.deepEqual(await before.json(), cases.pending.body, at('pending body'));

      assert.equal(m.approve(code.user_code), true, at('approving the code'));
      const done = await poll(code.device_code);
      assert.equal(done.status, cases.success.status, at('success status'));
      const github = await done.json() as { access_token: string };
      assert.deepEqual(github, cases.success.body, at('success: the intermediate GitHub token'));

      // The exchange: the intermediate token as the bearer becomes the credential.
      const minted = await post(m.base, exchange, {}, { authorization: `Bearer ${github.access_token}` });
      assert.equal(minted.status, cases.exchange.status, at('exchange status'));
      assert.deepEqual(await minted.json(), cases.exchange.body, at('exchange body: the credential token'));

      // Refresh re-mints the credential from a freshly issued intermediate token, the same way.
      const rotated = await post(m.base, token, { grant_type: 'refresh_token', client_id: spec.clientId, refresh_token: github.access_token });
      assert.equal(rotated.status, 200, at('refresh status'));
      const next = await rotated.json() as { access_token: string };
      const reminted = await post(m.base, exchange, {}, { authorization: `Bearer ${next.access_token}` });
      assert.equal(reminted.status, cases.exchange.status, at('re-mint status'));
      assert.deepEqual(await reminted.json(), cases.exchange.body, at('re-mint body'));

      // A refused exchange is signed out, not retried: both 401 and 403 read the same way.
      for (const status of spec.unauthorized) {
        m.state.refuse = true;
        m.state.refuseStatus = status;
        const refused = await post(m.base, exchange, {}, { authorization: `Bearer ${github.access_token}` });
        assert.equal(refused.status, status, at(`exchange ${status} status`));
        assert.deepEqual(await refused.json(), cases.unauthorized.body, at(`exchange ${status} body`));
      }
      m.state.refuse = false;

      // Declining on the page keeps nothing.
      const again = await post(m.base, auth, { client_id: spec.clientId, scope: spec.scope });
      const second = await again.json() as { device_code: string; user_code: string };
      assert.equal(m.approve(second.user_code, true), true, at('declining on the page'));
      const denied = await poll(second.device_code);
      assert.equal(denied.status, cases.decline.status, at('decline status'));
      assert.deepEqual(await denied.json(), cases.decline.body, at('decline body'));

      // Only the three documented paths were ever reached.
      assert.deepEqual([...new Set(m.state.requests.map((r) => r.path))].sort(), [path(auth), path(token), path(exchange)].sort(), at('only the documented paths'));
    } finally {
      await m.close();
    }
  }
});
