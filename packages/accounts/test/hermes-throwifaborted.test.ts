// Hermes (React Native) ships AbortSignal.any/timeout/fetch but not AbortSignal.prototype.throwIfAborted, so every
// bundled Pi auth resolution used to throw TypeError before any fetch and key routes answered KeyRouteError('request').
// This drives the BUILT portable/browser entry with that method removed — the only difference from a Node host — over a
// local OpenAI-compatible stand-in, and proves the answer streams on Hermes. The aborted case is the Accounts pre-check
// (an already-aborted signal is refused before the portable runtime loads), not the bundled guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Accounts, portable, memoryStore } from '../dist/portable.js';
import { withKeys } from '../dist/keys.js';
import type { Api, Context, Model } from '@earendil-works/pi-ai';
import type { Keystore } from '@byokit/secrets';

const canary = 'sk-hermes-fixture-not-a-real-key';
function fakeSecrets(): Keystore {
  const data = new Map<string, string>();
  return { get: async (id) => data.get(id) ?? null, set: async (id, value) => { data.set(id, value); }, delete: async (id) => data.delete(id) };
}

const openaiEvents = [
  { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
  { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } },
];
function sse(events: unknown[]) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
}
async function openaiCompatible() {
  const seen: string[] = [];
  const server = createServer(async (req, res) => {
    seen.push(String(req.url));
    for await (const _ of req) { /* drain the request body */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse(openaiEvents));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}/v1`, seen, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }) };
}
const model = (baseUrl: string): Model<Api> => ({ id: 'hermes-fixture', name: 'Hermes Fixture', provider: 'openrouter', api: 'openai-completions',
  baseUrl, reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
const context: Context = { messages: [{ role: 'user', content: 'hello there', timestamp: 0 }] };

// A Hermes runtime: the method is absent while the rest of AbortSignal is intact.
async function withoutThrowIfAborted<T>(run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'throwIfAborted');
  Reflect.deleteProperty(AbortSignal.prototype, 'throwIfAborted');
  try {
    assert.equal(typeof new AbortController().signal.throwIfAborted, 'undefined', 'Hermes simulation: the method is gone');
    return await run();
  } finally {
    if (original) Object.defineProperty(AbortSignal.prototype, 'throwIfAborted', original);
  }
}

test('built key route streams on a runtime without AbortSignal.prototype.throwIfAborted (Hermes)', async () => {
  const server = await openaiCompatible();
  try {
    const secrets = fakeSecrets();
    const accounts = new Accounts({ store: () => memoryStore(), keyStore: () => secrets }, withKeys(portable));
    const { id } = await accounts.add('umer', 'openrouter:key', { key: canary });
    let text = '';
    const answer = await withoutThrowIfAborted(() => accounts.respondKey('umer', { account: id, model: model(server.base), context,
      options: { maxTokens: 64, fetch: globalThis.fetch }, onText: (delta) => { text += delta; } }));
    assert.equal(answer.stopReason, 'stop', answer.errorMessage);
    assert.equal(text, 'Hello');
    assert.deepEqual([answer.usage.input, answer.usage.output, answer.usage.totalTokens], [3, 2, 5]);
    assert.equal(server.seen.length, 1, 'one request reached the stand-in');
    assert.ok(server.seen[0].endsWith('/chat/completions'), server.seen[0]);
  } finally {
    await server.close();
  }
});

test('an already-aborted key route is refused before any request on a runtime without throwIfAborted', async () => {
  const server = await openaiCompatible();
  try {
    const secrets = fakeSecrets();
    const accounts = new Accounts({ store: () => memoryStore(), keyStore: () => secrets }, withKeys(portable));
    const { id } = await accounts.add('umer', 'openrouter:key', { key: canary });
    const abort = new AbortController();
    abort.abort();
    await withoutThrowIfAborted(async () => {
      await assert.rejects(accounts.respondKey('umer', { account: id, model: model(server.base), context,
        options: { signal: abort.signal, fetch: globalThis.fetch } }), { code: 'aborted' });
    });
    assert.equal(server.seen.length, 0, 'an aborted route dispatches nothing');
  } finally {
    await server.close();
  }
});
