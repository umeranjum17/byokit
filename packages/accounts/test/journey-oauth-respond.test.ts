// A consumer's own journey against the built @byokit/accounts: one person signs in to two Grok accounts by device code
// (the kit's mockDevice stand-in) and asks each one through the pinned Pi Models path. Every import is a published entry
// (`.`, `/keys`, `/testing`). A loopback stand-in for xAI's Responses endpoint replays fixtures/conformance/pi-streams.json
// and records the bearer each request carried. A 429 rests only the account that got it, typed and never retried, while
// the other still answers; a refresh the provider proves revoked or refuses with a bare 400-403 signs only that account
// out, while a 5xx or a dropped connection keeps the sign-in, typed network. On a computer the same rule holds around Pi's
// own refresh, driven for Kimi against a stand-in token endpoint. No account and no real network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Accounts, KeyRouteError, ResponseError, portable, recordStore, type Api, type AssistantMessageEvent, type Context, type Model } from '@byokit/accounts';
import { withKeys } from '@byokit/accounts/keys';
import { mockDevice } from '@byokit/accounts/testing';
import streamFixture from '../../../fixtures/conformance/pi-streams.json' with { type: 'json' };

/** xAI's Responses endpoint, stood in: the fixture's recorded stream, or a 429 (echoing the bearer) for a limited one. */
async function fakeXai() {
  const requests: { path: string; bearer: string }[] = [];
  const limited = new Set<string>();
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    requests.push({ path: req.url ?? '', bearer });
    if (limited.has(bearer)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      return res.end(JSON.stringify({ error: { message: `Rate limit reached for ${bearer}`, type: 'rate_limit_exceeded' } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(streamFixture.families.responses.events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, requests, limited, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Stands in for the provider's token endpoint: forwards every request to the mock, except a refresh it answers with a
 *  configured bare status or a dropped connection. */
async function fakeRefresh(target: string) {
  let refused: { status: number } | 'drop' | undefined;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (refused && body.includes('grant_type=refresh_token')) {
      if (refused === 'drop') return void req.socket.destroy();
      res.writeHead(refused.status, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: 'server_error' }));
    }
    const upstream = await fetch(`${target}${req.url}`, { method: req.method, headers: { 'content-type': String(req.headers['content-type'] ?? 'application/json') }, body: body || undefined });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(await upstream.text());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    refuse: (next: { status: number } | 'drop' | undefined) => { refused = next; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const model = <T extends Api>(provider: string, api: T, baseUrl: string): Model<T> => ({ id: 'grok-4.7', name: 'Grok', provider, api, baseUrl,
  reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 });
const context = streamFixture.context as Context;

test('two Grok accounts each answer with their own sign-in; a 429 rests only that one, a bare 400-403 at refresh signs only that one out, and a 5xx or dropped refresh keeps it', async () => {
  const m = await mockDevice();
  const refresh = await fakeRefresh(m.base);
  const xai = await fakeXai();
  let data: any = {};
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  // The app offers Meta too, as one offer list shared by every platform it ships on.
  const accounts = new Accounts<any, number>({ deviceBase: refresh.base, app: 'byokit journey', offer: ['grok', 'meta'], store: () => store }, withKeys(portable));
  const signIn = async () => {
    const added = await accounts.add(1, 'grok', { via: 'code' });
    assert.equal(m.approve(added.signIn!.code!), true, 'approving the code');
    await accounts.finished(1, added.id);
    return accounts.view(1, added.id)!.id!;
  };
  try {
    // Work signs in first and keeps the bare provider id; Personal is a second, `grok.<id>`.
    const work = await signIn();
    const personal = await signIn();
    assert.equal(work, 'grok');
    assert.match(personal, /^grok\./);
    const tokenOf = async (id: string) => ((await (await accounts.runtime(1, id)).readCredential('xai')) as { access: string }).access;
    const tokens = { work: await tokenOf(work), personal: await tokenOf(personal) };
    assert.notEqual(tokens.work, tokens.personal, 'two sign-ins, two tokens');

    const grok = model('xai', 'openai-responses', `${xai.base}/v1`);
    const ask = async (account: string) => {
      const deltas: string[] = [], events: AssistantMessageEvent[] = [];
      const result = await accounts.respond(1, { account, model: grok, context, onText: (d) => deltas.push(d), onEvent: (e) => events.push(e) });
      return { result, deltas, events };
    };

    // Each account streams the fixture's answer, and its own bearer is the one that reached xAI.
    const seen: unknown[] = [];
    for (const [id, token] of [[work, tokens.work], [personal, tokens.personal]]) {
      const { result, deltas, events } = await ask(id);
      assert.deepEqual(deltas, [streamFixture.expected.text], `${id}: streamed into onText`);
      assert.equal(result.stopReason, streamFixture.expected.stopReason);
      assert.deepEqual([result.usage.input, result.usage.output, result.usage.totalTokens], streamFixture.expected.usage);
      assert.equal(result.content.find((c) => c.type === 'toolCall')?.name, streamFixture.expected.tool);
      assert.deepEqual(xai.requests.at(-1), { path: '/v1/responses', bearer: token }, `${id}: its own bearer`);
      seen.push(result, events);
    }

    // A 429 on Personal: typed, one request only (no retry), and only Personal rests. Its echoed bearer stays out.
    xai.limited.add(tokens.personal);
    const before = xai.requests.length;
    const limited = await accounts.respond(1, { account: personal, model: grok, context }).then(() => assert.fail('a 429 answered'), (e: unknown) => e);
    assert.ok(limited instanceof ResponseError, 'a ResponseError');
    assert.equal(limited.kind, 'rate_limit');
    assert.equal(limited.status, 429);
    assert.ok(limited.until > Date.now() + 60_000 && limited.until <= Date.now() + 120_000, 'until the retry-after');
    assert.equal(xai.requests.length, before + 1, 'never retried');
    assert.equal((await accounts.status(1, personal)).state, 'resting');
    assert.equal((await accounts.status(1, work)).state, 'ready', 'Work does not rest');
    const still = await ask(work);
    assert.equal(still.result.stopReason, streamFixture.expected.stopReason, 'Work still answers');
    assert.equal(xai.requests.at(-1)?.bearer, tokens.work);
    seen.push(limited, { ...limited }, limited.message);

    // A model from another provider is refused before any request.
    const sent = xai.requests.length;
    await assert.rejects(accounts.respond(1, { account: work, model: model('openai', 'openai-responses', `${xai.base}/v1`), context }),
      (e: unknown) => e instanceof KeyRouteError && e.code === 'provider');
    // Meta's route cannot run in a browser: typed not_included, not an untyped Error.
    await assert.rejects(accounts.respond(1, { account: 'meta', model: model('meta', 'openai-responses', `${xai.base}/v1`), context }),
      (e: unknown) => e instanceof ResponseError && e.kind === 'not_included');
    assert.equal(xai.requests.length, sent, 'neither refusal reached the provider');

    // Work's sign-in comes due and the provider refuses its refresh (invalid_grant, 400): only Work is signed out.
    await store.modify('xai', async (c: any) => ({ ...c, expires: 0 }));
    m.state.live.clear();
    const expired = await accounts.respond(1, { account: work, model: grok, context }).then(() => assert.fail('a refused refresh answered'), (e: unknown) => e);
    assert.ok(expired instanceof ResponseError && expired.kind === 'signed_out', 'signed out, typed');
    assert.equal(xai.requests.length, sent, 'no request after a refused refresh');
    assert.equal(await store.read('xai'), undefined, "Work's sign-in is gone");
    assert.deepEqual((await accounts.list(1)).map((r) => [r.id, r.state]), [[personal, 'resting']], 'only Work is gone; Personal still rests');
    seen.push(expired, expired.message);

    // A bare 403 at refresh, with no invalid_grant body, signs only that account out; a 5xx or a dropped connection
    // keeps the sign-in, typed network. A fresh third sign-in stands in, made due before each answer.
    const third = await signIn();
    const due = () => store.modify(third, async (c: any) => ({ ...c, expires: 0 }));

    refresh.refuse({ status: 500 });
    await due();
    const keptServer = await accounts.respond(1, { account: third, model: grok, context }).then(() => assert.fail('a 5xx refresh answered'), (e: unknown) => e);
    assert.ok(keptServer instanceof ResponseError && keptServer.kind === 'network', 'a 5xx refresh keeps the sign-in, typed network');
    assert.equal(xai.requests.length, sent, 'a 5xx refresh sends no request to the provider');
    assert.ok((await accounts.list(1)).some((r) => r.id === third), 'the sign-in is still listed after a 5xx refresh');
    seen.push(keptServer, keptServer.message);

    refresh.refuse('drop');
    await due();
    const keptDrop = await accounts.respond(1, { account: third, model: grok, context }).then(() => assert.fail('a dropped refresh answered'), (e: unknown) => e);
    assert.ok(keptDrop instanceof ResponseError && keptDrop.kind === 'network', 'a dropped refresh keeps the sign-in, typed network');
    assert.equal(xai.requests.length, sent, 'a dropped refresh sends no request to the provider');
    assert.ok((await accounts.list(1)).some((r) => r.id === third), 'the sign-in is still listed after a dropped refresh');
    seen.push(keptDrop, keptDrop.message);

    refresh.refuse({ status: 403 });
    await due();
    const refused = await accounts.respond(1, { account: third, model: grok, context }).then(() => assert.fail('a 403 refresh answered'), (e: unknown) => e);
    assert.ok(refused instanceof ResponseError && refused.kind === 'signed_out', 'a bare 403 signs out, typed');
    assert.equal(xai.requests.length, sent, 'no request after a 403 refresh');
    assert.equal(await store.read(third), undefined, 'the sign-in is gone after a 403 refresh');
    assert.ok(!(await accounts.list(1)).some((r) => r.id === third), 'the signed-out account is not listed');
    seen.push(refused, refused.message);

    // Neither token appears anywhere a person or an app reads.
    const pub = JSON.stringify([seen, await accounts.list(1), await accounts.status(1, work), await accounts.status(1, personal), await store.index()]);
    for (const token of Object.values(tokens)) assert.ok(!pub.includes(token), `no ${token} in answers, events, errors, list, status or the index`);
  } finally {
    await xai.close();
    await refresh.close();
    await m.close();
  }
});

// The same path on a computer, where Pi refreshes internally: a refresh that gets no answer (the egress guard refuses the
// dial to xAI) carries no status, so respond reports it as typed network and keeps the sign-in.
test('on a computer a refresh with no answer is typed network and the sign-in is kept', async () => {
  let data: any = {};
  const base = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  // Pi refreshes through `modify` on a computer, never through the kit's `refresh` seam.
  const seams: string[] = [];
  const store = { ...base, refresh: (...args: any[]) => { seams.push('refresh'); return (base.refresh as any)(...args); }, modify: (...args: any[]) => { seams.push('modify'); return (base.modify as any)(...args); } };
  data['xai'] = { type: 'oauth', access: 'seeded-access', refresh: 'seeded-refresh', expires: 0, byokitRefresh: { generation: 0, state: 'ready' } };
  data['.accounts'] = { names: {}, emails: {}, plans: {}, addedAt: { grok: Date.now() }, defaults: {} };
  const accounts = new Accounts<any, number>({ app: 'byokit journey', offer: ['grok'], store: () => store });
  const failed = await accounts.respond(1, { account: 'grok', model: model('xai', 'openai-responses', 'http://127.0.0.1:1/v1'), context })
    .then(() => assert.fail('a computer refresh failure answered'), (e: unknown) => e);
  assert.ok(failed instanceof ResponseError && failed.kind === 'network', 'a computer refresh failure is typed network');
  assert.deepEqual(seams.filter((s) => s === 'modify' || s === 'refresh'), ['modify'], 'Pi refreshed through its own seam');
  assert.ok(await store.read('xai'), 'the sign-in is kept on a computer');
  assert.ok((await accounts.list(1)).some((r) => r.id === 'grok'), 'the sign-in is still listed on a computer');
});

/** Kimi's token endpoint, which Pi's own refresh reaches on a computer through its `KIMI_CODE_OAUTH_HOST`: every refresh
 *  is answered with the configured status and body, and counted. */
async function fakeKimiAuth() {
  let answer = { status: 403, body: {} as object };
  let refreshes = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url === '/api/oauth/token' && body.includes('grant_type=refresh_token')) refreshes++;
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    answer: (status: number, body: object = {}) => { answer = { status, body }; },
    refreshes: () => refreshes,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

test('on a computer a bare 403, and separately a proven invalid_grant, at Pi\'s own refresh signs that account out and it is never refreshed again', async () => {
  const auth = await fakeKimiAuth();
  process.env.KIMI_CODE_OAUTH_HOST = auth.base;
  // A Kimi sign-in on the default computer platform, already due, as an earlier run of the app left it.
  const signedIn = () => {
    let data: any = {
      'kimi-coding': { type: 'oauth', access: 'kimi-access', refresh: 'kimi-refresh', expires: 0 },
      '.accounts': { names: {}, emails: {}, plans: {}, addedAt: { kimi: Date.now() }, defaults: {} },
    };
    const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
    const expired: string[] = [];
    const accounts = new Accounts<any, number>({ app: 'byokit journey', offer: ['kimi'], store: () => store });
    accounts.onExpired = (_m, key) => { expired.push(key); };
    return { store, accounts, expired };
  };
  const kimi = model('kimi-coding', 'anthropic-messages', 'http://127.0.0.1:1');
  try {
    for (const [why, status, body] of [['a bare 403', 403, {}], ['invalid_grant', 400, { error: 'invalid_grant', error_description: 'refresh token revoked' }]] as const) {
      auth.answer(status, body);
      const { store, accounts, expired } = signedIn();
      const before = auth.refreshes();
      const ended = await accounts.respond(1, { account: 'kimi', model: kimi, context }).then(() => assert.fail(`${why} answered`), (e: unknown) => e);
      assert.ok(ended instanceof ResponseError && ended.kind === 'signed_out', `${why} at refresh signs out, typed`);
      assert.equal(auth.refreshes(), before + 1, `${why}: Pi's own refresh reached the token endpoint once`);
      assert.equal(await store.read('kimi-coding'), undefined, `${why}: the sign-in is gone`);
      assert.deepEqual(await accounts.list(1), [], `${why}: the account left rotation`);
      assert.deepEqual(expired, ['kimi'], `${why}: onExpired says so once`);
      // A later respond and a later keepFresh find nothing to refresh: no second refresh is sent.
      await assert.rejects(accounts.respond(1, { account: 'kimi', model: kimi, context }));
      await accounts.keepFresh([1]);
      assert.equal(auth.refreshes(), before + 1, `${why}: never refreshed again`);
    }

    // keepFresh holds the same rule: a bare 403 at its refresh ends the sign-in, said once, and it is not tried again.
    auth.answer(403);
    const { store, accounts, expired } = signedIn();
    const sibling = { type: 'oauth' as const, access: 'sibling-access', refresh: 'sibling-refresh', expires: Date.now() + 400 * 86_400_000 };
    await store.modify('kimi.personal', async () => sibling);
    await store.index((i) => { i.defaults.account = 'kimi.personal'; });
    await accounts.status(1, 'kimi');
    const before = auth.refreshes();
    await accounts.keepFresh([1]);
    assert.equal(auth.refreshes(), before + 1, "keepFresh reached Pi's own refresh once");
    assert.deepEqual(expired, ['kimi'], 'keepFresh says the sign-in ended');
    assert.equal(await store.read('kimi-coding'), undefined, 'keepFresh deletes the exact rejected sign-in');
    assert.deepEqual(await store.read('kimi.personal'), sibling, 'the preferred sibling stays signed in');
    await assert.rejects(accounts.respond(1, { account: 'kimi', model: kimi, context }));
    await accounts.keepFresh([1]);
    const reopened = new Accounts<any, number>({ offer: ['kimi'], store: () => store });
    await assert.rejects(reopened.respond(1, { account: 'kimi', model: kimi, context }));
    await reopened.keepFresh([1]);
    assert.deepEqual((await reopened.list(1)).map((r) => r.id), ['kimi.personal']);
    assert.deepEqual(expired, ['kimi']);
    assert.equal(auth.refreshes(), before + 1, 'neither respond nor reconstruction retries the rejected sign-in');
  } finally {
    delete process.env.KIMI_CODE_OAUTH_HOST;
    await auth.close();
  }
});

test('on a computer Copilot catalog refusals keep the sign-in but token refusals end it across refresh callers', async () => {
  let tokenStatus = 200, catalogStatus = 403;
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url!);
    const token = req.url === '/copilot_internal/v2/token';
    res.writeHead(token ? tokenStatus : catalogStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(token ? { token: 'copilot-access', expires_at: Math.floor(Date.now() / 1000) + 7200 } : { data: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.ok(['api.github.com', 'api.individual.githubcopilot.com'].includes(url.hostname));
    return send(`${base}${url.pathname}`, init);
  };
  try {
    for (const action of ['respond', 'keepFresh', 'recheck'] as const) {
      tokenStatus = 200;
      catalogStatus = 403;
      let data: any = {
        'github-copilot': { type: 'oauth', access: 'old-access', refresh: 'github-refresh', expires: 0 },
        '.accounts': { names: {}, emails: {}, plans: {}, addedAt: { copilot: Date.now() }, defaults: {} },
      };
      const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
      const accounts = new Accounts<any, number>({ offer: ['copilot'], store: () => store });
      const expired: string[] = [];
      accounts.onExpired = (_member, key) => { expired.push(key); };
      const run = () => action === 'respond'
        ? accounts.respond(1, { account: 'copilot', model: model('github-copilot', 'openai-responses', base), context })
        : action === 'keepFresh' ? accounts.keepFresh([1]) : accounts.recheck(1, 'copilot');
      const before = paths.length;
      if (action === 'respond') await assert.rejects(run(), (e: unknown) => e instanceof ResponseError && e.kind === 'network');
      else assert.notEqual(await run(), false, `${action}: catalog refusal is nonterminal`);
      assert.deepEqual(paths.slice(before), ['/copilot_internal/v2/token', '/models']);
      assert.ok(await store.read('github-copilot'), `${action}: catalog refusal keeps the stored sign-in`);
      assert.deepEqual(expired, []);
      assert.deepEqual((await accounts.list(1)).map((r) => r.id), ['copilot']);
      catalogStatus = 200;
      const rt = await accounts.runtime(1, 'copilot');
      assert.ok(await rt.getAuth('github-copilot'), `${action}: ordinary refresh still succeeds`);
      await store.modify('github-copilot', async (c: any) => ({ ...c, expires: 0 }));
      tokenStatus = 403;
      const refusedAt = paths.length;
      if (action === 'respond') await assert.rejects(run(), (e: unknown) => e instanceof ResponseError && e.kind === 'signed_out');
      else if (action === 'recheck') assert.equal(await run(), false);
      else await run();
      assert.deepEqual(paths.slice(refusedAt), ['/copilot_internal/v2/token']);
      assert.equal(await store.read('github-copilot'), undefined, `${action}: token refusal deletes the sign-in`);
      const reopened = new Accounts<any, number>({ offer: ['copilot'], store: () => store });
      await reopened.keepFresh([1]);
      assert.deepEqual(await reopened.list(1), []);
      assert.equal(paths.length, refusedAt + 1);
    }
  } finally {
    globalThis.fetch = send;
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});
