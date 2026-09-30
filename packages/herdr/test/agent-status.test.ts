// B5 acceptance: `agentStatus` reports installed + CLI sign-in per kind from each CLI's
// own status command (never credential files), Pi reads "installs on first start", and the
// probe covers muxr's extra PATH dirs. The command runner is injected; only the final smoke
// uses real binaries and it skips when no known CLI is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessSync, chmodSync, constants as fsConstants, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { agentProbePath, extraPathDirs } from '../src/agents.ts';
import { HerdrKit } from '../src/kit.ts';
import type { AgentStatusRunner } from '../src/types.ts';

function kit(): HerdrKit {
  // No connection: readiness probes the local machine, never Herdr.
  return new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/not/used' });
}

function binDir(name: string, names: string[]): string {
  const dir = scratchDir(name);
  for (const n of names) {
    writeFileSync(join(dir, n), '#!/bin/sh\n');
    chmodSync(join(dir, n), 0o700);
  }
  return dir;
}

test('agentStatus: signed in, signed out, pi words and unknown kinds', async () => {
  const dir = binDir('herdr-agent-status', ['claude', 'codex']);
  const seen: { command: string; args: string[] }[] = [];
  const run: AgentStatusRunner = async (command, args) => {
    seen.push({ command, args });
    if (command === 'claude') return { stdout: '{"loggedIn":true}' };
    if (command === 'codex') return { stdout: '{"id":2,"result":{}}' };
    return undefined;
  };
  const out = await kit().agentStatus(['pi', 'claude', 'codex', 'mystery'], { path: [dir], run });
  assert.deepEqual(out.find((a) => a.kind === 'pi'),
    { kind: 'pi', installed: false, signedIn: 'unknown', installHint: 'installs on first start' });
  const claude = out.find((a) => a.kind === 'claude');
  assert.equal(claude?.installed, true);
  assert.equal(claude?.signedIn, 'yes');
  assert.equal(claude?.signInHint, undefined, 'no sign-in hint when signed in');
  const codex = out.find((a) => a.kind === 'codex');
  assert.equal(codex?.installed, true);
  assert.equal(codex?.signedIn, 'no', 'an empty account reads signed out, never throws');
  assert.match(codex?.signInHint ?? '', /`codex`/, 'the hint names the command to run');
  const mystery = out.find((a) => a.kind === 'mystery');
  assert.deepEqual(mystery, { kind: 'mystery', installed: false, signedIn: 'unknown',
    installHint: 'Install the mystery command, then check again.' });
  // Only the CLIs' own status commands run — no credential file is ever opened.
  assert.deepEqual(seen.map((s) => [s.command, ...s.args].join(' ')).sort(),
    ['claude auth status', 'codex app-server']);
});

test('agentStatus: a failing status command reads unknown, and aliases count as installed', async () => {
  const dir = binDir('herdr-agent-status-alias', ['cursor-agent']);
  const run: AgentStatusRunner = async () => undefined;
  const out = await kit().agentStatus(['cursor'], { path: [dir], aliases: { cursor: ['cursor-agent'] }, run });
  assert.deepEqual(out, [{ kind: 'cursor', installed: true, signedIn: 'unknown',
    installHint: 'Install the cursor-agent command, then check again.' }]);
});

test('the probe covers the extra PATH dirs muxr probes', () => {
  const home = homedir();
  for (const dir of [join(home, '.local', 'bin'), join(home, '.local', 'share', 'mise', 'shims'),
    join(home, '.npm-global', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    assert.ok(extraPathDirs(home).includes(dir), `extraPathDirs covers ${dir}`);
  }
  // The default path is the host PATH plus the extras: a binary visible only through the
  // default (PATH stubbed to a scratch dir) still counts without passing `path`.
  const dir = binDir('herdr-agent-status-path', ['claude']);
  const saved = process.env.PATH;
  process.env.PATH = dir;
  try {
    assert.ok(agentProbePath().includes(dir), 'the stubbed PATH rides the probe');
    assert.ok(agentProbePath().includes(join(home, '.local', 'share', 'mise', 'shims')),
      'the mise shims ride the probe by default');
  } finally {
    process.env.PATH = saved;
  }
});

test('smoke: real binaries answer with the documented shape', async (t) => {
  if (process.env.BYOKIT_AGENT_STATUS_SMOKE !== '1') {
    t.skip('opt-in with BYOKIT_AGENT_STATUS_SMOKE=1');
    return;
  }
  const path = agentProbePath((process.env.PATH ?? '').split(delimiter));
  const present = ['claude', 'codex'].filter((name) =>
    path.some((dir) => {
      try { accessSync(join(dir, name), fsConstants.X_OK); return true; } catch { return false; }
    }));
  if (present.length === 0) {
    t.skip('no known agent CLI on the probe path');
    return;
  }
  const out = await kit().agentStatus(present, { timeoutMs: 10_000 });
  for (const a of out) {
    assert.equal(a.installed, true);
    assert.ok(['yes', 'no', 'unknown'].includes(a.signedIn), `${a.kind} answers in shape`);
    assert.equal(typeof a.installHint, 'string');
  }
});
