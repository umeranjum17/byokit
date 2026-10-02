import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Engine } from '../src/engine.ts';
import { routes } from '../src/routes.ts';
import { reconcileConfig, memoryLimited, appRecoveryPrefixes } from '../src/config.ts';

const opts = (root: string) => ({ root, stateDir: root, port: 12345, pluginId: 'byokit', pluginDir: join(root, 'plugin'), policyPath: join(root, 'policy.mjs') });
test('plugin allowlist merges caller ids, the bridge and only offered route plugins', () => {
  const root = '/tmp/byokit-config-check';
  const offered = [...new Set(routes().filter(route => route.offer).map(route => route.plugin))];
  assert.ok(offered.includes('openai'), 'ChatGPT device pairing needs the openai plugin');
  const fresh = reconcileConfig(undefined, opts(root)) as any;
  assert.deepEqual(fresh.plugins.allow, ['byokit', ...offered]);
  const saved = { plugins: { allow: ['memory-core', 'openai', 'memory-core'] } };
  const app = { plugins: { allow: ['custom', 'openai', 'custom', 'bridge'] } };
  const merged = reconcileConfig(saved, { ...opts(root), pluginId: 'bridge', app }) as any;
  assert.deepEqual(merged.plugins.allow, [...new Set(['custom', 'openai', 'bridge', ...offered])]);
  assert.deepEqual(reconcileConfig(saved, opts(root)), reconcileConfig(reconcileConfig(saved, opts(root)), opts(root)));
  for (const route of routes().filter(route => !route.offer && !offered.includes(route.plugin))) {
    assert.ok(!fresh.plugins.allow.includes(route.plugin), `${route.choice} is not enabled`);
  }
  assert.deepEqual(saved.plugins.allow, ['memory-core', 'openai', 'memory-core']);
  assert.deepEqual(app.plugins.allow, ['custom', 'openai', 'custom', 'bridge']);
});

test('fresh and adversarial config force isolation and no paid memory fallback', () => {
  const root = '/tmp/byokit-config-check';
  const c = reconcileConfig(undefined, opts(root)) as any;
  assert.equal(c.gateway.bind, 'loopback');
  assert.equal(c.gateway.mode, 'local');
  assert.equal(c.gateway.auth.mode, 'token');
  assert.equal(c.gateway.controlUi.enabled, false);
  assert.equal(c.gateway.tailscale.mode, 'off');
  assert.equal(c.discovery.mdns.mode, 'off');
  assert.equal(c.env.shellEnv.enabled, false);
  assert.equal(c.update.checkOnStart, false);
  assert.equal(c.update.auto.enabled, false);
  assert.equal(c.telemetry.enabled, false);
  assert.equal(c.models.catalogRefresh.enabled, false);
  assert.equal(c.memory.search.provider, 'none');
  assert.equal(c.memory.search.fallback, 'none');
  assert.equal(c.agents.defaults.models['openai/*'].agentRuntime.id, 'openclaw');
  assert.equal(c.security.installPolicy.enabled, true);
  const providerPlugins = [...new Set(routes().filter((route) => route.offer).map((route) => route.plugin))];
  assert.deepEqual(c.plugins.allow, ['byokit', ...providerPlugins]);
  for (const proxy of ['litellm', 'clawrouter', 'copilot-proxy', 'openrouter', 'google', 'fal']) assert.ok(!c.plugins.allow.includes(proxy));
  const custom = reconcileConfig(c, { ...opts(root), app: { plugins: { allow: ['app-plugin'] } } }) as any;
  assert.deepEqual(custom.plugins.allow, ['app-plugin', 'byokit', ...providerPlugins]);
  assert.deepEqual((reconcileConfig(custom, opts(root)) as any).plugins.allow, custom.plugins.allow);

  // `agents.entries` is the engine's own agent-id map (5.6's `entries[*]`), exactly as the pin writes it.
  const hostile = reconcileConfig({ memory: { search: { provider: 'auto', fallback: 'openai' } }, agents: { entries: { m9: { memory: { search: { provider: 'openai', fallback: 'openai' } } } } } }, {
    ...opts(root), app: { gateway: { bind: 'lan', controlUi: { enabled: true }, tailscale: { mode: 'on' } }, discovery: { mdns: { mode: 'on' } } },
  }) as any;
  assert.equal(hostile.gateway.bind, 'loopback');
  assert.equal(hostile.gateway.controlUi.enabled, false);
  assert.equal(hostile.gateway.tailscale.mode, 'off');
  assert.equal(hostile.discovery.mdns.mode, 'off');
  assert.equal(hostile.memory.search.provider, 'none');
  assert.equal(hostile.memory.search.fallback, 'none');
  assert.equal(hostile.agents.entries.m9.memory.search.provider, 'none');
  assert.equal(hostile.agents.entries.m9.memory.search.fallback, 'none');
  assert.equal(memoryLimited(hostile, 'm9'), true);
  const local = reconcileConfig({ memory: { search: { provider: 'ollama', remote: { baseUrl: 'http://127.0.0.1:11434' } } } }, opts(root)) as any;
  assert.equal(local.memory.search.provider, 'ollama');
  const remote = reconcileConfig({ memory: { search: { provider: 'ollama', remote: { baseUrl: 'https://example.com', apiKey: 'secret' } } } }, opts(root)) as any;
  assert.equal(remote.memory.search.provider, 'none');
});

test('app-owned recovery prefixes are bounded namespaces, copied and mapped for API-key members', () => {
  assert.deepEqual(appRecoveryPrefixes(), []);
  const prefixes = ['agent:m1:crewhouse:', 'agent:m1:crewhouse:'];
  assert.deepEqual(appRecoveryPrefixes(prefixes), ['agent:m1:crewhouse:', 'agent:byokit-key-m1:crewhouse:']);
  const dir = scratchDir('recovery-prefixes');
  try {
    const opts = { stateDir: dir, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} };
    const stock = new Engine(opts);
    assert.equal(stock.doctorContext().env.BYOKIT_APP_SESSION_PREFIXES, '[]');
    const app = new Engine({ ...opts, appOwnedSessionPrefixes: prefixes });
    prefixes.push('agent:m2:other:');
    assert.deepEqual(JSON.parse(app.doctorContext().env.BYOKIT_APP_SESSION_PREFIXES!),
      ['agent:m1:crewhouse:', 'agent:byokit-key-m1:crewhouse:']);
    for (const bad of [null, 'agent:m1:task:', [null], [1], [''], ['agent:'], ['agent:m1:'], ['agent:m1:main'],
      ['agent:M1:task:'], ['agent:byokit-key-m1:task:'], ['agent:m1:task'], ['agent:m1::'], ['agent:m1:task:*:']]) {
      assert.throws(() => new Engine({ ...opts, appOwnedSessionPrefixes: bad as any }), /invalid appOwnedSessionPrefixes/);
    }
    assert.equal(existsSync(join(dir, 'openclaw')), false, 'option validation creates no engine files');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prepare writes only changed config and isolates its environment', async () => {
  const dir = scratchDir('config');
  try {
    const engine = new Engine({ stateDir: dir, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} });
    await engine.prepare();
    const path = join(dir, 'openclaw', 'openclaw.json');
    const bytes = readFileSync(path);
    const mtime = statSync(path).mtimeMs;
    await engine.prepare();
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(statSync(path).mtimeMs, mtime);
    writeFileSync(path, JSON.stringify({ gateway: { bind: 'lan' }, memory: { search: { provider: 'auto' } } }));
    await engine.prepare();
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).gateway.bind, 'loopback');
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).memory.search.provider, 'none');
    const env = engine.doctorContext().env;
    assert.equal(env.OPENCLAW_SKIP_CHANNELS, '1');
    assert.equal(env.HOME, join(dir, 'openclaw', 'home'));
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.BYOKIT_BRIDGE_SOCK, engine.bridgeSock);
    await engine.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
