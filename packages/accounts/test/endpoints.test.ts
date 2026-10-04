import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Accounts, ENDPOINT_PRESETS, EndpointError, memoryStore, recordStore, chooseAccount, resolveSelection, type EndpointModel } from '../src/index.ts';
import { Accounts as Portable } from '../src/portable.ts';
import type { Record as AccountRecord } from '../src/stores.ts';
import type { Keystore } from '@byokit/secrets';

const model: EndpointModel = { id: 'test-model', name: 'Test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 };
const canary = 'endpoint-key-CANARY-keep-on-device';
function keys() {
  const data = new Map<string, string>();
  const store: Keystore = { get: async (id) => data.get(id) ?? null, set: async (id, value) => { data.set(id, value); }, delete: async (id) => data.delete(id) };
  return { data, store };
}

test('selected endpoint billing survives restart regardless of host; Auto and Default refuse non-subscription rows', async () => {
  const stores = new Map<number, ReturnType<typeof memoryStore>>();
  const opts = { store: (m: number) => { if (!stores.has(m)) stores.set(m, memoryStore()); return stores.get(m)!; } };
  const kit = new Accounts(opts);
  for (const baseUrl of ['http://127.0.0.1:7777/v1', 'https://example.invalid/v1']) {
    for (const billing of ['api', 'local', 'unknown', 'subscription'] as const) {
      const { id } = await kit.endpoint(1, { baseUrl, compat: 'openai', billing, models: [model] });
      const restarted = new Accounts(opts);
      const row = (await restarted.list(1)).find((a) => a.id === id)!;
      assert.equal(row.billing, billing);
      assert.equal(row.state, 'ready');
      assert.equal(chooseAccount([row], () => ({ left: 'unknown' }), Date.now())?.account.id, billing === 'subscription' ? id : undefined);
      const picked = resolveSelection([row], { account: id }, { account: 'default' }, () => ({ left: 'unknown' }), Date.now());
      assert.equal(picked.ok, billing === 'subscription');
      assert.equal(resolveSelection([row], {}, { account: id }, () => ({ left: 'unknown' }), Date.now()).ok, true);
      if (billing === 'api') assert.match(row.label, /Charged per use/);
      await restarted.remove(1, id);
    }
  }
  for (const preset of Object.values(ENDPOINT_PRESETS)) {
    const { id } = await kit.endpoint(1, preset);
    assert.equal((await kit.list(1)).find((a) => a.id === id)!.billing, 'local');
    await kit.remove(1, id);
  }
  await assert.rejects(kit.endpoint(1, { baseUrl: 'http://127.0.0.1', compat: 'openai' } as any), /billing explicitly/);
  for (const baseUrl of ['file:///tmp/model', `http://${canary}@localhost/v1`, `https://example.invalid?key=${canary}`]) {
    await assert.rejects(kit.endpoint(1, { baseUrl, compat: 'openai', billing: 'unknown' }), (e: Error) => !e.message.includes(canary));
  }
});

test('browser/RN loopback needs_host before any credentials, including restored rows', async () => {
  const store = memoryStore();
  const kit = new Accounts({ store: () => store });
  const { id } = await kit.endpoint(1, { baseUrl: 'http://127.0.0.1:7777/v1', compat: 'openai', billing: 'api' });
  let secretReads = 0;
  const portable = new Portable({ store: () => store, keyStore: () => { secretReads++; throw new Error(canary); }, endpointDriver: () => { throw new Error('driver must not run'); } });
  assert.equal(await portable.endpointReadiness(1, id), 'needs_host');
  assert.equal((await portable.list(1))[0].readiness, 'needs_host');
  assert.equal((await portable.status(1, id)).state, 'not_included');
  assert.equal(await portable.signedIn(1, id), false);
  for (const baseUrl of ['http://localhost/v1', 'http://127.9.8.7/v1', 'http://[::1]/v1']) {
    await assert.rejects(portable.endpoint(1, { baseUrl, compat: 'openai', billing: 'api', key: canary }), (e: unknown) => e instanceof EndpointError && e.readiness === 'needs_host');
  }
  await assert.rejects(portable.endpointRuntime(1, id), (e: unknown) => e instanceof EndpointError && e.readiness === 'needs_host');
  assert.equal(secretReads, 0);
});

test('pinned Pi endpoint streams both protocols against loopback; keys/member registrations never escape', async () => {
  const requests: { url: string; authorization?: string; key?: string; body: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url!, authorization: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (new URL(req.url!, 'http://fixture').pathname.endsWith('/messages')) {
      for (const event of [
        { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello endpoint' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello endpoint' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: 'chat_1', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\ndata: [DONE]\n\n`);
    }
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  let data: AccountRecord = {};
  const store = recordStore(async () => structuredClone(data), async (d) => { data = d; });
  const a = keys(), b = keys();
  const kit = new Accounts({ store: (m: number) => m === 1 ? store : memoryStore(), keyStore: (m) => m === 1 ? a.store : b.store });
  try {
    for (const compat of ['openai', 'anthropic'] as const) {
      const { id } = await kit.endpoint(1, { baseUrl: compat === 'openai' ? `${base}/v1` : base, compat, billing: 'api', key: canary, models: [model] });
      assert.equal(requests.length, compat === 'openai' ? 0 : 1); // Add and listing never contact the endpoint.
      const rt = await kit.endpointRuntime(1, id);
      const selected = rt.getModel(id, model.id)!;
      const answer = await rt.completeSimple(selected, { messages: [{ role: 'user', content: 'hello', timestamp: Date.now() }] });
      assert.equal(answer.stopReason, 'stop', answer.errorMessage);
      assert.equal(answer.content[0].type, 'text');
      assert.equal((answer.content[0] as { text: string }).text, 'hello endpoint');
      assert.equal(requests.at(-1)!.body.model, 'test-model');
      assert.equal(compat === 'openai' ? requests.at(-1)!.authorization : requests.at(-1)!.key, compat === 'openai' ? `Bearer ${canary}` : canary);
      assert.equal((await kit.list(1)).find((row) => row.id === id)!.billing, 'api');
      assert.equal(JSON.stringify(data).includes(canary), false);
      assert.equal(JSON.stringify(await kit.list(1)).includes(canary), false);
      assert.equal(JSON.stringify(await kit.status(1, id)).includes(canary), false);
      assert.equal(await (await kit.runtime(1)).getAuth(id), undefined);
      await assert.rejects(kit.endpointRuntime(2, id), (e: Error) => !e.message.includes(canary));
      assert.throws(() => rt.streamSimple({ ...selected, baseUrl: 'https://example.invalid' }, { messages: [] }), /this endpoint account/);
      assert.equal(b.data.size, 0);
      await kit.rename(1, id, 'Selected endpoint');
      assert.equal((await kit.list(1)).find((a) => a.id === id)!.name, 'Selected endpoint');
      await kit.logout(1, id);
      assert.equal((await kit.status(1, id)).state, 'signed_out');
      assert.equal(a.data.size, 0);
      await assert.rejects(rt.getAuth(id), (e: Error) => !e.message.includes(canary));
      await kit.remove(1, id);
      await assert.rejects(kit.endpointRuntime(1, id), EndpointError);
    }
    const broken = new Accounts({ keyStore: () => { throw new Error(canary); } });
    await assert.rejects(broken.endpoint(1, { baseUrl: base, compat: 'openai', billing: 'api', key: canary }), (e: Error) => !e.message.includes(canary));
    assert.equal(requests.length, 2);
  } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); }
});
