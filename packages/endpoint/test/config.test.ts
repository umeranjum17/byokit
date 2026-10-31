import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endpointConfig, KEY_ROUTES, type EndpointOptions } from '../src/index.ts';

const options: EndpointOptions = { stateDir: '/s', credential: { provider: 'opencode', key: 'k"ey: &x' }, models: ['m1', 'm2'], port: 18400 };
type Config = Record<string, Record<string, Record<string, unknown>>>;

test('the generated config is exactly the guarded one, field by field', () => {
  const c = endpointConfig(options, 'client-key', '/s/endpoint');
  assert.deepEqual(c, {
    'config-version': 8,
    server: { host: '127.0.0.1', port: 18400, 'commercial-mode': true, discovery: { enabled: false }, 'trusted-proxies': [] },
    management: { 'allow-remote': false, 'secret-key': '', 'disable-control-panel': true },
    access: { 'api-keys': ['client-key'] },
    oauth: { 'auth-dir': '/s/endpoint/auths' },
    routing: { retry: { 'request-retry': 1, 'max-retry-interval': 5 }, cooldown: { 'transient-error-cooldown-seconds': -1 } },
    observability: { logs: { debug: false, 'logging-to-file': false, 'request-log': false }, usage: { 'usage-statistics-enabled': false }, pprof: { enable: false } },
    upstream: { codex: { 'disable-codex-cloaking': true }, claude: { 'disable-claude-cloak-mode': true, 'disable-cloaking-model-list': true } },
    'api-keys': { 'openai-compatibility': [{ name: 'opencode', 'base-url': 'https://opencode.ai/zen/go/v1', keys: [{ 'api-key': 'k"ey: &x' }], models: [{ name: 'm1', alias: 'm1' }, { name: 'm2', alias: 'm2' }] }] },
  });
  // Written as JSON, which YAML reads as the same document: a key with quotes or colons adds no setting.
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
});

test('retry permits one repeat only after refusal, so a client request never bills twice', () => {
  const c = endpointConfig(options, 'client-key', '/s/endpoint') as Config;
  const routing = c['routing'] as { retry: Record<string, number>; cooldown: Record<string, number> };
  assert.equal(routing.retry['request-retry'], 1);
  assert.equal(routing.retry['max-retry-interval'], 5);
  assert.equal(routing.cooldown['transient-error-cooldown-seconds'], -1);
});

test('no route the endpoint exposes can reach the Claude or ChatGPT look-alike', () => {
  for (const provider of Object.keys(KEY_ROUTES) as (keyof typeof KEY_ROUTES)[]) {
    const c = endpointConfig({ ...options, credential: { provider, key: 'k' } }, 'c', '/s') as Config;
    assert.deepEqual(Object.keys(c['api-keys']!), ['openai-compatibility'], 'no claude or chatgpt key entry is ever written');
    assert.equal(c['upstream']!['codex']!['disable-codex-cloaking'], true);
    assert.equal(c['upstream']!['claude']!['disable-claude-cloak-mode'], true);
    assert.match(KEY_ROUTES[provider].baseUrl, /^https:\/\//);
  }
  assert.equal((endpointConfig({ ...options, host: 'localhost' }, 'c', '/s') as Config)['server']!['host'], '127.0.0.1');
});
