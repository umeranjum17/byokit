// Ollama Pro plan-key route: shared secrets seam, catalogue offer, loopback chat. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Keystore } from '@byokit/secrets';
import { Accounts, memoryStore, ResponseError, type Context, type Model } from '../src/index.ts';
import { offered, planKey, provider, route, signInChoices } from '../src/catalogue.ts';
import { portable } from '../src/accounts.ts';
import {
  OLLAMA_PRO_BASE_URL, OLLAMA_PRO_DEFAULT_MODEL, OLLAMA_PRO_PLAN_ROUTE,
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

test('catalogue offers Ollama Pro as a pasted plan key with deepseek-v4.1-flash', () => {
  const p = provider('ollama-pro');
  assert.deepEqual([p.pi, p.name, p.company, p.billing, p.auth], ['ollama-pro', 'Ollama Pro', 'Ollama', 'subscription', 'api-key']);
  assert.equal(p.models.strong, OLLAMA_PRO_DEFAULT_MODEL);
  assert.deepEqual(p.routes, [OLLAMA_PRO_PLAN_ROUTE]);
  assert.equal(OLLAMA_PRO_BASE_URL, 'https://ollama.com/v1');
  assert.ok(offered().some((q) => q.key === 'ollama-pro'));
  assert.ok(!signInChoices().some((q) => q.key === 'ollama-pro'));
  assert.equal(planKey('ollama-pro'), true);
  const r = route(OLLAMA_PRO_PLAN_ROUTE, { platform: 'browser' });
  assert.deepEqual([r.readiness, r.billing, r.offer], ['ready', 'subscription', 'default']);
  assert.deepEqual([r.upstream.id, r.upstream.method, r.upstream.flow, r.aliases], ['ollama-pro', 'OLLAMA_API_KEY', 'present', ['ollama-cloud']]);
});

test('respondKey streams openai-completions to ollama.com/v1 with the plan key header (fake fetch)', async () => {
  const accounts = local();
  const { id } = await accounts.add('Umer', OLLAMA_PRO_PLAN_ROUTE, { key: CANARY });
  const model: Model<'openai-completions'> = {
    id: OLLAMA_PRO_DEFAULT_MODEL, name: 'DeepSeek', provider: 'ollama-pro', api: 'openai-completions',
    baseUrl: OLLAMA_PRO_BASE_URL, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192,
  };
  const context: Context = { messages: [{ role: 'user', content: 'ping', timestamp: 0 }] };
  const openaiEvents = [
    { id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] },
    { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
  ];
  let hit = '';
  const result = await accounts.respondKey('Umer', {
    account: id, model, context,
    options: {
      fetch: async (input, init) => {
        hit = String(input);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), `Bearer ${CANARY}`);
        leak(hit);
        return new Response(
          openaiEvents.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        );
      },
    },
  });
  assert.equal(hit, `${OLLAMA_PRO_BASE_URL}/chat/completions`);
  assert.equal(result.stopReason, 'stop');
  assert.ok(!JSON.stringify(result).includes(CANARY));
});

test('plan-key seam and member handle: Map store, canary never in error words', async () => {
  const { store, saved } = memoryKeys();
  assert.equal(ollamaProPlanKeyEntry(), `accounts.${OLLAMA_PRO_PLAN_ROUTE}`);
  const handle = ollamaProPlanAccount(store);
  assert.equal(handle.provider, 'ollama-pro');
  await assert.rejects(handle.access(new AbortController().signal), (e: unknown) => {
    assert.ok(e instanceof Error && e.message === 'Add the Ollama Pro plan key first.');
    leak(e.message);
    return true;
  });
  await saveOllamaProPlanKey(store, CANARY);
  assert.deepEqual([...saved], [[`accounts.${OLLAMA_PRO_PLAN_ROUTE}`, CANARY]]);
  assert.equal(await readOllamaProPlanKey(store), CANARY);
  assert.equal(await handle.access(new AbortController().signal), CANARY);

  const accounts = local();
  const { id } = await accounts.add('Umer', OLLAMA_PRO_PLAN_ROUTE, { key: CANARY });
  assert.ok(id.startsWith(`${OLLAMA_PRO_PLAN_ROUTE}.`));
  assert.equal(await accounts.ollamaPro('Umer').access(new AbortController().signal), CANARY);
  const other = local();
  await other.add('Luis', OLLAMA_PRO_PLAN_ROUTE, { key: 'luis-ollama-plan-key' });
  assert.equal(await other.ollamaPro('Luis').access(new AbortController().signal), 'luis-ollama-plan-key');
  await assert.rejects(other.ollamaPro('Umer').access(new AbortController().signal),
    (e) => e instanceof ResponseError && e.kind === 'signed_out');
  const portableKit = new Accounts({ store: () => memoryStore(), keyStore: () => memoryKeys().store }, portable);
  assert.ok(portableKit.providers.some((q) => q.key === 'ollama-pro'));
  assert.equal((await portableKit.status(1, 'ollama-pro')).state, 'signed_out');

  await deleteOllamaProPlanKey(store);
  assert.deepEqual([...saved], []);
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
    const text = await ollamaProChat({ store, prompt: 'ping', baseUrl: `http://127.0.0.1:${port}/v1` });
    assert.equal(text, 'hello-from-fake');
    assert.equal(seen.auth, `Bearer ${CANARY}`);
    assert.equal(seen.model, OLLAMA_PRO_DEFAULT_MODEL);
    assert.ok(!JSON.stringify(seen.argv).includes(CANARY) && !JSON.stringify(seen.env).includes(CANARY));
    leak(text);
    await assert.rejects(ollamaProChat({ store, prompt: 'x', baseUrl: `http://127.0.0.1:${port}/v1`,
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
  await assert.rejects(ollamaProChat({ store, prompt: 'x', baseUrl: 'http://127.0.0.1:9/v1' }), (e: unknown) => {
    assert.ok(e instanceof Error && e.message === 'Add the Ollama Pro plan key first.');
    leak(e.message);
    return true;
  });
});
