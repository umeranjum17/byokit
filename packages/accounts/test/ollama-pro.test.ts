// Ollama Pro plan-key route: shared secrets seam, catalogue offer, loopback chat. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Keystore } from '@byokit/secrets';
import { Accounts, computer, memoryStore, ResponseError, type Context, type Model } from '../src/index.ts';
import { offered, planKey, provider, route, signInChoices } from '../src/catalogue.ts';
import { portable } from '../src/accounts.ts';
import {
  OLLAMA_PRO_BASE_URL, OLLAMA_PRO_PLAN_ROUTE,
  ollamaProChat, ollamaProPlanAccount, ollamaProPlanKeyEntry,
  readOllamaProPlanKey, saveOllamaProPlanKey, deleteOllamaProPlanKey,
} from '../src/ollama-pro.ts';

const CANARY = 'canary-ollama-pro-plan-key-9f2a';
const leak = (text: string) => assert.ok(!text.includes(CANARY), 'canary must never appear in public text');

function memoryKeys() {
  const saved = new Map<string, string>();
  const store: Keystore = {
    get: async (name) => saved.get(name) ?? null,
    set: async (name, secret) => { saved.set(name, secret); },
    delete: async (name) => saved.delete(name),
  };
  return { store, saved };
}

function local() {
  const saved = new Map<string, string>();
  return new Accounts({ store: () => memoryStore(), keyStore: () => ({
    get: async (id: string) => saved.get(id) ?? null,
    set: async (id: string, value: string) => { saved.set(id, value); },
    delete: async (id: string) => saved.delete(id),
    list: async () => [],
  }) });
}

test('a consumer resolves ollama-pro from the engine and calls it through a loopback stub, no alias', async () => {
  const accounts = local();
  const { id } = await accounts.add('Umer', OLLAMA_PRO_PLAN_ROUTE, { key: CANARY });
  const engine = computer.engine(memoryStore() as never) as unknown as { getModel(provider: string, id: string): Model<'openai-completions'> | undefined };
  const model = engine.getModel('ollama-pro', 'deepseek-v4.1-flash');
  assert.ok(model, 'engine.getModel answers ollama-pro with no per-project alias');
  assert.deepEqual([model.provider, model.api, model.baseUrl], ['ollama-pro', 'openai-completions', OLLAMA_PRO_BASE_URL]);
  const seen: { path?: string; auth?: string; body?: { model: string; stream?: boolean; messages: unknown[] } } = {};
  const server = createServer((req, res) => {
    seen.path = req.url; seen.auth = req.headers.authorization;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.body = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'stub', choices: [{ index: 0, delta: { role: 'assistant', content: 'pong-from-stub' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'stub', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    let requested = '';
    const result = await accounts.respondKey('Umer', {
      account: id, model, context: { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] },
      options: { fetch: async (input, init) => {
        requested = String(input);
        return fetch(requested.replace('https://ollama.com', `http://127.0.0.1:${port}`), init);
      } },
    });
    assert.equal(requested, `${OLLAMA_PRO_BASE_URL}/chat/completions`);
    assert.equal(seen.path, '/v1/chat/completions');
    assert.equal(seen.auth, `Bearer ${CANARY}`);
    assert.equal(seen.body?.model, 'deepseek-v4.1-flash');
    assert.equal(seen.body?.stream, true);
    assert.equal(result.stopReason, 'stop');
    assert.deepEqual(result.content, [{ type: 'text', text: 'pong-from-stub' }]);
    assert.ok(!JSON.stringify(result).includes(CANARY));
  } finally { server.close(); server.closeAllConnections(); }
});

test('ollamaProChat hits a loopback fake; canary stays out of argv, env, logs and errors', async () => {
  const { store } = memoryKeys();
  await saveOllamaProPlanKey(store, CANARY);
  const seen: { auth?: string; model?: string; env: NodeJS.ProcessEnv; argv: string[] } = {
    env: { ...process.env }, argv: [...process.argv],
  };
  const server = createServer((req, res) => {
    seen.auth = req.headers.authorization;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.model = (JSON.parse(body) as { model?: string }).model;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'hello-from-fake' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  try {
    const text = await ollamaProChat({ store, prompt: 'ping', model: 'deepseek-v4.1-flash', baseUrl: `http://127.0.0.1:${port}/v1` });
    assert.equal(text, 'hello-from-fake');
    assert.equal(seen.auth, `Bearer ${CANARY}`);
    assert.equal(seen.model, 'deepseek-v4.1-flash');
    assert.ok(!JSON.stringify(seen.argv).includes(CANARY) && !JSON.stringify(seen.env).includes(CANARY));
    leak(text);
    await assert.rejects(ollamaProChat({ store, prompt: 'x', model: 'deepseek-v4.1-flash', baseUrl: `http://127.0.0.1:${port}/v1`,
      fetch: async () => new Response('denied', { status: 401 }) }), (e: unknown) => {
      assert.ok(e instanceof Error);
      leak(e.message);
      assert.match(e.message, /http 401/);
      return true;
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
  await deleteOllamaProPlanKey(store);
  await assert.rejects(ollamaProChat({ store, prompt: 'x', model: 'deepseek-v4.1-flash', baseUrl: 'http://127.0.0.1:9/v1' }), (e: unknown) => {
    assert.ok(e instanceof Error && e.message === 'Add the Ollama Pro plan key first.');
    leak(e.message);
    return true;
  });
});
