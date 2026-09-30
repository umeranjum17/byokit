// Route inventory, default offerings and billing labels (5.7, D12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, routes } from '../src/routes.ts';

const NOT_OFFERED = ['xai-device-code', 'clawrouter-api-key', 'copilot-proxy',
  'custom-api-key', 'litellm-api-key', 'lmstudio', 'ollama', 'sglang', 'vllm'];
// The pin's `appGuidedAuth: 'device-code'`: the person completes these with a code, not a localhost callback.
const DEVICE_CODE = ['openai-device-code', 'xai-oauth', 'github-copilot', 'github-copilot-enterprise', 'minimax-global-oauth', 'minimax-cn-oauth', 'xai-device-code'];

test('every route is a complete label with the pin as its source', () => {
  const table = routes();
  assert.ok(table.length > 20, 'the table is the pin\'s whole inventory');
  for (const route of table) {
    assert.equal(typeof route.choice, 'string');
    assert.ok(route.choice.length > 0 && route.provider.length > 0, JSON.stringify(route));
    assert.ok(['subscription', 'api', 'local'].includes(route.billing), `${route.choice}: ${route.billing}`);
    assert.ok(['browser', 'code'].includes(route.via), `${route.choice}: ${route.via}`);
    assert.equal(typeof route.offer, 'boolean');
    assert.equal(typeof route.plugin, 'string');
    assert.ok(route.prerequisite === null || typeof route.prerequisite === 'string');
    assert.ok(route.reason.length > 0, `${route.choice} has no reason`);
    assert.match(route.source, /2026\.8\.1/, `${route.choice}: ${route.source}`);
  }
  assert.equal(new Set(table.map((route) => route.choice)).size, table.length, 'choice ids are unique');
});

test('all direct account routes are offered; proxies, aliases and local routes stay off', () => {
  assert.deepEqual(routes().filter((route) => !route.offer).map((route) => route.choice).sort(), [...NOT_OFFERED].sort());
  for (const route of routes().filter((route) => route.offer)) {
    assert.ok(['subscription', 'api'].includes(route.billing), route.choice);
    assert.ok(route.plugin.length > 0, route.choice);
  }
});

test('every route names the bundled plugin that owns it, and only the core choice has none (5.2)', () => {
  for (const route of routes()) {
    if (route.choice === 'custom-api-key') assert.equal(route.plugin, '', 'the one core static choice has no plugin');
    else assert.ok(route.plugin.length > 0, `${route.choice} has no owning plugin`);
  }
});

test('OpenRouter is offered with its API billing label', () => {
  assert.equal(routeFor('openrouter', 'browser')?.choice, 'openrouter-oauth');
  assert.equal(routeFor('openrouter', 'browser')?.billing, 'api');
  assert.equal(routeFor('openrouter', 'code'), undefined);
});

test('Claude paste and API-key routes are offered, and native CLI routes are offered (D12)', () => {
  const byChoice = new Map(routes().map((route) => [route.choice, route]));
  assert.equal(byChoice.get('setup-token')?.offer, true);
  assert.equal(byChoice.get('setup-token')?.billing, 'subscription');
  assert.equal(byChoice.get('apiKey')?.offer, true);
  assert.equal(byChoice.get('apiKey')?.billing, 'api');
  assert.equal(byChoice.get('anthropic-cli')?.offer, true);
  assert.match(byChoice.get('anthropic-cli')?.prerequisite ?? '', /Claude Code/);
});

test('a route the pinned gateway refuses is not offered (B6)', () => {
  const xai = routes().find((route) => route.choice === 'xai-device-code')!;
  assert.equal(xai.offer, false, 'manual-only upstream: the gateway answers "not available on this Gateway"');
  assert.equal(xai.reason, 'Compatibility alias the Gateway does not offer; use xai-oauth.');
  assert.equal(routeFor('xai', 'code')?.choice, 'xai-oauth', 'the offered Grok route is xai-oauth');
  assert.equal(routeFor('xai', 'browser')?.choice, 'xai-api-key', 'browser entry offers an API key, billed per use');
});

test('via follows the pin: device-code choices are completed with a code (B6)', () => {
  const byChoice = new Map(routes().map((route) => [route.choice, route]));
  for (const choice of DEVICE_CODE) {
    const route = byChoice.get(choice);
    if (!route) continue; // not every device-code choice the pin carries is a route
    assert.equal(route.via, 'code', `${choice} is appGuidedAuth device-code`);
  }
  // The two redirect routes keep the browser way of signing in.
  assert.equal(byChoice.get('openai')?.via, 'browser');
  assert.equal(byChoice.get('openrouter-oauth')?.via, 'browser');
});

test('local runtimes are labelled local, API keys are labelled API', () => {
  const byChoice = new Map(routes().map((route) => [route.choice, route]));
  for (const choice of ['ollama', 'lmstudio', 'sglang', 'vllm']) assert.equal(byChoice.get(choice)?.billing, 'local', choice);
  for (const choice of ['openai-api-key', 'gemini-api-key', 'ollama-cloud', 'custom-api-key']) assert.equal(byChoice.get(choice)?.billing, 'api', choice);
});

test('routeFor picks the offered route for the provider and the way the person signs in', () => {
  assert.equal(routeFor('openai', 'browser')?.choice, 'openai');
  assert.equal(routeFor('openai', 'code')?.choice, 'openai-device-code');
  assert.equal(routeFor('xai', 'code')?.choice, 'xai-oauth');
  assert.equal(routeFor('github-copilot', 'code')?.choice, 'github-copilot');
  assert.equal(routeFor('minimax', 'code')?.choice, 'minimax-global-oauth');
  // A provider with no offered route, an unoffered choice, and a way of signing in the route cannot take.
  assert.equal(routeFor('ollama', 'browser'), undefined);
  assert.equal(routeFor('littleshop', 'browser'), undefined);
  assert.equal(routeFor('minimax', 'browser')?.choice, 'minimax-cn-api');
});
