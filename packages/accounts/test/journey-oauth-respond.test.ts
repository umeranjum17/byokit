// A consumer's own journey against the built @byokit/accounts: one person signs in to two Grok accounts by device code
// (the kit's mockDevice stand-in) and asks each one through the pinned Pi Models path. Every import is a published entry
// (`.`, `/keys`, `/testing`). A loopback stand-in for xAI's Responses endpoint replays fixtures/conformance/pi-streams.json
// and records the bearer each request carried. A 429 rests only the account that got it, typed and never retried, while
// the other still answers; a refresh the provider proves revoked or refuses with a bare 400-403 signs only that account
// out, while a 5xx or a dropped connection keeps the sign-in, typed network. No account and no real network.
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
