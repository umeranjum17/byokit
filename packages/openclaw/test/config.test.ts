import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.ts';
import { reconcileConfig, memoryLimited } from '../src/config.ts';

const opts = (root: string) => ({ root, stateDir: root, port: 12345, pluginId: 'byokit', pluginDir: join(root, 'plugin'), policyPath: join(root, 'policy.mjs') });
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

test('prepare writes only changed config and isolates its environment', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-'));
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
