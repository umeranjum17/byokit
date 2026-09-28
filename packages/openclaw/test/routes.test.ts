// Routes are data (5.7, D12): the shape an app can trust, every offered route a subscription, and no Anthropic
// CLI/API fallback ever among them. The engine job re-checks every choice id against the pinned tarball.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, routes } from '../src/routes.ts';

// The nine subscription routes the product offers (Crewhouse docs/supported-subscriptions.md, reviewed in 5.7).
const OFFERED = [
  'openai', 'openai-device-code', 'xai-oauth', 'xai-device-code', 'github-copilot', 'github-copilot-enterprise',
  'openrouter-oauth', 'minimax-global-oauth', 'minimax-cn-oauth',
];

test('every route is a complete label with the pin as its source', () => {
  const table = routes();
  assert.ok(table.length > 20, 'the table is the pin\'s whole inventory');
  for (const route of table) {
    assert.equal(typeof route.choice, 'string');
    assert.ok(route.choice.length > 0 && route.provider.length > 0, JSON.stringify(route));
    assert.ok(['subscription', 'api', 'local'].includes(route.billing), `${route.choice}: ${route.billing}`);
    assert.ok(['browser', 'code'].includes(route.via), `${route.choice}: ${route.via}`);
    assert.equal(typeof route.offer, 'boolean');
    assert.ok(route.prerequisite === null || typeof route.prerequisite === 'string');
    assert.ok(route.reason.length > 0, `${route.choice} has no reason`);
    assert.match(route.source, /2026\.8\.1/, `${route.choice}: ${route.source}`);
  }
  assert.equal(new Set(table.map((route) => route.choice)).size, table.length, 'choice ids are unique');
});

test('the offered routes are exactly the reviewed subscriptions, in the doc\'s order, and all are subscriptions', () => {
  const offered = routes().filter((route) => route.offer);
  assert.deepEqual(offered.map((route) => route.choice), OFFERED, 'routeFor prefers the doc\'s order');
  for (const route of offered) assert.equal(route.billing, 'subscription', route.choice);
});

test('no Anthropic route is offered: no CLI and no API-key fallback (D12)', () => {
  for (const route of routes()) {
    if (route.provider !== 'anthropic' && !route.choice.startsWith('anthropic-')) continue;
    assert.equal(route.offer, false, `${route.choice} must never be offered`);
  }
  assert.equal(routeFor('anthropic', 'browser'), undefined);
  assert.equal(routeFor('anthropic', 'code'), undefined);
  // The CLI prerequisite is stated where it exists, so a card can say it in plain words.
  assert.match(routes().find((route) => route.choice === 'anthropic-cli')!.prerequisite ?? '', /Claude CLI/);
});

test('local runtimes are labelled local, API keys are labelled API', () => {
  const byChoice = new Map(routes().map((route) => [route.choice, route]));
  for (const choice of ['ollama', 'lmstudio', 'sglang', 'vllm']) assert.equal(byChoice.get(choice)?.billing, 'local', choice);
  for (const choice of ['openai-api-key', 'gemini-api-key', 'ollama-cloud', 'custom-api-key']) assert.equal(byChoice.get(choice)?.billing, 'api', choice);
});

test('routeFor picks the offered route for the provider and the way the person signs in', () => {
  assert.equal(routeFor('openai', 'browser')?.choice, 'openai');
  assert.equal(routeFor('openai', 'code')?.choice, 'openai-device-code');
  assert.equal(routeFor('xai', 'browser')?.choice, 'xai-oauth');
  assert.equal(routeFor('xai', 'code')?.choice, 'xai-device-code');
  assert.equal(routeFor('github-copilot', 'browser')?.choice, 'github-copilot');
  assert.equal(routeFor('minimax', 'browser')?.choice, 'minimax-global-oauth');
  // A provider with no offered route, and an unoffered choice, are both simply absent.
  assert.equal(routeFor('ollama', 'browser'), undefined);
  assert.equal(routeFor('littleshop', 'browser'), undefined);
});
