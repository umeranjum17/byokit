import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Engine } from '../src/engine.ts';
import { routes } from '../src/routes.ts';
import { reconcileConfig, memoryLimited, appRecoveryPrefixes } from '../src/config.ts';

const opts = (root: string) => ({ root, stateDir: root, port: 12345, pluginId: 'byokit', pluginDir: join(root, 'plugin'), policyPath: join(root, 'policy.mjs') });
test('plugin allowlist merges caller ids, the bridge and only default-eligible bundled route plugins', () => {
  const root = '/tmp/byokit-config-check';
  const offered = [...new Set(routes().filter(route => route.offerPolicy === 'default' && !route.needs?.plugin).map(route => route.plugin))];
  assert.ok(offered.includes('openai'), 'ChatGPT device pairing needs the openai plugin');
  const fresh = reconcileConfig(undefined, opts(root)) as any;
  assert.deepEqual(fresh.plugins.allow, ['byokit', ...offered]);
  const saved = { plugins: { allow: ['memory-core', 'openai', 'memory-core'] } };
  const app = { plugins: { allow: ['custom', 'openai', 'custom', 'bridge'] } };
  const merged = reconcileConfig(saved, { ...opts(root), pluginId: 'bridge', app }) as any;
  assert.deepEqual(merged.plugins.allow, [...new Set(['custom', 'openai', 'bridge', ...offered])]);
  assert.deepEqual(reconcileConfig(saved, opts(root)), reconcileConfig(reconcileConfig(saved, opts(root)), opts(root)));
  for (const choice of ['anthropic-cli', 'apiKey']) {
    const route = routes().find(route => route.choice === choice)!;
    assert.equal(route.offer, false);
    assert.ok(fresh.plugins.allow.includes(route.plugin), `${choice} keeps its plugin allowed while no route of it is offered`);
  }
  for (const route of routes().filter(route => !route.offer && !offered.includes(route.plugin))) {
    assert.ok(!fresh.plugins.allow.includes(route.plugin), `${route.choice} is not enabled`);
  }
  assert.deepEqual(saved.plugins.allow, ['memory-core', 'openai', 'memory-core']);
  assert.deepEqual(app.plugins.allow, ['custom', 'openai', 'custom', 'bridge']);
});

test('an explicitly offered route (OpenRouter) is allowed; defaults-only stays unchanged', () => {
  const root = '/tmp/byokit-config-offered';
  // Defaults-only consumers are unchanged: no explicit route plugin is added.
  const defaults = reconcileConfig(undefined, opts(root)) as any;
  assert.ok(!defaults.plugins.allow.includes('openrouter'));
  for (const choice of ['openrouter-oauth', 'openrouter-api-key']) {
    const route = routes().find(route => route.choice === choice)!;
    assert.equal(route.offer, false);
    assert.ok(!defaults.plugins.allow.includes(route.plugin), `${choice} stays out unless offered`);
  }
  // A consumer's offered set (Crewhouse's offered(['chatgpt','grok','copilot','openrouter']), #402) carries the
  // openrouter plugin; the account keys that differ from the engine id are already default-allowed.
  const crewhouse = reconcileConfig(undefined, { ...opts(root), offered: ['chatgpt', 'grok', 'copilot', 'openrouter'] }) as any;
  assert.ok(crewhouse.plugins.allow.includes('openrouter'), 'the offered OpenRouter sign-in must be allowed');
  // Only routes the consumer names join; routes nobody offers stay out.
  for (const proxy of ['litellm', 'clawrouter', 'copilot-proxy', 'fal', 'amazon-bedrock']) {
    assert.ok(!crewhouse.plugins.allow.includes(proxy), `${proxy} stays out`);
  }
  // A caller id already naming the plugin is kept once; the offered set never duplicates.
  const merged = reconcileConfig({ plugins: { allow: ['memory-core', 'openrouter'] } },
    { ...opts(root), pluginId: 'bridge', offered: ['openrouter', 'openrouter'] }) as any;
  assert.equal(merged.plugins.allow.filter((p: string) => p === 'openrouter').length, 1);
  assert.ok(merged.plugins.allow.includes('bridge') && merged.plugins.allow.includes('memory-core'));
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
  // 5.15: the inherited auth base is a reserved id the kit never creates, whatever the saved config named.
  assert.deepEqual(c.agents.defaults.authInheritance, { agentId: 'byokit-base' });
  assert.deepEqual((reconcileConfig({ agents: { defaults: { authInheritance: { agentId: 'm1' } } } }, opts(root)) as any)
    .agents.defaults.authInheritance, { agentId: 'byokit-base' });
  assert.equal(c.security.installPolicy.enabled, true);
  const providerPlugins = [...new Set(routes().filter((route) => route.offerPolicy === 'default' && !route.needs?.plugin).map((route) => route.plugin))];
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
  assert.deepEqual(appRecoveryPrefixes({ keyPrefixes: prefixes }), ['agent:m1:crewhouse:', 'agent:byokit-key-m1:crewhouse:']);
  const dir = scratchDir('recovery-prefixes');
  try {
    const opts = { stateDir: dir, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} };
    const stock = new Engine(opts);
    assert.equal(stock.doctorContext().env.BYOKIT_APP_OWNED_SESSION_PREFIXES, '[]');
    const app = new Engine({ ...opts, appOwnedSessions: { keyPrefixes: prefixes } });
    prefixes.push('agent:m2:other:');
    assert.deepEqual(JSON.parse(app.doctorContext().env.BYOKIT_APP_OWNED_SESSION_PREFIXES!),
      ['agent:m1:crewhouse:', 'agent:byokit-key-m1:crewhouse:']);
    assert.deepEqual(appRecoveryPrefixes({ keyPrefixes: ['agent:m1:task-'] }), ['agent:m1:task-', 'agent:byokit-key-m1:task-']);
    assert.deepEqual(appRecoveryPrefixes({ keyPrefixes: ['agent:m1:signin-request:'] }),
      ['agent:m1:signin-request:', 'agent:byokit-key-m1:signin-request:']);
    assert.deepEqual(appRecoveryPrefixes({ keyPrefixes: ['agent:123:task-'] }), ['agent:123:task-']);
    assert.deepEqual(appRecoveryPrefixes({ keyPrefixes: ['agent:byokit-key-m1:task-'] }), ['agent:byokit-key-m1:task-']);
    for (const bad of [null, {}, [], { keyPrefixes: null }, { keyPrefixes: 'agent:m1:task:' }]) {
      assert.throws(() => new Engine({ ...opts, appOwnedSessions: bad as any }), /invalid appOwnedSessions/);
    }
    for (const bad of [[null], [1], [''], ['agent:'], ['agent:m1:'], ['agent:m1:main'], ['agent:m1:ma'], ['agent:M1:task:']]) {
      assert.throws(() => new Engine({ ...opts, appOwnedSessions: { keyPrefixes: bad as any } }), /invalid appOwnedSessions/);
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
