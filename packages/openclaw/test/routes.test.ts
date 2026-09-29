// Routes are data (5.7, D12): the shape an app can trust, every offered route a subscription, and no Anthropic
// CLI/API fallback ever among them. The engine job re-checks every choice id against the pinned tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, routes } from '../src/routes.ts';

// The eight subscription routes the product offers (Crewhouse docs/supported-subscriptions.md, reviewed in 5.7;
// xai-device-code is not among them: the pin marks it manual-only and the gateway refuses it).
const OFFERED = [
  'openai', 'openai-device-code', 'xai-oauth', 'github-copilot', 'github-copilot-enterprise',
  'minimax-global-oauth', 'minimax-cn-oauth',
];
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

test('the offered routes are exactly the reviewed subscriptions, in the doc\'s order, and all are subscriptions', () => {
  const offered = routes().filter((route) => route.offer);
  assert.deepEqual(offered.map((route) => route.choice), OFFERED, 'routeFor prefers the doc\'s order');
  for (const route of offered) {
    assert.equal(route.billing, 'subscription', route.choice);
    assert.ok(route.plugin.length > 0, `${route.choice} needs the plugin an app must allow (5.6)`);
  }
});

test('every route names the bundled plugin that owns it, and only the core choice has none (5.2)', () => {
  for (const route of routes()) {
    if (route.choice === 'custom-api-key') assert.equal(route.plugin, '', 'the one core static choice has no plugin');
    else assert.ok(route.plugin.length > 0, `${route.choice} has no owning plugin`);
  }
});

test('OpenRouter is API-billed, never offered (no silent API billing)', () => {
  const openrouter = routes().find((route) => route.choice === 'openrouter-oauth')!;
  assert.equal(openrouter.billing, 'api');
  assert.equal(openrouter.offer, false);
  assert.equal(routeFor('openrouter', 'browser'), undefined);
  assert.equal(routeFor('openrouter', 'code'), undefined);
});

test('no Anthropic route is offered: no CLI and no API-key fallback (D12)', () => {
  const byChoice = new Map(routes().map((route) => [route.choice, route]));
  for (const route of routes()) {
    if (route.provider !== 'anthropic' && !route.choice.startsWith('anthropic-')) continue;
    assert.equal(route.offer, false, `${route.choice} must never be offered`);
  }
  assert.equal(routeFor('anthropic', 'browser'), undefined);
  assert.equal(routeFor('anthropic', 'code'), undefined);
  // The Claude-plan routes are still labelled as the subscriptions they are, and never added by the kit.
  for (const choice of ['anthropic-cli', 'setup-token']) {
    assert.equal(byChoice.get(choice)?.billing, 'subscription', choice);
    assert.equal(byChoice.get(choice)?.reason, 'byokit never adds Claude plan sign-in', choice);
  }
  // An Anthropic API key is API billing, and is never offered either.
  assert.equal(byChoice.get('apiKey')?.billing, 'api');
  assert.equal(byChoice.get('apiKey')?.offer, false);
  // The CLI prerequisite is stated where it exists, so a card can say it in plain words.
  assert.match(byChoice.get('anthropic-cli')?.prerequisite ?? '', /Claude CLI/);
});

test('a route the pinned gateway refuses is not offered (B6)', () => {
  const xai = routes().find((route) => route.choice === 'xai-device-code')!;
  assert.equal(xai.offer, false, 'manual-only upstream: the gateway answers "not available on this Gateway"');
  assert.equal(xai.reason, 'Compatibility alias the Gateway does not offer; use xai-oauth.');
  assert.equal(routeFor('xai', 'code')?.choice, 'xai-oauth', 'the offered Grok route is xai-oauth');
  assert.equal(routeFor('xai', 'browser'), undefined, 'xai-oauth is completed with a code in the pin');
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
  assert.equal(routeFor('minimax', 'browser'), undefined);
});
