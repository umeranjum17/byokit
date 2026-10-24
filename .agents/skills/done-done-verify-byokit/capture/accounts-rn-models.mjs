// A phone-only consumer of the built public entries. Run with --conditions=react-native (or browser).
import '../../../../scripts/test-egress-guard.cjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keys } from '@byokit/accounts/keys';
import { resolveModel, route } from '@byokit/accounts';

assert.ok(import.meta.resolve('@byokit/accounts/keys').endsWith('/dist/keys.js'), 'portable public keys entry');
assert.ok(import.meta.resolve('@byokit/accounts').endsWith('/dist/portable.js'), 'portable public main entry');
const id = 'google/gemma-4-31b-it:free';
const key = 'synthetic-not-sent-outside-loopback';
let listed = true;
const requests = [];
const server = createServer(async (req, res) => {
  requests.push(req.url);
  assert.equal(req.headers.authorization, `Bearer ${key}`);
  res.setHeader('content-type', 'application/json');
  if (req.url === '/models') {
    res.end(JSON.stringify({ data: listed ? [{ id, context_length: 256000, top_provider: { max_completion_tokens: 32000 },
      architecture: { input_modalities: ['text'] }, pricing: { prompt: '0', completion: '0' } }] : [] }));
  } else if (req.url === '/chat/completions') {
    let body = ''; for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).model, id);
    res.setHeader('content-type', 'text/event-stream');
    res.end('data: ' + JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello Umer' }, finish_reason: null }] }) + '\n\n' +
      'data: ' + JSON.stringify({ id: 'offline', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
  } else { res.statusCode = 404; res.end('{}'); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const fetcher = (url, init) => {
  assert.ok(String(url).startsWith('https://openrouter.ai/api/v1/'), 'only the selected vendor route');
  return fetch(origin + String(url).slice('https://openrouter.ai/api/v1'.length), init);
};
try {
  let ambient = 0;
  const { createModels } = await keys();
  const models = createModels({ authContext: { env: async () => { ambient++; return undefined; }, fileExists: async () => { ambient++; return false; } } });
  assert.ok(models.getProviders().some((p) => p.id === 'openrouter'), 'createModels registers OpenRouter');
  assert.deepEqual(models.getProvider('openrouter').getModels(), [], 'no invented catalogue anchors');
  const resolved = await resolveModel(models, 'openrouter', id, { apiKey: key, fetch: fetcher });
  assert.ok(resolved?.listed, 'vendor live list resolves the model');
  assert.deepEqual([resolved.model.id, resolved.model.api, resolved.model.contextWindow, resolved.model.maxTokens, resolved.model.input, resolved.model.cost.input],
    [id, 'openai-completions', 256000, 32000, ['text'], 0]);
  console.log('live-list:', id, 'listed=true context=256000 output=32000 input=text price=vendor');
  const answer = await models.complete(resolved.model, { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] },
    { apiKey: key, fetch: fetcher, maxRetries: 0, env: { PI_CACHE_RETENTION: 'short' } });
  assert.equal(answer.stopReason, 'stop', answer.errorMessage);
  assert.equal(answer.content.find((c) => c.type === 'text').text, 'Hello Umer');
  console.log('native-answer: Hello Umer; pinned portable adapter, selected explicit key');
  listed = false;
  const lagging = await resolveModel(models, 'openrouter', id, { apiKey: key, fetch: fetcher });
  assert.ok(lagging && !lagging.listed);
  const offline = await resolveModel(models, 'openrouter', id, { apiKey: key, fetch: async () => { throw new Error('network forbidden'); } });
  assert.ok(offline && !offline.listed);
  assert.deepEqual([offline.model.contextWindow, offline.model.maxTokens], [128000, 16384]);
  assert.equal(await resolveModel(models, 'unknown', id, { apiKey: key, fetch: fetcher }), undefined);
  assert.equal(await resolveModel(models, 'openrouter', '  ', { apiKey: key, fetch: fetcher }), undefined);
  const refused = await models.complete(resolved.model, { messages: [] });
  assert.equal(refused.stopReason, 'error');
  assert.match(refused.errorMessage, /Provider is not configured: openrouter/);
  console.log('missing-key:', refused.stopReason, refused.errorMessage);
  const billing = route('openrouter:key');
  assert.equal(billing.billing, 'api');
  assert.match(billing.label, /billed per use/);
  assert.equal(ambient, 0, 'no environment or file credential discovery');
  models.clearProviders();
  assert.equal(await resolveModel(models, 'openrouter', id, { apiKey: key, fetch: fetcher }), undefined, 'an unregistered route is not guessed');
  console.log('fallback: offline and unlisted stay resolvable; unknown/blank refused; billing=api, never relabelled free; ambient-reads=0');
  console.log('loopback-only requests:', requests.join(', '));
  if (process.env.DONE_DONE_EVIDENCE_ROOT) writeFileSync(join(process.env.DONE_DONE_EVIDENCE_ROOT, 'steps.json'), JSON.stringify({
    target: { version: 'built @byokit/accounts portable public entries' }, start: 'No providers supplied by the consumer; synthetic key; loopback vendor stand-in',
    steps: ['Import @byokit/accounts/keys under the react-native condition', 'Create Models with explicit app-owned auth context',
      'Resolve the OpenRouter vendor live-list model and read its limits', 'Complete a phone-only request through the pinned portable adapter',
      'Resolve an unlisted and offline model, refuse an unknown provider and missing key, check unchanged API billing'],
    result: 'Phone-only SDK consumer resolves the vendor model, receives Hello Umer, and preserves honest fallback and billing behavior; no native device or real provider generation claimed',
  }, null, 2) + '\n');
} finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
