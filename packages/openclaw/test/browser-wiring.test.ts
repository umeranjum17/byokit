import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { browserToolPolicySafe, reconcileConfig } from '../src/config.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { scratchDir } from '../../test-support.ts';

const safe = { tools: { allow: ['browser', 'request_sign_in', 'crew_x'] } };
test('all-agent precondition is closed across defaults, account agents, delegates, providers and unknown tools', () => {
  assert.equal(browserToolPolicySafe(safe, ['crew_x']), true);
  for (const config of [{}, { tools: { deny: ['group:fs', 'group:runtime'] } },
    { tools: { allow: ['group:browser'] } }, { tools: { allow: ['*'] } },
    ...['exec', 'read', 'process', 'unknown_tool'].flatMap(tool => [
      { ...safe, agents: { entries: { other: { tools: { allow: [tool] } } } } },
      { ...safe, agents: { entries: { 'byokit-key-ada': { tools: { alsoAllow: [tool] } } } } },
      { ...safe, tools: { ...safe.tools, subagents: { tools: { allow: [tool] } } } },
      { ...safe, tools: { ...safe.tools, byProvider: { other: { allow: [tool] } } } },
    ]), { ...safe, agents: { defaults: { tools: { profile: 'full' } } } }])
    assert.equal(browserToolPolicySafe(config, ['crew_x']), false, JSON.stringify(config));
});

test('browser config replaces unsafe caller profiles and pins a dead default, attach-only profiles and hook access', () => {
  const config = reconcileConfig(undefined, { root: '/fixture/openclaw', stateDir: '/fixture', port: 1234,
    pluginId: 'byokit', pluginDir: '/fixture/plugin', policyPath: '/fixture/policy',
    app: { ...safe, browser: { defaultProfile: 'user', evaluateEnabled: true, profiles: { user: { cdpPort: 9222 } } } },
    browser: { profiles: { 'byokit-ada': { cdpUrl: 'ws://127.0.0.1:1235/devtools/browser?token=synthetic', attachOnly: true } }, tools: ['crew_x'] },
  }) as Record<string, any>;
  assert.equal(config.browser.defaultProfile, 'byokit-none');
  assert.equal(config.browser.evaluateEnabled, false);
  assert.deepEqual(Object.keys(config.browser.profiles).sort(), ['byokit-ada', 'byokit-none']);
  assert.equal(config.browser.profiles['byokit-ada'].attachOnly, true);
  assert.equal(config.browser.tabCleanup.enabled, false);
  assert.equal(config.plugins.entries.byokit.hooks.allowConversationAccess, true);
  assert.equal(browserToolPolicySafe(config, ['crew_x']), true);
});

test('kit refuses gate-off, reserved tools, unsafe non-browser members, raw policy mutation and unknown effective tools', async () => {
  assert.throws(() => new OpenClawKit({ stateDir: '/fixture', gateBuiltins: false,
    browser: { executablePath: '/fixture/chromium', members: [] } }), /gate-off/);
  for (const name of ['exec', 'read', 'gateway', 'browser', 'request_sign_in'])
    assert.throws(() => new OpenClawKit({ stateDir: '/fixture', host: { gate: async () => ({ allow: true }), call: async () => '' },
      tools: [{ name, description: 'unsafe', parameters: {} }], browser: { executablePath: '/fixture/chromium', members: [] } }), /invalid tool name/);
  const stateDir = scratchDir('browser-wiring');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory,
    config: { tools: { allow: ['browser', 'request_sign_in'] } }, browser: { executablePath: '/fixture/chromium', members: [] } });
  fake.handle('config.get', () => ({ hash: 'fixture', config: JSON.parse(readFileSync(join(stateDir, 'openclaw', 'openclaw.json'), 'utf8')) }));
  fake.handle('agents.list', () => ({ agents: [{ id: 'main' }, { id: 'other' }, { id: 'byokit-key-ada' }] }));
  fake.handle('tools.effective', params => ({ agentId: (params as { agentId: string }).agentId, groups: [{ tools: [{ id: 'browser' }] }] }));
  try {
    await kit.start();
    assert.equal(kit.browser?.state('ada').why, 'no-browser');
    for (const method of ['config.patch', 'config.apply', 'config.set', 'agents.update', 'plugins.setEnabled'])
      await assert.rejects(kit.call(method as never, {} as never), /guarded patchConfig/);
    fake.handle('tools.effective', params => ({ agentId: (params as { agentId: string }).agentId,
      groups: [{ tools: [{ id: (params as { agentId: string }).agentId === 'other' ? 'unknown_tool' : 'browser' }] }] }));
    const end = await kit.run({ member: 'ada', sessionKey: 'agent:ada:chat', message: 'hello' });
    assert.ok(!end.ok && 'kind' in end && end.kind === 'other');
    assert.equal(kit.browser?.state('ada').why, 'unsafe-tools');
    assert.equal(fake.calls.filter(c => c.method === 'agent').length, 0);
    await assert.rejects(kit.patchConfig({ agents: { entries: { delegate: { tools: { allow: ['read'] } } } } }), /browser tool policy refused/);
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
