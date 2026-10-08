import { key, sealing } from './sealing.ts';
// "Sign in with ChatGPT" on Pi's real ChatGPT sign-in, with OpenAI stood in for (mocked token and device endpoints):
// the redirect back to this computer, the app's own page in that tab, the code fallback, and every way it can go wrong.
// Moved from Crewhouse's test/onboard.test.ts with the code it covers.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { scratchDir } from '../../test-support.ts';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Accounts, fileStore, machineStore, planOf } from '../src/index.ts';
import { CLAUDE_PLAN_ID } from '../src/claude-plan.ts';
import { needsReauth } from '../src/stores.ts';

// ChatGPT's redirect port is fixed at 1455 in the product; the tests take a free one so they never meet a real sign-in.
const port = await new Promise<number>((r) => { const s = createServer().listen(0, '127.0.0.1', () => { const { port } = s.address() as AddressInfo; s.close(() => r(port)); }); });

/** A ChatGPT access token as OpenAI shapes it: the account, the plan and the email in its claims. */
const jwt = (plan: string, email = 'umer@example.com') => ['x', Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: plan }, 'https://api.openai.com/profile': { email },
})).toString('base64url'), 'sig'].join('.');

const openai = { plan: 'plus', email: 'umer@example.com', exchange: 200, expiresIn: 864_000, refreshes: 0 };
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
  const dir = scratchDir('signin');
  const path = (m: number) => join(dir, String(m), 'auth.json');
  return { a: new Accounts<any, number>({ app: 'Crewhouse', store: (m) => fileStore(path(m), sealing), callbackPort: port, redirectMs: 600 }), path };
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
    assert.match(sealing.decryptString(readFileSync(path(OWNER))), /openai-codex/);
    assert.deepEqual(await a.plan(OWNER), { plan: 'plus', email: 'umer@example.com', work: false });
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
  assert.deepEqual(planOf(jwt('enterprise', 'umer@acme.com')), { plan: 'enterprise', email: 'umer@acme.com', work: true });
  for (const p of ['business', 'team', 'edu']) assert.equal(planOf(jwt(p)).work, true, p);
  for (const p of ['plus', 'pro', 'free', 'go']) assert.equal(planOf(jwt(p)).work, false, p);
  assert.deepEqual(planOf('not-a-token'), { plan: '', email: '', work: false });
  const { a } = accounts();
  try {
    Object.assign(openai, { plan: 'business', email: 'umer@acme.com' });
    assert.equal(await a.plan(OWNER), null);
    const v = (await a.login(OWNER, 'chatgpt'))!;
    await back({ code: 'good', state: stateOf(v.url!) });
    await a.finished(OWNER, 'chatgpt');
    assert.deepEqual(await a.plan(OWNER), { plan: 'business', email: 'umer@acme.com', work: true });
  } finally { Object.assign(openai, { plan: 'plus', email: 'umer@example.com' }); a.stop(); }
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
    assert.equal(JSON.parse(sealing.decryptString(readFileSync(path(OWNER))))['openai-codex'].refresh, 'r2');
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
    assert.deepEqual(JSON.parse(sealing.decryptString(readFileSync(path(OWNER)))), {});
  } finally { release(); onRevoke = undefined; a.stop(); }
});

// ChatGPT refreshes through Pi's engine (the store's modify); a Claude plan through the kit's refresh seam.
test("a second app on this computer finds the first one's sign-in at the machine store, and never asks again", async () => {
  const home = scratchDir('machine');
  const realHome = process.env.HOME;
  process.env.HOME = home;
  const first = new Accounts<any, number>({ app: 'Crewhouse', store: (m) => machineStore(m, sealing), callbackPort: port, redirectMs: 600 });
  try {
    const v = (await first.login(OWNER, 'chatgpt'))!;
    assert.equal((await back({ code: 'good', state: stateOf(v.url!) })).status, 200);
    await first.finished(OWNER, 'chatgpt');
  } finally { first.stop(); process.env.HOME = realHome; }
  if (process.platform === 'linux') assert.ok(existsSync(join(home, '.local', 'share', 'byokit', 'people', String(OWNER), 'auth.json')), 'the conventional path');
  // The second app: its own process and name, the same computer and seal; no login of its own.
  const second = `import { Accounts, machineStore } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
    import { sealing } from ${JSON.stringify(new URL('./sealing.ts', import.meta.url).href)};
    const kit = new Accounts({ app: 'Message desk', store: (m) => machineStore(m, sealing) });
    console.log(JSON.stringify({ signedIn: await kit.signedIn(${OWNER}, 'chatgpt'), plan: await kit.plan(${OWNER}) }));
    kit.stop();`;
  const env = { ...process.env, HOME: home, SEAL_KEY: key.toString('hex') };
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', second], { env, timeout: 20_000 });
  assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()!), { signedIn: true, plan: { plan: 'plus', email: openai.email, work: false } });
  assert.throws(() => machineStore('../1', sealing), /letters, digits/, 'a member never leaves the people folder');
});

for (const [provider, name, account] of [['openai-codex', 'ChatGPT', { accountId: 'acct-1' }], [CLAUDE_PLAN_ID, 'Claude', {}]] as const) test(`two app processes refreshing one ${name} sign-in at once keep the fresh one, never a spent grant`, async () => {
  const path = join(scratchDir('two-processes'), 'people', '1', 'auth.json');
  await fileStore(path, sealing).modify(provider, async () => ({ type: 'oauth', access: jwt('plus'), refresh: 'rt_1', expires: Date.now() + 60_000, ...account }));
  // The provider rotates: a refresh spends its grant. The first refresh is held until a second one arrives (or a second
  // passes), and a spent grant is refused after the winner's answer, so unserialized refreshes interleave every run.
  const live = new Set(['rt_1']);
  let issued = 1, waiting: (() => void) | undefined, answered!: () => void;
  const winner = new Promise<void>((r) => { answered = r; });
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; }).on('end', async () => {
      const grant = body.startsWith('{') ? JSON.parse(body).refresh_token : new URLSearchParams(body).get('refresh_token');
      if (!live.delete(grant)) {
        waiting?.(); await winner; await new Promise((r) => setTimeout(r, 200));
        return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
      }
      await new Promise<void>((r) => { waiting = r; setTimeout(r, 1000); });
      live.add(`rt_${++issued}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: jwt('plus'), refresh_token: `rt_${issued}`, expires_in: 864_000 }));
      answered();
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  // An app that crashed holding the store's lock does not wedge it, even when its pid now belongs to a live process.
  writeFileSync(`${path}.lock`, `${provider === CLAUDE_PLAN_ID ? process.pid : spawnSync(process.execPath, ['-e', '']).pid} crashed`);
  if (provider === CLAUDE_PLAN_ID) utimesSync(`${path}.lock`, new Date(0), new Date(0));
  try {
    const env = { ...process.env, PROVIDER: provider, STORE: path, SEAL_KEY: key.toString('hex'), TOKEN_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token` };
    const run = () => promisify(execFile)(process.execPath, [join(import.meta.dirname, 'refresh-run.ts')], { env, timeout: 20_000 }).then((r) => JSON.parse(r.stdout.trim().split('\n').pop()!));
    const runs = await Promise.all([run(), run()]);
    const stored = JSON.parse(sealing.decryptString(readFileSync(path)))[provider];
    assert.deepEqual(runs, [{ ok: true }, { ok: true }], `both processes got an access token; stored: ${JSON.stringify({ refresh: stored?.refresh, marker: stored?.byokitRefresh })}`);
    assert.ok(live.has(stored.refresh), 'the stored grant is the one the provider still honours');
    assert.ok(!needsReauth(stored), 'not a sign-in marked spent');
    assert.equal(issued, 2, 'the second process used the first one\'s refresh instead of spending a grant');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a Claude refresh that gets a server error in one app process keeps the sign-in; the other process rotates the same grant once', async () => {
  const path = join(scratchDir('two-processes-lost'), 'people', '1', 'auth.json');
  await fileStore(path, sealing).modify(CLAUDE_PLAN_ID, async () => ({ type: 'oauth', access: jwt('plus'), refresh: 'rt_1', expires: Date.now() + 60_000 }));
  // The first refresh is held while the other process queues behind the store's lock, then answered 503 without
  // spending the grant; a spent grant is refused, as the provider does.
  const live = new Set(['rt_1']), sent: string[] = [];
  let issued = 1;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; }).on('end', async () => {
      const grant = JSON.parse(body).refresh_token;
      sent.push(grant);
      if (sent.length === 1) { await new Promise((r) => setTimeout(r, 500)); return res.writeHead(503).end(); }
      if (!live.delete(grant)) return res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"invalid_grant"}');
      live.add(`rt_${++issued}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: jwt('plus'), refresh_token: `rt_${issued}`, expires_in: 864_000 }));
    });
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const env = { ...process.env, PROVIDER: CLAUDE_PLAN_ID, STORE: path, SEAL_KEY: key.toString('hex'), TOKEN_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/token` };
    const run = () => promisify(execFile)(process.execPath, [join(import.meta.dirname, 'refresh-run.ts')], { env, timeout: 20_000 }).then((r) => JSON.parse(r.stdout.trim().split('\n').pop()!));
    const runs = await Promise.all([run(), run()]);
    const stored = JSON.parse(sealing.decryptString(readFileSync(path)))[CLAUDE_PLAN_ID];
    const why = JSON.stringify({ runs, sent, refresh: stored?.refresh, marker: stored?.byokitRefresh });
    assert.deepEqual(runs.map((r) => r.ok).sort(), [false, true], why);
    assert.equal(runs.find((r) => !r.ok).error, 'Error', `the lost refresh is not a sign-out: ${why}`);
    assert.deepEqual(sent, ['rt_1', 'rt_1'], `the kept grant was sent again once, never a spent one: ${why}`);
    assert.ok(stored && live.has(stored.refresh) && !needsReauth(stored), `the sign-in is kept, holding the grant the provider honours: ${why}`);
  } finally { server.closeAllConnections(); server.close(); }
});
