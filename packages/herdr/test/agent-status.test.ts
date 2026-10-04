// Readiness probes only app-managed selections, using injected or task-owned binaries.
// No real CLI login or default credential store is consulted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { agentProbePath, extraPathDirs, runStatusCommand } from '../src/agents.ts';
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
    if (basename(command) === 'claude') return { stdout: '{"loggedIn":true}' };
    if (basename(command) === 'codex') return { stdout: '{"id":2,"result":{}}' };
    return undefined;
  };
  const out = await kit().agentStatus(['pi', 'claude', 'codex', 'mystery'], { path: [dir], run, folders: { claude: '/managed/claude', codex: '/managed/codex' } });
  assert.deepEqual(out.find((a) => a.kind === 'pi'),
    { kind: 'pi', installed: false, installState: 'installs-on-first-start', signedIn: 'unknown', installHint: 'installs on first start' });
  const claude = out.find((a) => a.kind === 'claude');
  assert.equal(claude?.installed, true);
  assert.equal(claude?.signedIn, 'yes');
  assert.equal(claude?.signInHint, undefined, 'no sign-in hint when signed in');
  const codex = out.find((a) => a.kind === 'codex');
  assert.equal(codex?.installed, true);
  assert.equal(codex?.signedIn, 'no', 'an empty account reads signed out, never throws');
  assert.match(codex?.signInHint ?? '', /`codex`/, 'the hint names the command to run');
  const mystery = out.find((a) => a.kind === 'mystery');
  assert.deepEqual(mystery, { kind: 'mystery', installed: false, installState: 'installs-on-first-start', signedIn: 'unknown',
    installHint: 'Install the mystery command, then check again.' });
  // Only the CLIs' own status commands run — no credential file is ever opened.
  assert.deepEqual(seen.map((s) => [basename(s.command), ...s.args].join(' ')).sort(),
    ['claude auth status', 'codex app-server']);
});

test('agentStatus: a failing status command reads unknown, and aliases count as installed', async () => {
  const dir = binDir('herdr-agent-status-alias', ['cursor-agent']);
  const run: AgentStatusRunner = async () => undefined;
  const out = await kit().agentStatus(['cursor'], { path: [dir], aliases: { cursor: ['cursor-agent'] }, run });
  assert.deepEqual(out, [{ kind: 'cursor', installed: true, installState: 'installed', signedIn: 'unknown',
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

test('SECURITY: absent or invalid managed selection never invokes a readiness runner', async () => {
  const dir = binDir('herdr-status-no-selection', ['claude', 'codex']);
  const selections: (Record<string, string> | undefined)[] = [undefined, { claude: '', codex: 'relative' }, { claude: '/bad\nfolder' }];
  for (const folders of selections) {
    const out = await kit().agentStatus(['claude', 'codex'], { path: [dir], folders,
      run: async () => { assert.fail('must not probe a default login'); } });
    assert.ok(out.every((r) => r.signedIn === 'unknown'));
  }
  assert.equal(await runStatusCommand('/must/not/spawn', []), undefined);
});

test('SECURITY: actual readiness spawn uses only the selected managed home and clean env', async () => {
  const dir = binDir('herdr-status-clean-env', ['claude']);
  const folder = scratchDir('herdr-status-managed');
  writeFileSync(join(dir, 'claude'), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({ loggedIn: process.env.HOME === ${JSON.stringify(folder)} && process.env.CLAUDE_CONFIG_DIR === ${JSON.stringify(folder)} && !process.env.BYOKIT_DEFAULT_CREDENTIAL_CANARY && !process.env.ANTHROPIC_API_KEY }));\n`);
  const saved = process.env.BYOKIT_DEFAULT_CREDENTIAL_CANARY;
  process.env.BYOKIT_DEFAULT_CREDENTIAL_CANARY = 'private-default-login';
  try {
    const [result] = await kit().agentStatus(['claude'], { path: [dir], folders: { claude: folder },
      readFile: () => 'task-owned binary' }); // Node lives under mise, but this fixture is not a mise shim.
    assert.equal(result?.signedIn, 'yes');
    await kit().agentStatus(['claude'], { path: [dir], folders: { claude: folder }, readFile: () => 'task-owned binary', env: { HOME: '/default', DISPLAY: ':fake' },
      run: async (command, args, options) => {
        assert.equal(command, join(dir, 'claude'));
        assert.deepEqual(args, ['auth', 'status']);
        assert.deepEqual(options?.env, { DISPLAY: ':fake', PATH: dir, HOME: folder, USERPROFILE: folder,
          XDG_CONFIG_HOME: join(folder, '.config'), XDG_STATE_HOME: join(folder, '.local', 'state'),
          XDG_DATA_HOME: join(folder, '.local', 'share'), XDG_CACHE_HOME: join(folder, '.cache'),
          APPDATA: join(folder, 'AppData', 'Roaming'), LOCALAPPDATA: join(folder, 'AppData', 'Local'), CLAUDE_CONFIG_DIR: folder });
        return { stdout: '{"loggedIn":"truthy"}' };
      } }).then(([r]) => assert.equal(r?.signedIn, 'unknown'));
  } finally {
    if (saved === undefined) delete process.env.BYOKIT_DEFAULT_CREDENTIAL_CANARY;
    else process.env.BYOKIT_DEFAULT_CREDENTIAL_CANARY = saved;
  }
});
