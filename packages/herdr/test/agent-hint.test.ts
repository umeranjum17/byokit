// The HERDR_AGENT launch hint (6.4): every `agent.start` ride defines a shell function for the
// kind's launch executable in the idle pane shell, so the launch runs `env HERDR_AGENT=<kind>
// <exe>` — Herdr's documented foreground-process hint, on the agent's own process, never the
// pane env (which marks the shell and busies the pane). Asserted against the kit fake, plus the
// real shell mechanism the sourced script relies on.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import { agentHintScript, launchExecutableOf } from '../src/launch-env.ts';

async function withKit(run: (kit: HerdrKit, fake: FakeHerdr) => Promise<void>, name: string): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir(name) });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try { await kit.start(); await run(kit, fake); }
  finally { await kit.stop(); await fake.stop(); }
}

test('every agent start sends the launch hint for its kind and starts as before', async () => {
  await withKit(async (kit, fake) => {
    const ref = await kit.startAgent({ kind: 'gemini', cwd: '/tmp/hint', place: { workspace: 'new' } });
    assert.match(ref.paneId, /^w\d+:p\d+$/);
    // One sourcing line, riding a private 0600 file the kit cleans up; the pane confirmed the
    // marker, so the function was defined before `agent.start` typed the launch.
    assert.equal(fake.sentTexts.length, 1);
    assert.match(fake.sentTexts[0]!, /^set \+x \+v; \. '.*\/byokit-agent-[^']+\/hint\.sh'\n$/);
    const pane = fake.world.panes.find((p) => p.pane_id === ref.paneId)!;
    assert.ok(pane.text.join('\n').split('\n').some((line) => /^BYOKIT_AGENT_[0-9a-f]{32}$/.test(line)),
      'the sourced script confirmed its marker in the pane');
    assert.equal(fake.world.agents.find((a) => a.pane_id === ref.paneId)?.agent, 'gemini');
    // A second start of another kind hints its own kind: the hint is per start, shared path.
    await kit.startAgent({ kind: 'claude', cwd: '/tmp/hint', place: { workspace: 'new' } });
    assert.equal(fake.sentTexts.length, 2);
  }, 'herdr-agent-hint-start');
});

test('a busy pane is never typed into: the hint skips and the start proceeds', async () => {
  await withKit(async (kit, fake) => {
    // w1:p2 is seeded with a live agent: process_info reports a busy foreground, so the hint
    // must skip at once (no wait, no keystrokes) and leave the start to answer for itself.
    const started = Date.now();
    const ref = await kit.startAgent({ kind: 'gemini', cwd: '/tmp/hint', place: { pane: 'w1:p2' } });
    assert.equal(ref.paneId, 'w1:p2');
    assert.equal(fake.sentTexts.length, 0, 'a busy pane takes no sourcing line');
    assert.ok(Date.now() - started < 2000, `the skip is immediate (took ${Date.now() - started}ms)`);
  }, 'herdr-agent-hint-busy');
});

test('the hint script sets HERDR_AGENT on the launched process and its args, not the shell', async () => {
  // The real mechanism, offline: the exact bytes the kit sources, run by /bin/sh, launching a
  // stub agent that reports its env and args.
  const dir = mkdtempSync(join(tmpdir(), 'herdr-hint-mech-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const stub = join(bin, 'gemini');
    writeFileSync(stub, '#!/bin/sh\nprintf \'HERDR_AGENT=%s args=%s\\n\' "${HERDR_AGENT-unset}" "$*"\n', { mode: 0o700 });
    const file = join(dir, 'hint.sh');
    writeFileSync(file, agentHintScript('gemini', 'gemini', 'BYOKIT_AGENT_marker') + '\n', { mode: 0o600 });
    const run = (input: string): string =>
      spawnSync('/bin/sh', [], { input, cwd: dir, encoding: 'utf8',
        env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir } }).stdout ?? '';
    assert.equal(run(`. '${file}'\ngemini --model flash\n`),
      'BYOKIT_AGENT_marker\nHERDR_AGENT=gemini args=--model flash\n',
      'the launch carries the hint and the args; the sourced script confirms its marker');
    assert.equal(run(`. '${file}'\nprintf '%s' "\${HERDR_AGENT+set}"\n`), 'BYOKIT_AGENT_marker\n',
      'the pane shell itself never carries the hint');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the launch executable follows Herdr 0.9.1 per kind, aliases included', () => {
  assert.equal(launchExecutableOf('gemini'), 'gemini');
  assert.equal(launchExecutableOf('pi'), 'pi');
  assert.equal(launchExecutableOf('cursor'), 'cursor-agent');
  assert.equal(launchExecutableOf('kiro'), 'kiro-cli');
  assert.equal(launchExecutableOf('claude-code'), 'claude');
  assert.equal(launchExecutableOf('cursor-agent'), 'cursor-agent');
  assert.equal(launchExecutableOf('antigravity'), 'agy');
  assert.equal(launchExecutableOf('vibe'), 'vibe');
  assert.equal(launchExecutableOf('no-such-kind'), '');
});
