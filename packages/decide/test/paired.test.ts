import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LinkError, type Grant, type LinkRequest } from '@byokit/link';
import { decide, jevHost, pairedJev, PairedHostError, UnsupportedImagesError, PAIRED_JEV_OP, type Question, type PairedJevLink } from '../src/index.ts';
import { startHost, connect, pairWithOffer, until } from '../../link/test/helpers.ts';

const device: Grant = { id: 'umer-phone', key: 'public-device-key', name: 'Umer', role: 'control', created: 1 };
const questions: Record<string, Question> = {
  urgent: { kind: 'yesno', question: 'Urgent?', floor: 0.8 },
  intent: { kind: 'choice', options: { task: 'New task', chat: 'Conversation' }, floors: { task: 0.95, chat: 0.05 } },
  tone: { kind: 'score', levels: ['Calm', 'Urgent'] },
};
const state = { name: 'Umer', text: 'The roof is leaking' };
const signal = () => new AbortController().signal;
const request = (qs: unknown = questions): LinkRequest => ({ op: PAIRED_JEV_OP, args: { v: 1, state, questions: qs } });
const billing = 'api-key-billed-per-use' as const;
const errorCode = (code: string) => (e: unknown) => e instanceof PairedHostError && e.code === code && !('cause' in e);
function fakeFetch(body: unknown): typeof fetch { return async () => Response.json(body); }
function linkFor(handle: ReturnType<typeof jevHost>): PairedJevLink {
  return { status: 'online', request: async (op, args) => JSON.parse(JSON.stringify(await handle({ op, args }, device))) };
}
const providerReply = { answers: {
  urgent: { noul: 0.9 }, intent: { choice: 'task', confidence: 0.9, probabilities: { task: 0.9, chat: 0.1 } },
  tone: { confidence: 0.8, probabilities: { '0': 0.2, '1': 0.8 } },
}, usage: { input_tokens: 12, output_tokens: 3 } };

test('fake link + fake Jev: host owns the key and route; phone applies floors and keeps usage', async () => {
  let calls = 0;
  const secret = 'fake-private-host-value';
  const host = jevHost({ billing, via: 'openrouter', keys: { get: (grant, via) => {
    assert.equal(grant, device); assert.equal(via, 'openrouter'); return secret;
  } }, fetch: async (url, init) => {
    calls++;
    assert.equal(url, 'https://openrouter.ai/api/v1/systemone');
    // Compare privately; failed assertions must not print the key.
    assert.ok((init!.headers as Record<string, string>).authorization === `Bearer ${secret}`);
    assert.ok(!String(init!.body).includes(secret));
    const body = JSON.parse(String(init!.body));
    assert.equal(body.state.name, 'Umer');
    assert.equal(body.questions.urgent.type, 'noul');
    return Response.json({ ...providerReply, private: secret, token: secret });
  } });
  let sent: unknown;
  let received: unknown;
  const link: PairedJevLink = { status: 'online', request: async (op, args, options) => {
    sent = args;
    assert.equal(op, PAIRED_JEV_OP);
    assert.equal(options!.timeoutMs, 30_000);
    assert.ok(options!.notValidAfter! > Date.now());
    received = await host({ op, args }, device);
    return JSON.parse(JSON.stringify(received));
  } };
  const result = await decide(state, questions, { privacy: 'may-leave', backends: [pairedJev({ link })] });
  assert.equal(result.urgent.answer, true);
  assert.equal(result.intent.answer, 'chat', 'per-option floor and runner-up remain device-side');
  assert.equal(result.tone.answer, 1);
  assert.deepEqual(result.urgent.usage, { input_tokens: 12, output_tokens: 3 });
  assert.equal(result.urgent.by, 'jev-paired');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify({ sent, received, result }).includes(secret));
  assert.equal(result.urgent.raw, undefined);
});

test('not paired, removed and offline throw typed errors through decide and never send', async () => {
  let sent = 0;
  for (const [status, code] of [[null, 'not-paired'], ['removed', 'not-paired'], ['offline', 'host-offline'], ['connecting', 'host-offline'], ['refused', 'not-allowed']] as const) {
    const link = status === null ? null : { status, request: async () => { sent++; } };
    await assert.rejects(decide(state, questions, { privacy: 'may-leave', backends: [pairedJev({ link })] }), errorCode(code));
  }
  assert.equal(sent, 0);
});

test('missing key is typed through decide; opt-in and withdrawal prevent key lookup and billing', async () => {
  let lookups = 0, calls = 0;
  const keys = { get: () => { lookups++; return null; } };
  const fetch: typeof globalThis.fetch = async () => { calls++; throw new Error('must not fetch'); };
  assert.throws(() => jevHost({ keys, fetch } as any), errorCode('disabled'));
  const missing = jevHost({ billing, keys, fetch });
  await assert.rejects(decide(state, questions, { privacy: 'may-leave', backends: [pairedJev({ link: linkFor(missing) })] }), errorCode('key-missing'));
  assert.equal(lookups, 1);
  const disabled = jevHost({ billing, keys, fetch, enabled: () => false });
  await assert.rejects(pairedJev({ link: linkFor(disabled) }).ask(state, questions, signal()), errorCode('disabled'));
  assert.equal(lookups, 1);
  assert.equal(calls, 0);
});

test('transport failures map by code and discard arbitrary error messages', async () => {
  const secret = 'fake-transport-private-value';
  for (const [code, expected] of [['timeout', 'host-offline'], ['unreachable', 'host-offline'], ['stopped', 'host-offline'], ['not-paired', 'not-paired'], ['ended', 'not-paired'], ['view-only', 'not-allowed'], ['not-allowed', 'not-allowed'], ['failed', 'request-failed']] as const) {
    const link: PairedJevLink = { status: 'online', request: async () => { const e = new LinkError(code); e.message = secret; throw e; } };
    await assert.rejects(pairedJev({ link }).ask(state, questions, signal()), (e: unknown) => errorCode(expected)(e) && !String(e).includes(secret));
  }
  for (const reply of [null, { v: 2, ok: true }, { v: 1, ok: true }, { v: 1, ok: false, error: secret, message: secret }]) {
    await assert.rejects(pairedJev({ link: { status: 'online', request: async () => reply } }).ask(state, questions, signal()), errorCode('request-failed'));
  }
});

test('provider and key-store exceptions are redacted values, never thrown to Host.onError', async () => {
  const secret = 'fake-storage-private-value';
  for (const opts of [
    { keys: { get: () => { throw new Error(secret); } }, fetch: fakeFetch(providerReply) },
    { keys: { get: () => secret }, fetch: async () => { throw new Error(secret); } },
    { keys: { get: () => secret }, fetch: async () => { const res = Response.json({}); res.json = async () => { throw new Error(secret); }; return res; } },
  ]) {
    const host = jevHost({ billing, ...opts });
    const reply = await host(request(), device);
    assert.deepEqual(reply, { v: 1, ok: false, error: 'request-failed' });
    assert.ok(!JSON.stringify(reply).includes(secret));
  }
});

test('provider echo, arbitrary fields, picks and malformed confidence never escape or become valid answers', async () => {
  const secret = 'fake-provider-private-value';
  for (const bad of [
    { choice: secret, confidence: 0.9, probabilities: { task: 0.9, chat: 0.1 } },
    { choice: 'task', confidence: 7, probabilities: { task: 0.9, chat: 0.1 } },
    { choice: 'task', confidence: 0.9, probabilities: { task: 0.9, chat: 0.1, [secret]: 0 } },
    { choice: 'task', confidence: 0.9, probabilities: { task: secret, chat: 0.1 } },
  ]) {
    const host = jevHost({ billing, keys: { get: () => secret }, fetch: fakeFetch({ answers: { intent: bad }, private: secret }) });
    const result = await decide(state, { intent: questions.intent }, { privacy: 'may-leave', backends: [pairedJev({ link: linkFor(host) })] });
    assert.equal(result.intent.abstained, true);
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test('bad requests and device-supplied credentials or routes never reach key lookup', async () => {
  let lookups = 0;
  const host = jevHost({ billing, keys: { get: () => { lookups++; return 'fake'; } } });
  const invalid = [null, {}, [], { urgent: { kind: 'other' } }, { urgent: { kind: 'choice', options: {} } },
    { urgent: { kind: 'score', levels: [] } }, { urgent: { kind: 'yesno', question: 2 } },
    { urgent: { kind: 'yesno', question: 'Urgent?', key: 'fake' } },
    { urgent: { kind: 'yesno', question: 'Urgent?', floor: -1 } },
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), questions.urgent]))];
  for (const qs of invalid) assert.deepEqual(await host(request(qs), device), { v: 1, ok: false, error: 'invalid-request' });
  for (const extra of [{ key: 'fake' }, { via: 'openrouter' }, { config: {} }, { v: 2 }]) {
    assert.deepEqual(await host({ op: PAIRED_JEV_OP, args: { v: 1, state, questions, ...extra } }, device), { v: 1, ok: false, error: 'invalid-request' });
  }
  assert.deepEqual(await host({ ...request(), op: 'other' }, device), { v: 1, ok: false, error: 'invalid-request' });
  assert.equal(lookups, 0);
});

test('stays-here skips pairing and billing; aborted asks never send', async () => {
  let sent = 0;
  const link: PairedJevLink = { status: 'online', request: async () => { sent++; return new Promise(() => {}); } };
  const backend = pairedJev({ link });
  const answer = await decide(state, questions, { privacy: 'stays-here', backends: [backend] });
  assert.equal(answer.urgent.abstained, true);
  assert.equal(sent, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(backend.ask(state, questions, controller.signal), errorCode('cancelled'));
  assert.equal(sent, 0);
  const pending = new AbortController();
  const ask = backend.ask(state, questions, pending.signal);
  pending.abort();
  await assert.rejects(ask, errorCode('cancelled'));
});

test('host deadline aborts the fake provider and bounds providers that ignore abort', async () => {
  let aborted = false;
  const host = jevHost({ billing, timeoutMs: 10, keys: { get: () => 'fake' }, fetch: async (_url, init) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } });
  assert.deepEqual(await host(request(), device), { v: 1, ok: false, error: 'request-failed' });
  assert.equal(aborted, true);
});

test('real link pairing and grant policy surround the fake billed provider', async () => {
  let calls = 0, lookups = 0;
  const handler = jevHost({ billing, keys: { get: () => { lookups++; return 'fake-host-only'; } }, fetch: async () => { calls++; return Response.json(providerReply); } });
  const h = await startHost({ handle: handler, name: 'Umer computer' });
  const grant = await pairWithOffer(h.host.offer({ urls: [h.url], role: 'control' }).text, { name: 'Umer' });
  const { link } = connect(grant);
  await until(() => link.status === 'online');
  const answer = await decide(state, questions, { privacy: 'may-leave', backends: [pairedJev({ link })] });
  assert.equal(answer.urgent.answer, true);
  assert.equal(calls, 1);
  const viewGrant = await pairWithOffer(h.host.offer({ urls: [h.url], role: 'view' }).text, { name: 'Umer' });
  const viewer = connect(viewGrant).link;
  await until(() => viewer.status === 'online');
  await assert.rejects(pairedJev({ link: viewer }).ask(state, questions, signal()), errorCode('not-allowed'));
  assert.equal(lookups, 1, 'link policy denies before key lookup');
  await h.host.revoke(grant.device.id);
  await until(() => link.status === 'removed');
  await assert.rejects(pairedJev({ link }).ask(state, questions, signal()), errorCode('not-paired'));
  assert.equal(calls, 1);
  assert.deepEqual(h.errors, []);
});


test('paired Jev preserves text-only image refusal through decide and direct backend calls', async () => {
  let sent = 0;
  const backend = pairedJev({ link: { status: 'online', request: async () => { sent++; } } });
  const images = [{ id: 'reference', mime: 'image/png', dataUrl: 'data:image/png;base64,AQ==' }];
  await assert.rejects(backend.ask(state, questions, signal(), images), UnsupportedImagesError);
  await assert.rejects(decide(state, questions, { privacy: 'may-leave', backends: [backend], images }), UnsupportedImagesError);
  assert.equal(sent, 0);
  const host = jevHost({ billing, keys: { get: () => 'fake' }, fetch: fakeFetch(providerReply) });
  const emptyReferences = { urgent: { ...questions.urgent, images: [] } };
  const result = await decide(state, emptyReferences, { privacy: 'may-leave', backends: [pairedJev({ link: linkFor(host) })] });
  assert.equal(result.urgent.answer, true);
});
