// Shared cold-Metro and strict packed-consumer probe. Only web globals; vendors are synthetic SSE fixtures.
import { Accounts, recordStore, route, KeyRouteError, portable } from '@byokit/accounts';
import fixture from './pi-streams.json' with { type: 'json' };
const canary = 'B2-packed-cold-canary-987654321';
const model = (provider, api) => ({ id: 'fixture-model', name: 'Fixture', provider, api, baseUrl: 'https://fixture.invalid/v1',
  reasoning: false, input: ['text'], cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 128 });
function sse(api) {
  const family = fixture.families[fixture.adapters[api]];
  return new Response(family.events.map((event) => `${family.named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (family.done ? 'data: [DONE]\n\n' : ''),
    { headers: { 'content-type': 'text/event-stream' } });
}
function harness() {
  let data = {}; const keys = new Map();
  const store = recordStore(async () => structuredClone(data), async (next) => { data = structuredClone(next); });
  return new Accounts({ store: () => store, keyStore: () => ({ get: async (id) => keys.get(id) ?? null,
    set: async (id, value) => { keys.set(id, value); }, delete: async (id) => keys.delete(id) }) });
}
async function run() {
  const out = {};
  for (const [routeId, api] of [['groq:key', 'openai-completions'], ['kimi-code:plan_key', 'anthropic-messages']]) {
    const accounts = harness(); const { id } = await accounts.add('m', routeId, { key: canary });
    let text = ''; const events = []; let body; let sends = 0; let selected = false; let shadowed = false; let nonAuth = false; let payloads = 0; let responses = 0;
    const shadow = { AUTHORIZATION: 'Bearer not-selected', 'X-Api-Key': 'not-selected', 'Api-Key': 'not-selected', 'X-Goog-Api-Key': 'not-selected', 'CF-AIG-Authorization': 'not-selected' };
    const answer = await accounts.respond('m', { account: id, model: { ...model(route(routeId).upstream.id, api), headers: shadow }, context: fixture.context,
      options: { temperature: 0.4, apiKey: 'not-selected', maxRetries: 9, headers: { ...shadow, 'x-app': 'explicit' },
        onPayload: () => { payloads++; }, onResponse: () => { responses++; }, fetch: async (_input, init) => {
        sends++; body = JSON.parse(String(init.body)); const headers = new Headers(init.headers);
        selected = headers.get('authorization')?.includes(canary) || headers.get('x-api-key') === canary;
        nonAuth = headers.get('x-app') === 'explicit';
        headers.forEach((value) => { if (value.includes('not-selected')) shadowed = true; });
        return sse(api);
      } }, onText: (delta) => { text += delta; }, onEvent: (event) => events.push(event.type) });
    out[api] = { text, stop: answer.stopReason, usage: [answer.usage.input, answer.usage.output, answer.usage.totalTokens],
      tools: answer.content.filter((c) => c.type === 'toolCall').map((c) => ({ name: c.name, arguments: c.arguments })),
      events: [...new Set(events)], temperature: body.temperature, sentTools: body.tools.length, sends, selected, shadowed, nonAuth, payloads, responses,
      leaked: JSON.stringify(answer).includes(canary) };
  }
  const accounts = harness(); const { id } = await accounts.add('m', 'groq:key', { key: canary }); const abort = new AbortController();
  try {
    await accounts.respond('m', { account: id, model: model('groq', 'openai-completions'), context: fixture.context,
      options: { signal: abort.signal, fetch: async () => { abort.abort(); throw Object.assign(new Error(canary), { name: 'AbortError' }); } } });
    out.abort = 'unexpected success';
  } catch (e) { out.abort = e instanceof KeyRouteError ? e.code : 'wrong error type'; }
  let reads = 0;
  const isolated = new Accounts({ keyStore: () => { reads++; throw new Error(canary); } });
  try { await isolated.respond('m', { account: 'groq:key', model: model('groq', 'bedrock-converse-stream'), context: fixture.context }); out.bedrock = 'unexpected success'; }
  catch (e) { out.bedrock = e instanceof KeyRouteError ? e.code : 'wrong error type'; }
  out.reads = reads;
  try { await isolated.respond('m', { account: 'kimi-code:plan_key', model: model('kimi-coding', 'anthropic-messages'), context: fixture.context, options: { client: {} } }); out.opaque = 'unexpected success'; }
  catch (e) { out.opaque = e instanceof KeyRouteError ? e.code : 'wrong error type'; }
  out.opaqueReads = reads;
  // Explicit native/client-owned flow remains stock and typed by its factories; never label it saved-account auth.
  const runtime = await portable.keys();
  const native = runtime.createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  const chosen = { ...model('native-fixture', 'anthropic-messages'), name: 'Native fixture', headers: { 'x-native-app': 'explicit' } };
  native.setProvider(runtime.createProvider({ id: chosen.provider, models: [chosen], api: await runtime.api(chosen.api),
    auth: { apiKey: { name: 'native', resolve: async () => ({ auth: { apiKey: 'explicit-native-key' } }) } } }));
  let clients = 0; let payloads = 0; let responses = 0; let metadata = false;
  const answer = await native.complete(chosen, fixture.context, {
    client: { beta: { messages: { create: () => { clients++; return { asResponse: async () => sse('anthropic-messages') }; } } } },
    onPayload: (_payload, selected) => { payloads++; metadata = selected.name === 'Native fixture' && selected.headers['x-native-app'] === 'explicit'; },
    onResponse: () => { responses++; },
  });
  out.native = { clients, payloads, responses, metadata, stop: answer.stopReason, usage: [answer.usage.input, answer.usage.output, answer.usage.totalTokens] };
  return out;
}
globalThis.__accountsKeyProbe = run();
