// Route inventory, readiness and legacy offer compatibility (D18, B6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import routesJson from '../src/routes.json' with { type: 'json' };
import snapshot from './fixtures/routes-pin.json' with { type: 'json' };
import { generateRoutes, type PinSnapshot, REVISION } from '../scripts/gen-routes.ts';
import { routeFor, routes } from '../src/routes.ts';
import { reconcileConfig } from '../src/config.ts';

const pin = snapshot as PinSnapshot;
test('generated table equals the frozen pin manifests and external catalog', () => {
  assert.equal(pin.revision, REVISION);
  assert.equal(pin.manifests.length, 151);
  assert.deepEqual(generateRoutes(pin), routesJson);
  assert.equal(routes().filter(route => route.choice).length, 91);
  assert.equal(routes().filter(route => !route.choice).length, 5);
  assert.equal(new Set(routes().map(route => route.id)).size, 96);
  assert.equal(routes().filter(route => route.choice && route.needs?.plugin).length, 55);
  const catalogChoices = pin.catalog.flatMap(entry => entry.openclaw.providers.flatMap(provider => provider.authChoices ?? []));
  for (const choice of catalogChoices) assert.ok(routes().some(route => route.choice === choice.choiceId));
  assert.throws(() => generateRoutes({ ...pin, revision: 'unverified' }), /pinned revision/);
});

test('every route has typed provenance, billing, grouping and computed readiness', () => {
  for (const route of routes()) {
    assert.ok(route.provider && route.id && route.label && route.reason);
    assert.ok(['subscription', 'api', 'local', 'free', 'unknown'].includes(route.billing));
    assert.equal(typeof route.offer, 'boolean');
    assert.ok(['default', 'explicit'].includes(route.offerPolicy!));
    assert.ok(['models', 'services'].includes(route.group!));
    assert.equal(route.upstream?.revision, REVISION);
    assert.match(route.source, /2026\.8\.1/);
    assert.ok(route.readiness);
    if (route.readiness !== 'ready') assert.ok(route.why);
  }
  for (const route of routesJson) assert.equal('readiness' in route, false, 'availability is not stored');
});

test('all plan keys are default eligible; every key can be entered without a gate', () => {
  const plans = routes().filter(route => route.via === 'plan_key');
  assert.equal(plans.length, 14);
  for (const route of plans) {
    assert.equal(route.billing, 'subscription');
    assert.equal(route.offerPolicy, 'default');
  }
  for (const route of routes().filter(route => route.via === 'key' || route.via === 'plan_key')) {
    assert.equal(route.keyEntry, true, route.choice);
    assert.deepEqual(route.keyErrors, { invalid: 'key.invalid', not_included: 'key.notIncluded' });
  }
  assert.equal(plans.find(route => route.choice === 'opencode-go')?.offer, true);
  assert.equal(plans.find(route => route.choice === 'kimi-code-api-key')?.readiness, 'needs_plugin');
});

test('readiness is honest, ordered and does not silently select API or unknown billing', () => {
  const allPlugins = pin.manifests.map(manifest => manifest.id);
  const available = routes({ plugins: allPlugins, binaries: ['claude', 'gemini'], clients: ['CHUTES_CLIENT_ID'] });
  for (const route of available.filter(route => route.offer)) {
    assert.equal(route.readiness, 'ready');
    assert.equal(route.billing, 'subscription');
    assert.equal(route.offerPolicy, 'default');
  }
  for (const route of available.filter(route => route.billing !== 'subscription')) assert.equal(route.offer, false, route.choice);
  const chutes = (facts = {}) => routes(facts).find(route => route.choice === 'chutes')!;
  assert.equal(chutes({ platform: 'rn' }).readiness, 'needs_host');
  assert.equal(chutes({ platform: 'rn', host: true }).readiness, 'needs_plugin');
  assert.equal(chutes({ plugins: ['chutes'] }).readiness, 'needs_client');
  assert.equal(chutes({ plugins: ['chutes'], clients: ['CHUTES_CLIENT_ID'] }).readiness, 'ready');
  assert.equal(chutes({ plugins: ['chutes'], clients: ['CHUTES_CLIENT_ID'] }).offer, false, 'OAuth is not necessarily a plan');
  assert.equal(routes().find(route => route.choice === 'anthropic-cli')?.readiness, 'needs_binary');
  assert.equal(available.find(route => route.choice === 'anthropic-cli')?.offer, true);
  for (const route of routes().filter(route => !route.choice)) assert.equal(route.readiness, 'no_upstream_flow');
  assert.equal(routeFor('openrouter', 'browser'), undefined);
  assert.equal(routeFor('ollama', 'browser'), undefined);
});

test('every offered plugin is allowed by the existing configuration rule', () => {
  const config = reconcileConfig(undefined, { root: '/tmp/byokit-routes', stateDir: '/tmp/byokit-routes', port: 12345,
    pluginId: 'byokit', pluginDir: '/tmp/byokit-routes/plugin', policyPath: '/tmp/byokit-routes/policy.mjs' }) as { plugins: { allow: string[] } };
  for (const route of routes().filter(route => route.offer)) assert.ok(config.plugins.allow.includes(route.plugin), route.choice);
});

test('manifest identities and the six F0 label corrections are retained', () => {
  const byChoice = new Map(routes().map(route => [route.choice, route]));
  for (const choice of ['minimax-global-oauth', 'minimax-cn-oauth']) assert.equal(byChoice.get(choice)?.provider, 'minimax-portal');
  assert.equal(byChoice.get('anthropic-cli')?.provider, 'claude-cli');
  assert.equal(byChoice.get('anthropic-cli')?.upstream?.id, 'anthropic');
  assert.deepEqual(routes().filter(route => route.deprecatedProvider).map(route => [route.choice, route.deprecatedProvider]),
    [['anthropic-cli', 'anthropic']]);
  assert.equal(byChoice.get('anthropic-cli')?.via, 'cli');
  assert.match(byChoice.get('anthropic-cli')?.prerequisite ?? '', /Claude Code/);
  assert.equal(byChoice.get('setup-token')?.offer, false, 'the pinned Gateway refuses it, so it is never offered');
  assert.equal(byChoice.get('setup-token')?.readiness, 'no_upstream_flow');
  assert.equal(byChoice.get('setup-token')?.via, 'setup_token');
  assert.equal(byChoice.get('apiKey')?.offer, false);
  assert.equal(byChoice.get('opencode-go')?.billing, 'subscription');
  assert.equal(byChoice.get('microsoft-foundry-entra')?.via, 'cloud');
  assert.match(byChoice.get('microsoft-foundry-entra')?.reason ?? '', /Cloud credentials/);
  assert.equal(byChoice.get('copilot-proxy')?.billing, 'unknown');
  assert.equal(byChoice.get('custom-api-key')?.billingFrom, 'host');
  for (const choice of ['alibaba-model-studio-api-key', 'fal-api-key', 'runway-api-key', 'pixverse-api-key', 'comfy-cloud-api-key', 'vydra-api-key']) {
    assert.equal(byChoice.get(choice)?.group, 'services');
  }
});

test('legacy pairing choices and device-code methods are unchanged', () => {
  assert.equal(routeFor('openai', 'browser')?.choice, 'openai');
  assert.equal(routeFor('openai', 'code')?.choice, 'openai-device-code');
  assert.equal(routeFor('xai', 'code')?.choice, 'xai-oauth');
  assert.equal(routeFor('github-copilot', 'code')?.choice, 'github-copilot');
  assert.equal(routeFor('minimax-portal', 'code')?.choice, 'minimax-global-oauth');
  assert.equal(routeFor('minimax', 'code')?.choice, 'minimax-global-oauth');
  assert.equal(routeFor('claude-cli', 'browser')?.choice, 'anthropic-cli');
  assert.equal(routeFor('claude-cli', 'browser')?.offer, false, 'explicit native selector is not a readiness/default claim');
  assert.equal(routeFor('anthropic', 'browser'), undefined, 'no legacy selector reaches the refused setup-token choice');
  const byChoice = new Map(routes().map(route => [route.choice, route]));
  for (const choice of ['openai-device-code', 'xai-oauth', 'github-copilot', 'github-copilot-enterprise', 'minimax-global-oauth', 'minimax-cn-oauth', 'xai-device-code']) {
    assert.equal(byChoice.get(choice)?.via, 'code');
  }
  assert.equal(byChoice.get('xai-device-code')?.offer, false);
  assert.equal(byChoice.get('xai-device-code')?.readiness, 'no_upstream_flow');
  assert.equal(byChoice.get('openrouter-oauth')?.billing, 'api');
});
