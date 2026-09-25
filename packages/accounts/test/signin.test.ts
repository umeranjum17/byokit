// "Sign in with ChatGPT" on Pi's real ChatGPT sign-in, with OpenAI stood in for (mocked token and device endpoints):
// the redirect back to this computer, the app's own page in that tab, the code fallback, and every way it can go wrong.
// Moved from Crewhouse's test/onboard.test.ts with the code it covers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Accounts, fileStore, planOf } from '../src/index.ts';

// ChatGPT's redirect port is fixed at 1455 in the product; the tests take a free one so they never meet a real sign-in.
const port = await new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => r(port)); }); });

/** A ChatGPT access token as OpenAI shapes it: the account, the plan and the email in its claims. */
const jwt = (plan: string, email = 'sara@example.com') => ['x', Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: plan }, 'https://api.openai.com/profile': { email },
})).toString('base64url'), 'sig'].join('.');

const openai = { plan: 'plus', email: 'sara@example.com', exchange: 200, expiresIn: 864_000, refreshes: 0 };
let onRevoke: (() => Promise<void>) | undefined;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url === 'https://auth.openai.com/oauth/token') {
    const form = new URLSearchParams(String(init?.body));
    if (form.get('grant_type') === 'refresh_token') { openai.refreshes++; return Response.json({ access_token: jwt(openai.plan, openai.email), refresh_token: 'r2', expires_in: openai.expiresIn }); }
    const code = form.get('code');
    if (openai.exchange !== 200 || code !== 'good') return new Response('{"error":{"code":"token_expired"}}', { status: 401 });
    return Response.json({ access_token: jwt(openai.plan, openai.email), refresh_token: 'r', expires_in: 3600 });
  }
  if (url === 'https://auth.openai.com/oauth/revoke') { await onRevoke?.(); return Response.json({}); }
  if (url.endsWith('/deviceauth/usercode')) return Response.json({ device_auth_id: 'd1', user_code: 'WB60-FFV06', interval: 1 });
  if (url.endsWith('/deviceauth/token')) return new Response('', { status: 403 }); // still waiting for the person
  if (url.startsWith('http://127.0.0.1:')) return realFetch(input, init);
  throw new Error(`no network in this test: ${url}`);
}) as typeof fetch;
after(() => { globalThis.fetch = realFetch; });

const OWNER = 1;
function accounts() {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-signin-'));
  const path = (m: number) => join(dir, String(m), 'auth.json');
  return { a: new Accounts<any, number>({ app: 'Crewhouse', store: (m) => fileStore(path(m)), callbackPort: port, redirectMs: 600 }), path };
}
const back = async (q: Record<string, string>) => {
  const res = await realFetch(`http://127.0.0.1:${port}/auth/callback?${new URLSearchParams(q)}`);
  return { status: res.status, page: await res.text() };
};
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
async function until(what: string, fn: () => boolean, ms: number) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (fn()) return;
  throw new Error(`timed out: ${what}`);
}

test("sign in with ChatGPT: its own page, straight back here; the tab shows the app's words, and only once they're true", async () => {
  const { a, path } = accounts();
  try {
    const v = (await a.login(OWNER, 'chatgpt'))!;
    assert.deepEqual([v.state, v.via, v.code], ['waiting', 'browser', undefined], 'the redirect is the default, not a code');
    const url = new URL(v.url!);
    assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
    assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
    // A stray or forged return changes nothing.
    const forged = await back({ code: 'good', state: 'not-it' });
    assert.equal(forged.status, 400);
    assert.match(forged.page, /out of date\. Go back to Crewhouse/);
    assert.equal(a.view(OWNER, 'chatgpt')!.state, 'waiting');
    // The real one: exchanged, kept in this person's own store, and the tab says so in the app's words.
    const ok = await back({ code: 'good', state: stateOf(v.url!) });
    assert.match(ok.page, /You're signed in\. You can go back to Crewhouse now\./);
    assert.doesNotMatch(ok.page, /Authentication successful|\bpi\b/i, "never the engine's own page");
    await a.finished(OWNER, 'chatgpt');
    assert.equal(a.view(OWNER, 'chatgpt')!.state, 'done');
    assert.equal(await a.signedIn(OWNER, 'chatgpt'), true);
    assert.equal(await a.signedIn(2, 'chatgpt'), false);
    assert.match(readFileSync(path(OWNER), 'utf8'), /openai-codex/);
    assert.deepEqual(await a.plan(OWNER), { plan: 'plus', email: 'sara@example.com', work: false });
  } finally { a.stop(); }
});

test('sign-in failures on the page: declined, a failed exchange, the port taken, the page timing out; never half signed in', async () => {
  const { a } = accounts();
  try {
    // Cancel on ChatGPT's page: nothing changed, said kindly, in the tab and in the app.
    let v = (await a.login(OWNER, 'chatgpt'))!;
    const declined = await back({ error: 'access_denied', state: stateOf(v.url!) });
    assert.match(declined.page, /No problem\. Nothing was changed/);
    await a.finished(OWNER, 'chatgpt');
    assert.equal(a.view(OWNER, 'chatgpt')!.why, 'declined');
    assert.equal(await a.signedIn(OWNER, 'chatgpt'), false);

    // OpenAI refuses the exchange after the page said yes: the tab does not claim success, and nothing is kept.
    openai.exchange = 401;
    v = (await a.login(OWNER, 'chatgpt'))!;
    const refused = await back({ code: 'good', state: stateOf(v.url!) });
    assert.doesNotMatch(refused.page, /signed in\./);
    assert.match(refused.page, /ChatGPT didn't finish the sign-in/);
    await a.finished(OWNER, 'chatgpt');
    assert.equal(a.view(OWNER, 'chatgpt')!.error, "ChatGPT didn't finish the sign-in. Tap Sign in with ChatGPT to try again.");
    assert.equal(await a.signedIn(OWNER, 'chatgpt'), false);
    openai.exchange = 200;

    // Something else on this computer is signing in to ChatGPT right now (its port is taken).
    const other: Server = await new Promise((r) => { const s = createServer().listen(port, '127.0.0.1', () => r(s)); });
    v = (await a.login(OWNER, 'chatgpt'))!;
    await new Promise((r) => other.close(r));
    assert.deepEqual([v.state, v.why, v.error], ['failed', 'busy', 'Something else on this computer is signing in to ChatGPT. Try again in a minute.']);

    // Having trouble? The code instead, from the same button; and by itself when the page never comes back.
    v = (await a.login(OWNER, 'chatgpt'))!;
    assert.equal(v.via, 'browser');
    v = (await a.login(OWNER, 'chatgpt', { via: 'code' }))!;
    assert.deepEqual([v.state, v.via, v.code, v.url], ['waiting', 'code', 'WB60-FFV06', 'https://auth.openai.com/codex/device']);
    a.cancel(OWNER, 'chatgpt');
    await a.finished(OWNER, 'chatgpt');
    assert.equal(a.view(OWNER, 'chatgpt'), null, 'cancelled: nothing kept, nothing shown');
    v = (await a.login(OWNER, 'chatgpt'))!;
    assert.equal(v.via, 'browser');
    await until('the code took over', () => a.view(OWNER, 'chatgpt')?.code === 'WB60-FFV06', 5000);
    await assert.rejects(back({ code: 'good', state: stateOf(v.url!) }), 'the old page no longer signs anyone in');
    a.cancel(OWNER, 'chatgpt');

    // "Use my personal account": ChatGPT's page asks which account again.
    v = (await a.login(OWNER, 'chatgpt', { fresh: true }))!;
    assert.equal(new URL(v.url!).searchParams.get('prompt'), 'login');
    a.cancel(OWNER, 'chatgpt');
    assert.equal(await a.signedIn(OWNER, 'chatgpt'), false, 'never half signed in');
  } finally { a.stop(); }
});

test('a work ChatGPT is recognised from the sign-in itself, so the app can steer to a personal one', async () => {
  assert.deepEqual(planOf(jwt('enterprise', 'sara@acme.com')), { plan: 'enterprise', email: 'sara@acme.com', work: true });
  for (const p of ['business', 'team', 'edu']) assert.equal(planOf(jwt(p)).work, true, p);
  for (const p of ['plus', 'pro', 'free', 'go']) assert.equal(planOf(jwt(p)).work, false, p);
  assert.deepEqual(planOf('not-a-token'), { plan: '', email: '', work: false });
  const { a } = accounts();
  try {
    Object.assign(openai, { plan: 'business', email: 'sara@acme.com' });
    assert.equal(await a.plan(OWNER), null);
    const v = (await a.login(OWNER, 'chatgpt'))!;
    await back({ code: 'good', state: stateOf(v.url!) });
    await a.finished(OWNER, 'chatgpt');
    assert.deepEqual(await a.plan(OWNER), { plan: 'business', email: 'sara@acme.com', work: true });
  } finally { Object.assign(openai, { plan: 'plus', email: 'sara@example.com' }); a.stop(); }
});

test("Pi's engine keeps a successful short-lived refresh for keepFresh and forced recheck", async () => {
  const { a, path } = accounts();
  try {
    const v = (await a.login(OWNER, 'chatgpt'))!;
    await back({ code: 'good', state: stateOf(v.url!) });
    await a.finished(OWNER, 'chatgpt');
    openai.expiresIn = 1800;
    await a.keepFresh([OWNER]);
    assert.equal((await a.status(OWNER, 'chatgpt')).state, 'ready');
    assert.equal(JSON.parse(readFileSync(path(OWNER), 'utf8'))['openai-codex'].refresh, 'r2');
    assert.equal(await a.recheck(OWNER, 'chatgpt'), true);
    assert.equal(await a.signedIn(OWNER, 'chatgpt'), true);
  } finally { openai.expiresIn = 864_000; a.stop(); }
});

test("Pi's engine cannot refresh between revoke and removal", async () => {
  const { a, path } = accounts();
  let entered!: () => void;
  let release!: () => void;
  const revoking = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const v = (await a.login(OWNER, 'chatgpt'))!;
    await back({ code: 'good', state: stateOf(v.url!) });
    await a.finished(OWNER, 'chatgpt');
    const before = openai.refreshes;
    onRevoke = () => { entered(); return gate; };
    const signout = a.logout(OWNER, 'chatgpt');
    await revoking;
    const refreshing = (await a.runtime(OWNER)).getAuth('openai-codex', { minOAuthValidityMs: 365 * 86_400_000 });
    release();
    await signout;
    assert.equal(await refreshing, undefined);
    assert.equal(openai.refreshes, before);
    assert.deepEqual(JSON.parse(readFileSync(path(OWNER), 'utf8')), {});
  } finally { release(); onRevoke = undefined; a.stop(); }
});
