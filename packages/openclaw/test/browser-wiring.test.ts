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
import { scanCapabilities, sqliteTranscripts, boundedAwait, emitEvidence } from './engine/privacy-evidence.ts';
import { DatabaseSync } from 'node:sqlite';
import { startModelStub } from '../src/testing/model-stub.ts';

const safe = { tools: { allow: ['browser', 'request_sign_in', 'crew_x'] } };
test('SQLite transcript evidence includes WAL, preserves originals and ignores links', () => {
  const root = scratchDir('sqlite-transcripts'), source = join(root, 'source'); mkdirSync(source);
  const path = join(source, 'openclaw-agent.sqlite'), db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE transcript_events(body TEXT); INSERT INTO transcript_events VALUES ('PUBLIC_WAL_CONTROL')");
    const original = ['', '-wal', '-shm'].map(suffix => readFileSync(path + suffix));
    symlinkSync(source, join(source, 'linked-directory'));
    symlinkSync(path, join(source, 'linked.sqlite'));
    const capture = sqliteTranscripts(source, join(root, 'snapshots'));
    assert.equal(capture.length, 1); assert.equal(capture[0].events[0].body, 'PUBLIC_WAL_CONTROL');
    assert.equal(capture[0].files.length, 3);
    for (const [index, suffix] of ['', '-wal', '-shm'].entries()) {
      assert.deepEqual(readFileSync(path + suffix), original[index]);
      assert.deepEqual(readFileSync(capture[0].snapshot + suffix), original[index]);
    }
    assert.throws(() => sqliteTranscripts(join(source, 'linked-directory'), join(root, 'rejected')), /symlink/);
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test('stage evidence is durable before a stuck await and timeout remains an error', async () => {
  const root = scratchDir('bounded-stage'), path = join(root, 'events.jsonl');
  const emit = (event: unknown) => emitEvidence(path, event);
  try {
    await assert.rejects(boundedAwait('stuck-fixture', () => {
      assert.equal(JSON.parse(readFileSync(path, 'utf8').trim()).phase, 'start');
      return new Promise<never>(() => {});
    }, emit, 10), /fixture await timed out: stuck-fixture/);
    assert.deepEqual(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line).phase), ['start', 'error']);
    assert.equal(await boundedAwait('positive', async () => 42, emit, 100), 42);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('source stub journals the complete provider body before responding', async () => {
  const root = scratchDir('provider-journal'), path = join(root, 'calls.jsonl');
  const body = { model: 'test', messages: [{ role: 'user', content: 'PUBLIC_CONTROL_' + 'x'.repeat(8000) }] };
  const stub = await startModelStub([], { onCall: call => emitEvidence(path, call) });
  try {
    const response = await fetch(stub.url + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).body, body);
    await response.text();
  } finally { await stub.close(); rmSync(root, { recursive: true, force: true }); }
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
