import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { version } from 'esbuild';
import { generatePi, piDir, apis } from '../../../scripts/gen-accounts-pi.ts';
import { runtime as published } from '../src/node-keys.ts';
import { runtime as artifact } from '../src/portable-keys.ts';
import type { KeyRuntime } from '../src/key-routes.ts';
import type { Api, Model, Context } from '@earendil-works/pi-ai';
import fixture from '../../../fixtures/conformance/pi-streams.json' with { type: 'json' };

const root = new URL('../../../', import.meta.url).pathname;
const json = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('portable Pi artifact is byte-reproducible, pinned, Hermes-safe, typed and source-mapped', async () => {
  const generated = await generatePi();
  assert.deepEqual(readdirSync(piDir).sort(), [...generated.keys()].sort());
  for (const [name, text] of generated) assert.equal(readFileSync(resolve(piDir, name), 'utf8'), text, name);
  const provenance = json('packages/accounts/src/pi/PROVENANCE.json');
  const accounts = json('packages/accounts/package.json');
  const pi = json('node_modules/@earendil-works/pi-ai/package.json');
  assert.equal(provenance.version, accounts.dependencies[pi.name]);
  assert.equal(provenance.version, pi.version);
  assert.equal(provenance.esbuild, version);
  assert.equal(provenance.license, 'MIT');
  const sources = new Map<string, string>();
  for (const input of provenance.inputs) {
    assert.ok(input.path.startsWith('node_modules/@earendil-works/pi-ai/dist/'), input.path);
    assert.doesNotMatch(input.path, /bedrock|vertex/);
    assert.equal(hash(readFileSync(resolve(root, input.path))), input.sha256, input.path);
    const path = resolve(root, input.path + '.map');
    const map = JSON.parse(readFileSync(path, 'utf8'));
    map.sources.forEach((source: string, i: number) => sources.set(resolve(dirname(path), source), map.sourcesContent[i]));
  }
  const mapped = new Set<string>();
  for (const output of provenance.outputs) {
    const path = resolve(piDir, output.path);
    assert.equal(hash(readFileSync(path)), output.sha256, output.path);
    if (!path.endsWith('.js.map')) continue;
    const map = JSON.parse(readFileSync(path, 'utf8'));
    map.sources.forEach((source: string, i: number) => {
      const original = resolve(dirname(path), source);
      assert.ok(sources.has(original), original);
      assert.equal(map.sourcesContent[i], sources.get(original), original);
      mapped.add(original);
    });
  }
  assert.equal(mapped.size, sources.size);
  for (const api of apis) assert.equal(generated.get(api + '.d.ts'), `export * from '@earendil-works/pi-ai/api/${api}';\n`);
  assert.equal(generated.get('core.d.ts'), "export { createModels, createProvider } from '@earendil-works/pi-ai';\n");
  assert.equal(generated.get('cloudflare-stream.d.ts'), "export * from '@earendil-works/pi-ai/providers/cloudflare-stream';\n");
  const text = [...generated].filter(([name]) => name.endsWith('.js')).map(([, text]) => text).join('\n');
  assert.doesNotMatch(text, /\.throwIfAborted\(/, 'every bundled throwIfAborted call is rewritten to the Hermes guard');
  assert.ok([...text.matchAll(/__byokitPiThrowIfAborted\(/g)].length > 1, 'the guard is defined and covers the bundled abort checks');
  assert.ok(provenance.patch.sites > 0);
  assert.doesNotMatch(text, /\bimport\s*\(/);
  assert.equal([...text.matchAll(/\b__require\(/g)].length, 2, 'only lowered auth/context and Bun-only provider-env');
  assert.match(text, /__require\("node:fs"\)/);
  const external = provenance.externals.filter((name: string) => !name.startsWith('node:'));
  assert.deepEqual(external.sort(), ['@anthropic-ai/sdk', '@google/genai', 'openai', 'partial-json']);
  for (const name of external) assert.equal(accounts.dependencies[name], pi.dependencies[name], name);
});

const model = (api: Api): Model<Api> => ({ id: 'fixture-model', name: 'Fixture', provider: 'fixture', api,
  baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 128,
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
const context = fixture.context as Context;
function response(api: string) {
  const family = fixture.families[fixture.adapters[api as keyof typeof fixture.adapters] as keyof typeof fixture.families];
  const text = family.events.map((event: any) => `${family.named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (family.done ? 'data: [DONE]\n\n' : '');
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}
// Bundle file/line locations and clocks differ by construction; keep error names, messages and all diagnostics.
const stable = (value: unknown) => JSON.parse(JSON.stringify(value, (key, value) => {
  if (key === 'timestamp' || key === 'timestampMs') return 0;
  return key === 'stack' && typeof value === 'string' ? value.replace(/file:\/\/\S+?:\d+:\d+/g, '[source]') : value;
}));
async function drive(runtime: KeyRuntime, api: Api, mode: 'ok' | 'http400' | 'abort') {
  const authContext = { env: async () => undefined, fileExists: async () => false };
  const models = runtime.createModels({ authContext });
  const m = model(api);
  models.setProvider(runtime.createProvider({ id: m.provider, models: [m], api: await runtime.api(api),
    auth: { apiKey: { name: 'fixture', resolve: async () => ({ auth: { apiKey: 'fixture-key' } }) } } }));
  const requests: unknown[] = []; const events: unknown[] = []; const abort = new AbortController();
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const recordedHeaders: Record<string, string> = {};
    headers.forEach((value, name) => { if (!/user-agent|x-stainless|idempotency/i.test(name)) recordedHeaders[name] = value; });
    requests.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)), headers: recordedHeaders });
    if (mode === 'abort') { abort.abort(); throw Object.assign(new Error('fixture abort'), { name: 'AbortError' }); }
    if (mode === 'ok') return response(api);
    return new Response(JSON.stringify({ error: { message: 'fixture rejected', type: 'invalid_request_error', code: 400 } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  };
  const original = globalThis.fetch;
  try {
    if (api === 'google-generative-ai') globalThis.fetch = fetcher;
    const stream = models.stream(m, context, { apiKey: 'fixture-key', maxRetries: 0, temperature: 0.3, maxTokens: 64,
      signal: abort.signal, fetch: api === 'google-generative-ai' ? undefined : fetcher,
      env: { PI_CACHE_RETENTION: 'short', AZURE_OPENAI_DEPLOYMENT_NAME_MAP: '{}', AZURE_OPENAI_API_VERSION: '2025-04-01-preview', AZURE_OPENAI_BASE_URL: m.baseUrl, AZURE_OPENAI_RESOURCE_NAME: 'unused' } });
    for await (const event of stream) events.push(stable(event));
    const result = await stream.result();
    assert.equal(requests.length, 1, `${api}/${mode}: the actual adapter must reach fetch exactly once`);
    if (mode === 'ok') {
      assert.equal(result.stopReason, fixture.expected.stopReason, result.errorMessage);
      assert.deepEqual(result.content.filter((c) => c.type === 'text').map((c) => c.text), [fixture.expected.text]);
      assert.deepEqual(result.content.filter((c) => c.type === 'toolCall').map((c) => ({ name: c.name, arguments: c.arguments })), [{ name: fixture.expected.tool, arguments: fixture.expected.arguments }]);
      assert.deepEqual([result.usage.input, result.usage.output, result.usage.totalTokens], fixture.expected.usage);
      for (const type of ['text_delta', 'toolcall_end', 'done']) assert.ok(events.some((e: any) => e.type === type), `${api}: ${type}`);
    } else assert.equal(result.stopReason, mode === 'abort' ? 'aborted' : 'error');
    return stable({ requests, events, result });
  } finally { globalThis.fetch = original; }
}

// Source correctness, not equal-errors-as-success: every ok row must demonstrate text, tool, usage and events.
for (const api of apis) for (const mode of ['ok', 'http400', 'abort'] as const) {
  test(`published/artifact capability parity: ${api} ${mode}`, async () => {
    assert.deepEqual(await drive(artifact, api as Api, mode), await drive(published, api as Api, mode));
  });
}
