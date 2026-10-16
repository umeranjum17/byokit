// Install readiness + startAgent lifecycle: a mise-style auto-install launcher/shim reads
// `installs-on-first-start` (never `installed`), a real binary reads `installed`, and every
// start emits `installing`/`placed`/`ready`/`launchFailed` to the call's `onEvent` and `onStartAgent`
// without polling — all against the kit fake, never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { agentInstallState, isAutoInstallShim, resolveAgentBinary } from '../src/agents.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import type { AgentStartEvent } from '../src/types.ts';

const SHIM = '#!/bin/sh\nexec mise x -- pi "$@"\n';
const REAL = '#!/bin/sh\nexit 0\n';

function binDir(name: string, files: Record<string, string>): string {
  const dir = scratchDir(name);
  for (const [n, body] of Object.entries(files)) {
    writeFileSync(join(dir, n), body);
    chmodSync(join(dir, n), 0o700);
  }
  return dir;
}

test('resolveAgentBinary + agentInstallState share the one probe path', () => {
  const dir = binDir('herdr-install-umer', { pi: SHIM, claude: REAL });
  assert.equal(resolveAgentBinary('pi', { path: [dir] }).path, join(dir, 'pi'));
  assert.equal(resolveAgentBinary('mystery', { path: [dir] }).path, undefined);
  assert.deepEqual(agentInstallState('pi', { path: [dir] }),
    { kind: 'pi', state: 'installs-on-first-start', path: join(dir, 'pi') });
  assert.deepEqual(agentInstallState('claude', { path: [dir] }),
    { kind: 'claude', state: 'installed', path: join(dir, 'claude') });
  assert.deepEqual(agentInstallState('mystery', { path: [dir] }),
    { kind: 'mystery', state: 'installs-on-first-start' });
  const aliased = binDir('herdr-install-umer-alias', { 'cursor-agent': REAL });
  assert.deepEqual(agentInstallState('cursor', { path: [aliased], aliases: { cursor: ['cursor-agent'] } }),
    { kind: 'cursor', state: 'installed', path: join(aliased, 'cursor-agent') });
});

test('agentStatus: a shim reads not-installed, a real pi binary reads installed', async () => {
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/not/used' });
  const shimmed = binDir('herdr-install-umer-status-shim', { codex: SHIM });
  const [codex] = await kit.agentStatus(['codex'], { path: [shimmed], run: async () => undefined });
  assert.deepEqual(codex, { kind: 'codex', installed: false, installState: 'installs-on-first-start',
    signedIn: 'unknown', installHint: 'Install the codex command, then check again.' });
  const real = binDir('herdr-install-umer-status-real', { pi: REAL });
  const [pi] = await kit.agentStatus(['pi'], { path: [real], run: async () => undefined });
  assert.deepEqual(pi, { kind: 'pi', installed: true, installState: 'installed',
    signedIn: 'unknown', installHint: 'installs on first start' });
});

test('a Node interpreter under mise is installed, not a shim; a shell launcher stays a shim', () => {
  const node = '#!/home/u/.local/share/mise/installs/node/24/bin/node\nconsole.log("pi");\n';
  const dir = binDir('herdr-install-umer-node-interp', { pi: node, claude: '#!/usr/bin/env node\n' + "console.log('mise x is not a shim');\n" });
  assert.deepEqual(agentInstallState('pi', { path: [dir] }),
    { kind: 'pi', state: 'installed', path: join(dir, 'pi') });
  assert.deepEqual(agentInstallState('claude', { path: [dir] }),
    { kind: 'claude', state: 'installed', path: join(dir, 'claude') });
  assert.equal(isAutoInstallShim('pi', () => node), false);
  assert.equal(isAutoInstallShim('pi', () => SHIM), true);
  assert.equal(isAutoInstallShim('pi', () => '#!/bin/sh\nexec "/home/u/.local/bin/mise" x -- pi "$@"\n'), true);
  assert.equal(isAutoInstallShim('pi', () => '#!/bin/zsh\nmise x -- pi "$@"\n'), true);
  assert.equal(isAutoInstallShim('pi', () => '#!/usr/bin/env node\nmise x -- pi\n'), false);
});

async function withKit(
  run: (kit: HerdrKit, seen: { call: AgentStartEvent[]; wide: AgentStartEvent[] }) => Promise<void>): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-install-umer-start') });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try {
    await kit.start();
    const seen = { call: [] as AgentStartEvent[], wide: [] as AgentStartEvent[] };
    const off = kit.onStartAgent((e) => { seen.wide.push(e); });
    try { await run(kit, seen); }
    finally { off(); }
  } finally {
    await kit.stop();
    await fake.stop();
  }
}

test('startAgent with a shim install emits installing then ready — subscribable, no polling', async () => {
  const dir = binDir('herdr-install-umer-events', { pi: SHIM });
  await withKit(async (kit, seen) => {
    const ref = await kit.startAgent({ kind: 'pi', cwd: '/tmp/umer', place: { workspace: 'new' },
      installProbe: { path: [dir] }, onEvent: (e) => { seen.call.push(e); } });
    assert.match(ref.paneId, /^w\d+:p\d+$/);
    assert.equal(seen.call.length, 3);
    assert.equal(seen.call[0]?.phase, 'installing');
    assert.equal((seen.call[0] as { message: string }).message, 'Installing pi…');
    assert.equal(seen.call[1]?.phase, 'placed');
    assert.deepEqual(seen.call[2], { phase: 'ready', kind: 'pi', ref });
    assert.deepEqual(seen.wide, seen.call, 'the app-wide subscription hears the same events');
  });
});

test('startAgent with a real binary emits only ready', async () => {
  const dir = binDir('herdr-install-umer-events-real', { pi: REAL });
  await withKit(async (kit, seen) => {
    const ref = await kit.startAgent({ kind: 'pi', cwd: '/tmp/umer', place: { workspace: 'new' },
      installProbe: { path: [dir] }, onEvent: (e) => { seen.call.push(e); } });
    assert.equal(seen.call.length, 2);
    assert.equal(seen.call[0]?.phase, 'placed');
    assert.deepEqual(seen.call[1], { phase: 'ready', kind: 'pi', ref });
  });
});

test('a failed shim start emits launchFailed install-failed and rejects unchanged', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-install-umer-fail'),
    agentStartFaults: [{ code: 'agent_failed', message: 'boom' }] });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  const dir = binDir('herdr-install-umer-events-fail', { pi: SHIM });
  try {
    await kit.start();
    const seen: AgentStartEvent[] = [];
    await assert.rejects(
      kit.startAgent({ kind: 'pi', cwd: '/tmp/umer', place: { workspace: 'new' },
        installProbe: { path: [dir] }, onEvent: (e) => { seen.push(e); } }),
      (e: { code?: string }) => e.code === 'agent_failed');
    assert.equal(seen.length, 3);
    assert.equal(seen[0]?.phase, 'installing');
    assert.equal(seen[1]?.phase, 'placed');
    assert.deepEqual(seen[2], { phase: 'launchFailed', kind: 'pi', reason: 'install-failed',
      message: "Installing pi didn't finish. Try again in a moment." });
  } finally {
    await kit.stop();
    await fake.stop();
  }
});

test('a failed start with a real binary emits launchFailed start-rejected', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-install-umer-fail-real'),
    agentStartFaults: [{ code: 'agent_failed', message: 'boom' }] });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  const dir = binDir('herdr-install-umer-events-fail-real', { pi: REAL });
  try {
    await kit.start();
    const seen: AgentStartEvent[] = [];
    await assert.rejects(
      kit.startAgent({ kind: 'pi', cwd: '/tmp/umer', place: { workspace: 'new' },
        installProbe: { path: [dir] }, onEvent: (e) => { seen.push(e); } }));
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.phase, 'placed');
    assert.deepEqual(seen[1], { phase: 'launchFailed', kind: 'pi', reason: 'start-rejected',
      message: "That helper couldn't start. Try again in a moment." });
  } finally {
    await kit.stop();
    await fake.stop();
  }
});
