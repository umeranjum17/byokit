// A consumer's own journey against the built @byokit/accounts: one person with two signed-in Claude Pro/Max accounts
// asks with a selected account, and each answer comes from that account's own sign-in. Every import is a published
// entry (the package's dist, never its src modules). The two sign-ins run the kit's own manual PKCE flow against a
// loopback stand-in for Claude's token endpoint, and inference replays the recorded Messages SSE; the stand-in records
// the bearer it was asked with, so a select that answered with the wrong account's access would be caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Accounts, ClaudePlanExpiredError, ResponseError, memoryStore, portable } from '@byokit/accounts';

const plan = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/claude-plan-typescript.json', import.meta.url), 'utf8'));
const messages = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/claude-messages-typescript.json', import.meta.url), 'utf8'));
const answer = messages.cases.find((c: any) => c.name === 'text with pings and unknown future event');
const NOW = plan.now;
// The two Claude plan slots the person signed in with, by the public account id list() shows.
const PRIMARY = 'claude';
const tokenHost = 'https://platform.claude.com';
const apiHost = 'https://api.anthropic.com';

/** Claude's token endpoint (manual PKCE exchange and refresh) and its Messages SSE, offline: distinct access per
 *  sign-in, a switch to make a refresh return an accepted but unusable answer, and a one-shot HTTP failure. */
async function claudeStandIn() {
  const issued: string[] = [];
  const state = { fail: undefined as { status: number; body: unknown } | undefined, unusableRefresh: undefined as string | undefined };
  const requests: { bearer: string; body: any }[] = [];
  const send = (res: any, status: number, data: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof data === 'string' ? data : JSON.stringify(data));
  };
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url ?? '/', 'http://x');
    const body = raw ? JSON.parse(raw) : {};
    if (url.pathname === '/v1/oauth/token') {
      if (body.grant_type === 'authorization_code') {
        const n = issued.length + 1;
        issued.push(`access-${n}`);
        return send(res, 200, { access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: 3600 });
      }
      const refresh = String(body.refresh_token ?? '');
      // Claude rotates every refresh; an accepted answer that cannot be used is the "expired" the kit keeps marked.
      if (state.unusableRefresh === refresh) return send(res, 200, { access_token: 'unusable-access', refresh_token: refresh, expires_in: 0 });
      const n = refresh.split('-')[1];
      const access = `access-${n}`;
      if (!issued.includes(access)) issued.push(access);
      return send(res, 200, { access_token: access, refresh_token: refresh, expires_in: 3600 });
    }
    if (url.pathname === '/v1/messages') {
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      requests.push({ bearer, body });
      if (!issued.includes(bearer)) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'Provided authentication token is expired.' } });
      if (state.fail) { const f = state.fail; state.fail = undefined; return send(res, f.status, f.body); }
      return send(res, 200, answer.stream, 'text/event-stream');
    }
    return send(res, 404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, state, requests, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}

const ask = (select: { account: string }) => ({
  provider: 'claude' as const, model: 'claude-opus-5-5', max_tokens: 64,
  messages: [{ role: 'user' as const, content: 'Hello' }], select,
});

test('Claude respond answers from the selected account; expiry signs out only that account, never the primary', async () => {
  const stand = await claudeStandIn();
  // The kit's default endpoints are rewritten to the loopback stand-in, as a PWA's serve.ts forwards them.
  const forwarded: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    for (const host of [apiHost, tokenHost]) if (url.startsWith(host)) return fetch(new URL(url.slice(host.length), stand.base).toString(), init);
    return fetch(input as any, init);
  };
  const store = memoryStore();
  const accounts = new Accounts<any, number>({ store: () => store, fetch: forwarded, claudePlan: { now: () => NOW }, app: 'byokit journey' }, portable);
  try {
    // Two people sign in through the manual PKCE flow: the first keeps the bare provider id and is the primary.
    const first = await accounts.add(1, 'claude');
    accounts.paste(1, first.id, `code#${new URL(first.signIn!.url!).searchParams.get('state')}`);
    await accounts.finished(1, first.id);
    assert.equal(accounts.view(1, first.id)?.state, 'done');

    const secondSignIn = await accounts.add(1, 'claude');
    accounts.paste(1, secondSignIn.id, `code#${new URL(secondSignIn.signIn!.url!).searchParams.get('state')}`);
    await accounts.finished(1, secondSignIn.id);

    const ids = (await accounts.list(1)).map((r) => r.id);
    const second = ids.find((id) => id !== PRIMARY)!;
    assert.equal(ids.includes(PRIMARY), true, 'the first account is the bare primary');
    assert.notEqual(second, PRIMARY);
    assert.equal(ids.length, 2);

    // Each select answers with its own account's bearer, and the select never leaks into the Messages request.
    assert.equal(await accounts.respond(1, ask({ account: PRIMARY })), answer.text);
    assert.equal(stand.requests.at(-1)!.bearer, 'access-1', 'the primary answered with the primary sign-in');
    assert.equal(await accounts.respond(1, ask({ account: second })), answer.text);
    assert.equal(stand.requests.at(-1)!.bearer, 'access-2', 'the second account answered with its own sign-in');
    assert.equal('select' in stand.requests.at(-1)!.body, false);
    assert.equal('provider' in stand.requests.at(-1)!.body, false);

    // A 429 on the selected account rests only it: one request, no retry on the primary, which stays ready.
    stand.state.fail = { status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'You have hit your usage limit' } } };
    const before = stand.requests.length;
    await assert.rejects(
      accounts.respond(1, ask({ account: second })),
      (e: any) => e instanceof ResponseError && e.kind === 'rate_limit' && e.until > Date.now(),
    );
    assert.equal(stand.requests.length, before + 1, 'one request, no retry on another account');
    const resting = await accounts.list(1);
    assert.equal(resting.find((r) => r.id === second)!.state, 'resting', 'only the selected account rests');
    assert.equal(resting.find((r) => r.id === PRIMARY)!.state, 'ready', 'the primary is untouched');

    // Expiring the selected account: its refresh returns an accepted, unusable answer (the grant is spent), so it is
    // signed out alone. The primary's credential survives and a fresh app still lists it ready.
    const live = await store.read(second);
    await store.modify(second, async () => ({ ...(live as any), expires: NOW }));
    stand.state.unusableRefresh = 'refresh-2';
    await assert.rejects(accounts.respond(1, ask({ account: second })), ClaudePlanExpiredError);
    assert.ok(await store.read('byokit-claude-plan'), 'the primary credential is untouched');
    assert.ok(await store.read(second), 'the expired account keeps its marked credential, not deleted as another account');

    const fresh = new Accounts<any, number>({ store: () => store, fetch: forwarded, claudePlan: { now: () => NOW } }, portable);
    try {
      const rows = await fresh.list(1);
      assert.equal(rows.find((r) => r.id === PRIMARY)!.state, 'ready', 'the primary stays ready');
      assert.equal(rows.find((r) => r.id === second)!.state, 'signed_out', 'expiring #2 signed out only #2');
    } finally { fresh.stop(); }
  } finally {
    accounts.stop();
    await stand.close();
  }
});
