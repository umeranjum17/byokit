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
    routing: { retry: { 'request-retry': 0, 'max-retry-interval': 5 }, cooldown: { 'transient-error-cooldown-seconds': -1 } },
    observability: { logs: { debug: false, 'logging-to-file': false, 'request-log': false }, usage: { 'usage-statistics-enabled': false }, pprof: { enable: false } },
    upstream: { codex: { 'disable-codex-cloaking': true }, claude: { 'disable-claude-cloak-mode': true, 'disable-cloaking-model-list': true } },
    'api-keys': { 'openai-compatibility': [{ name: 'opencode', 'base-url': 'https://opencode.ai/zen/go/v1', keys: [{ 'api-key': 'k"ey: &x' }], models: [{ name: 'm1', alias: 'm1' }, { name: 'm2', alias: 'm2' }] }] },
  });
  // Written as JSON, which YAML reads as the same document: a key with quotes or colons adds no setting.
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c);
});

test('request retries default off and are enabled only by explicit opt-in', () => {
  const c = endpointConfig(options, 'client-key', '/s/endpoint') as Config;
  const routing = c['routing'] as { retry: Record<string, number>; cooldown: Record<string, number> };
  assert.equal(routing.retry['request-retry'], 0);
  assert.equal(routing.retry['max-retry-interval'], 5);
  assert.equal(routing.cooldown['transient-error-cooldown-seconds'], -1);
  const optedIn = endpointConfig({ ...options, retry: 1 }, 'client-key', '/s/endpoint') as Config;
  assert.equal((optedIn['routing'] as { retry: Record<string, number> }).retry['request-retry'], 1);
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

test('base URLs stay on the provider host except for loopback fakes', () => {
  type OpenAIConfig = { 'api-keys': { 'openai-compatibility': Array<{ name: string; 'base-url': string }> } };
  const own = endpointConfig({ ...options, credential: { provider: 'openai', key: 'k' } }, 'c', '/s') as unknown as OpenAIConfig;
  assert.equal(own['api-keys']['openai-compatibility'][0]!['base-url'], KEY_ROUTES.openai.baseUrl);
  const local = endpointConfig({ ...options, baseUrl: 'http://127.0.0.1:18911/v1' }, 'c', '/s') as unknown as OpenAIConfig;
  assert.equal(local['api-keys']['openai-compatibility'][0]!['base-url'], 'http://127.0.0.1:18911/v1');
});
