import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { generateRoutes } from '../../../scripts/gen-accounts-routes.ts';
import { offered, provider, route, routes, routeReadiness, type Route, type RouteHost } from '../src/portable.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/account-routes-typescript.json', import.meta.url), 'utf8'));

test('checked-in route snapshot covers the installed pin: 41 providers, 57 tuples, every method and explicit plan-token paste', () => {
  const generated = generateRoutes();
  assert.equal(readFileSync(new URL('../src/routes.json', import.meta.url), 'utf8'), JSON.stringify(generated, null, 2) + '\n');
  const pinned = builtinProviders();
  assert.equal(pinned.length, 41);
  assert.deepEqual([...new Set(generated.filter((r) => r.upstream.flow === 'present' && r.upstream.id !== 'custom').map((r) => r.upstream.id))].sort(), [...pinned.map((p) => p.id), 'google-gemini-cli'].sort(), 'the Google Code Assist client is a kit-owned flow, not a pinned pi-ai provider');
  assert.equal(new Set(generated.filter((r) => r.upstream.flow === 'present').map((r) => `${r.provider}|${r.via}|${r.billing}`)).size, 57);
  assert.equal(generated.length, 70, 'regional/method variants, two unavailable legacy rows, the two Google Code Assist rows and the two MiniMax device rows');
  for (const r of generated) {
    assert.ok(fixture.vocabulary.via.includes(r.via), r.id);
    assert.ok(fixture.vocabulary.billing.includes(r.billing), r.id);
    assert.equal(r.offer, r.billing === 'subscription' && !(r.provider === 'minimax' && r.via === 'code') ? 'default' : 'explicit', r.id);
    assert.equal(r.billingFrom, r.via === 'endpoint' ? 'host' : 'source', r.id);
    assert.equal(r.upstream.revision, '@earendil-works/pi-ai@0.87.1');
    assert.deepEqual(Object.keys(r.platforms).sort(), ['browser', 'node', 'rn']);
    if (r.billing === 'api') assert.match(r.label, /billed per use by/);
    else assert.doesNotMatch(r.label, /billed per use/);
    assert.ok(!('readiness' in r), 'readiness is computed, never stored');
  }
  assert.equal(route('anthropic:key:bearer').billing, 'unknown', 'generic bearer issuer/billing is not stated');
  assert.equal(route('radius:code').billing, 'unknown');
  assert.equal(route('custom:endpoint').billing, 'unknown', 'no hostname-based billing');
  assert.equal(route('minimax:key').billing, 'api');
  assert.equal(route('minimax:plan_key').readiness, 'no_upstream_flow', 'a key does not prove a plan flow');
  assert.throws(() => route('missing:key'), { status: 404 });
});

test('discovery keeps every row on every platform; host offers only ready subscription routes', () => {
  for (const platform of ['node', 'browser', 'rn'] as const) {
    const host = { platform };
    const listed = routes(host);
    assert.equal(listed.length, 70);
    assert.deepEqual(offered(host), listed.filter((r) => r.offer === 'default' && r.readiness === 'ready' && r.billing === 'subscription'));
    assert.ok(!offered(host).some((r) => r.provider === 'minimax' || r.provider === 'qwen'));
    for (const r of listed) if (r.readiness !== 'ready') assert.ok(r.why);
  }
  assert.equal(route('openai:code', { platform: 'rn' }).readiness, 'ready', 'phone ChatGPT unchanged');
  assert.equal(route('anthropic:paste', { platform: 'browser' }).readiness, 'needs_host');
  assert.equal(route('anthropic:paste', { platform: 'browser', hostSide: true }).readiness, 'ready');
  assert.equal(route('aws-bedrock:cloud:aws-profile', { platform: 'rn' }).readiness, 'unsupported_platform');
  assert.equal(route('aws-bedrock:cloud:aws-profile').readiness, 'ready', 'the isolated Node account adapter is callable');
  assert.ok(!offered({ platform: 'node' }).some((r) => r.id === 'aws-bedrock:cloud:aws-profile'), 'cloud remains explicitly selected');
  assert.equal(route('custom:endpoint', { platform: 'browser' }).readiness, 'needs_host');
  for (const id of ['anthropic:setup_token', 'custom:endpoint']) {
    assert.equal(route(id).readiness, 'needs_host', `${id}: its account adapter is not yet callable`);
    assert.ok(!offered({ platform: 'node' }).some((r) => r.id === id));
  }
  for (const id of ['anthropic:browser', 'openai:browser', 'kimi-code:plan_key', 'github-copilot:key', 'anthropic:plan_key:oauth-token']) {
    assert.equal(route(id).readiness, 'ready');
    assert.ok(offered({ platform: 'node' }).some((r) => r.id === id));
  }
  assert.equal(offered({ platform: 'node' }).length, 23);
  assert.ok(offered({ platform: 'node' }).every((r) => r.billing === 'subscription'));
});

test('readiness order follows D18 fixtures without credential or environment reads', () => {
  for (const c of fixture.readiness) {
    const r = fixture.routes.find((r: Route) => r.id === c.route) as Route;
    assert.equal(routeReadiness(r, c.host as RouteHost).readiness, c.expected, c.name);
  }
  const base = fixture.routes.find((r: Route) => r.id === 'acme:code') as Route;
  const r: Route = { ...base, platforms: { node: 'host', browser: 'no', rn: 'no' }, needs: { binary: 'tool', plugin: 'plug', client: 'client' } };
  assert.equal(routeReadiness(r, { platform: 'node' }).readiness, 'needs_host');
  assert.equal(routeReadiness(r, { platform: 'node', hostSide: true }).readiness, 'needs_binary');
  assert.equal(routeReadiness(r, { platform: 'node', hostSide: true, binaries: ['tool'] }).readiness, 'needs_plugin');
  assert.equal(routeReadiness(r, { platform: 'node', hostSide: true, binaries: ['tool'], plugins: ['plug'] }).readiness, 'needs_client');
  assert.equal(routeReadiness(r, { platform: 'node', hostSide: true, binaries: ['tool'], plugins: ['plug'], clients: ['client'] }).readiness, 'ready');
});

test('legacy provider IDs and explicit lists stay compatible; two dead defaults leave the offer', () => {
  assert.equal(provider('chatgpt').pi, 'openai-codex');
  assert.equal(provider('claude').pi, 'byokit-claude-plan');
  assert.equal(provider('qwen').pi, 'qwen-portal');
  assert.equal(provider('minimax').pi, 'minimax');
  assert.deepEqual(provider('minimax').routes, ['minimax:key', 'minimax:plan_key']);
  assert.deepEqual(offered().map((p) => p.key), ['chatgpt', 'grok', 'copilot', 'claude', 'kimi', 'meta', 'google-gemini-cli']);
  assert.deepEqual(offered(['qwen', 'minimax', 'openai']).map((p) => p.key), ['qwen', 'minimax', 'openai']);
});
