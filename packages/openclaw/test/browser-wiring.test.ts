import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { browserToolPolicySafe, browserProfileAcknowledged, browserSessionMayRun, reconcileConfig } from '../src/config.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { Bridge } from '../src/bridge.ts';
import type { NeedSignIn, ResumeState } from '../src/browser.ts';
import { scratchDir } from '../../test-support.ts';
import { scanCapabilities } from './engine/privacy-evidence.ts';
import { transcriptBytes } from './engine/protection-matrix.ts';

const safe = { tools: { allow: ['browser', 'request_sign_in', 'crew_x'] } };
test('durable evidence keeps exact owned jsonl bytes and never follows links', () => {
  const root = scratchDir('transcript-bytes');
  try {
    mkdirSync(join(root, 'sessions'));
    const path = join(root, 'sessions', 'fixture.jsonl'), bytes = '{"text":"PUBLIC_CONTROL"}\n';
    writeFileSync(path, bytes); writeFileSync(join(root, 'ignored.log'), 'ignored');
    symlinkSync(join(root, 'sessions'), join(root, 'linked-directory'));
    symlinkSync(path, join(root, 'linked.jsonl'));
    assert.deepEqual(transcriptBytes(root), [{ path, bytes }]);
    assert.throws(() => transcriptBytes(join(root, 'missing')), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('privacy byte scanner needs real evidence and catches nested/current/prior generation capabilities', () => {
  const capabilities = new Set(['SYNTHETIC_OLD_TOKEN', 'SYNTHETIC_NEW_TOKEN']);
  assert.deepEqual(scanCapabilities({ messages: [{ role: 'tool', content: 'PUBLIC_CONTROL' }] }, capabilities),
    { checked: 2, matches: [] });
  const negative = scanCapabilities({ messages: [{ content: { nested: 'SYNTHETIC_OLD_TOKEN SYNTHETIC_NEW_TOKEN' } }] }, capabilities);
  assert.equal(negative.matches.length, 2);
  assert.ok(negative.matches.every(value => /^[a-f0-9]{64}$/.test(value)), 'diagnostics retain digests, never raw capabilities');
  assert.equal(scanCapabilities({ SYNTHETIC_OLD_TOKEN: 'value' }, capabilities).matches.length, 1);
  assert.throws(() => scanCapabilities(undefined, capabilities), /evidence unavailable/);
  assert.throws(() => scanCapabilities({}, new Set()), /evidence unavailable/);
  assert.throws(() => scanCapabilities({}, new Set([''])), /evidence unavailable/);
});

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
  assert.equal(config.tools.alsoAllow, undefined, 'published schema forbids allow plus alsoAllow');
  assert.ok(config.tools.allow.includes('browser') && config.tools.allow.includes('request_sign_in'));
  assert.equal(config.plugins.entries.byokit.hooks.allowConversationAccess, true);
  assert.equal(browserToolPolicySafe(config, ['crew_x']), true);
});

test('stock CDP redaction is acknowledged only against stable exact owned and applied configuration', () => {
  const endpoint = 'ws://127.0.0.1:1234/devtools/browser?token=synthetic';
  const owned = { cdpUrl: endpoint, attachOnly: true };
  const masked = { cdpUrl: '__OPENCLAW_REDACTED__', attachOnly: true };
  const applied = { configRevisionHash: 'revision', appliedConfigHash: 'revision' };
  assert.notEqual(masked.cdpUrl, endpoint, 'original strict URL comparison rejected the stock sentinel');
  assert.equal(browserProfileAcknowledged(masked, owned, endpoint, applied, true), true);
  for (const [profile, local, revision, stable] of [
    [masked, owned, applied, false], [masked, owned, {}, true],
    [masked, owned, { ...applied, appliedConfigHash: 'other' }, true],
    [masked, { ...owned, cdpUrl: endpoint + '-other' }, applied, true],
    [{ ...masked, cdpUrl: 'arbitrary-mask' }, owned, applied, true],
    [{ ...masked, attachOnly: false }, owned, applied, true],
  ] as const) assert.equal(browserProfileAcknowledged(profile, local, endpoint, revision, stable), false);
});

test('parked/recovery guards require a fresh exact registered run after a definite failed resume', async t => {
  const key = 'agent:ada:fixture:guard';
  const root = scratchDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = new Bridge({ path: join(root, 'unused.sock'), tools: new Set(), permitted: () => true,
    approvalTimeoutMs: 1000, onAsk: () => {}, onAskGone: () => {} });
  const row = (state: NeedSignIn['state'], resume?: ResumeState['state']) => ({ sessionKey: key, state,
    settled: resume ? { resume: { state: resume } } : undefined }) as NeedSignIn;
  for (const state of ['waiting', 'held', 'checking', 'parked'] as const)
    for (const registered of [false, true]) assert.equal(browserSessionMayRun([row(state)], key, registered), false);
  for (const state of ['pending', 'accepted', 'submitted', 'indeterminate'] as const)
    for (const registered of [false, true]) assert.equal(browserSessionMayRun([row('settled', state)], key, registered), false);
  const failed = [row('settled', 'failed')];
  assert.equal(browserSessionMayRun(failed, key, bridge.isRegisteredRun(key, 'fresh')), false);
  const release = bridge.register({ member: 'ada', sessionKey: key }, undefined, 'fresh');
  assert.equal(browserSessionMayRun(failed, key, bridge.isRegisteredRun(key)), false);
  assert.equal(browserSessionMayRun(failed, key, bridge.isRegisteredRun(key, 'other')), false);
  assert.equal(browserSessionMayRun(failed, key, bridge.isRegisteredRun(key, 'fresh')), true);
  assert.equal(bridge.isRegisteredRun('agent:bea:fixture:guard', 'fresh'), false);
  release(); assert.equal(browserSessionMayRun(failed, key, bridge.isRegisteredRun(key, 'fresh')), false);
  bridge.register({ member: 'ada', sessionKey: key }, undefined, 'old-engine');
  bridge.stop(); assert.equal(bridge.isRegisteredRun(key, 'old-engine'), false);
  await bridge.start(); assert.equal(bridge.isRegisteredRun(key, 'old-engine'), false);
  bridge.stop();
  assert.equal(browserSessionMayRun([row('parked')], 'agent:bea:fixture:guard'), true);
  assert.equal(browserSessionMayRun([row('settled')], key), true);
});

test('kit run facade forwards the exact request id and revokes it after completion', async t => {
  const root = scratchDir(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const kit = new OpenClawKit({ stateDir: root, spawnEngine: false });
  const slot = kit as any;
  const key = 'agent:ada:fixture:registered', id = 'fixture-exact-request';
  slot.ensureMember = async () => ({ agentId: 'ada' });
  slot.request = () => async (method: string, params: any) => {
    if (method === 'agent') {
      assert.equal(params.idempotencyKey, id);
      assert.equal(slot.bridge.isRegisteredRun(params.sessionKey, id), true);
      assert.equal(slot.bridge.isRegisteredRun(params.sessionKey, 'foreign-request'), false);
      return { runId: id };
    }
    assert.equal(method, 'agent.wait'); return { status: 'ok' };
  };
  const result = await slot.runs().run({ member: 'ada', sessionKey: key, message: 'source fixture', idempotencyKey: id });
  assert.equal(result.ok, true);
  assert.equal(slot.bridge.isRegisteredRun(key, id), false);
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
  fake.handle('sessions.create', params => ({ key: (params as { key: string }).key }));
  fake.handle('tools.effective', params => ({ agentId: (params as { agentId: string }).agentId, groups: [{ tools: [{ id: 'browser' }] }] }));
  try {
    await kit.start();
    assert.equal(kit.browser?.state('ada').why, 'no-browser');
    assert.deepEqual(fake.calls.filter(c => c.method === 'sessions.create').map(c => c.params),
      ['main', 'other', 'byokit-key-ada'].map(agentId => ({ agentId, key: `agent:${agentId}:byokit-browser-policy`, label: 'Browser tool policy' })),
      'every audit session is inert: no message/task or model submission');
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
