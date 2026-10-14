// Managed Cursor CLI (cursor-agent): two app-owned accounts, each with its own XDG_CONFIG_HOME.
// Fake binary only; the owner's real ~/.config/cursor/auth.json is never read or copied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, CliAccountError } from '../src/cli.ts';
import { scratchDir } from '../../test-support.ts';

function fakeCursor(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'cursor-agent-fake');
  const log = join(dir, 'cursor.jsonl');
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
const argv = process.argv.slice(2);
const config = process.env.XDG_CONFIG_HOME || path.join(process.env.HOME, '.config');
const auth = path.join(config, 'cursor', 'auth.json');
const mode = process.env.CURSOR_STATUS_MODE;
if (argv[0] === 'login') {
  fs.mkdirSync(path.dirname(auth), { recursive: true });
  // The token names the folder that owns it, so two accounts cannot share one login by accident.
  fs.writeFileSync(auth, JSON.stringify({ token: 'token-' + path.basename(path.dirname(path.dirname(auth))) }), { mode: 0o600 });
  process.exit(0);
}
if (argv[0] === 'status') {
  if (mode === 'malformed') { console.log('private-fake-token'); process.exit(0); }
  const signed = fs.existsSync(auth);
  console.log(JSON.stringify({ status: signed ? 'authenticated' : 'unauthenticated', isAuthenticated: signed, hasAccessToken: signed, hasRefreshToken: signed }));
  // The real CLI exits 0 even when signed out, so the exit code is deliberately not the signal.
  process.exit(mode === 'signed-in-nonzero-exit' ? 1 : 0);
}
process.exit(2);
`, { mode: 0o755 });
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> }) };
}

async function signIn(kit: ReturnType<typeof cliAccounts>, shell: string) {
  const run = spawnSync('/bin/sh', ['-c', shell], { encoding: 'utf8', env: { PATH: '/unused', AMBIENT_SECRET: 'never-inherit' } });
  assert.equal(run.status, 0, run.stderr);
}

test('cursor two accounts: one XDG_CONFIG_HOME each, two auth files, neither reads the other', async () => {
  const root = scratchDir('cursor-cli-two');
  const stateDir = join(root, 'pools'); const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const cursor = fakeCursor(join(root, 'bins'));
  const parent = join(stateDir, 'cursor');
  const env = { HOME: home, PATH: '/unused', CURSOR_API_KEY: 'owner-key-override', CURSOR_AUTH_TOKEN: 'owner-token-override' };
  const kit = cliAccounts({ stateDir, bins: { cursor: cursor.bin }, env });

  const { account: a, signIn: signA } = await kit.add('cursor');
  assert.equal(a.provider, 'cursor'); assert.equal(a.state, 'signing'); assert.equal(a.name, 'Cursor');
  assert.deepEqual(signA.argv, [cursor.bin, 'login']);
  const folderA = signA.env.XDG_CONFIG_HOME;
  assert.ok(folderA.startsWith(parent + '/'));
  assert.equal(signA.env.CURSOR_API_KEY, undefined, 'the owner key override is unset at login');
  assert.equal(signA.env.CURSOR_AUTH_TOKEN, undefined);
  // The moved XDG_CONFIG_HOME also moves git's and gh's global files; both are pointed back at the pool HOME.
  assert.equal(signA.env.GIT_CONFIG_GLOBAL, join(home, '.config', 'git', 'config'));
  assert.equal(signA.env.GH_CONFIG_DIR, join(home, '.config', 'gh'));
  await signIn(kit, signA.shell);
  const authA = join(folderA, 'cursor', 'auth.json');
  assert.equal((await kit.status(a.id)).state, 'ready');

  const { account: b, signIn: signB } = await kit.add('cursor');
  const folderB = signB.env.XDG_CONFIG_HOME;
  assert.ok(folderB.startsWith(parent + '/'));
  assert.notEqual(folderA, folderB);
  const authB = join(folderB, 'cursor', 'auth.json');
  // B has not signed in yet, so its own folder decides: A's login is not B's.
  assert.equal((await kit.status(b.id)).state, 'signing');
  assert.equal((await kit.status(a.id)).state, 'ready');
  await signIn(kit, signB.shell);
  assert.equal((await kit.status(b.id)).state, 'ready');
  assert.equal((await kit.status(a.id)).state, 'ready');
  assert.notEqual(readFileSync(authA, 'utf8'), readFileSync(authB, 'utf8'), 'each account keeps its own login');
  for (const call of cursor.calls()) {
    const folder = call.env.XDG_CONFIG_HOME!;
    assert.ok(folder === folderA || folder === folderB, 'every call stays inside one managed folder');
    if (call.argv[0] === 'login') assert.deepEqual(call.argv, ['login']);
    if (call.argv[0] === 'status') assert.deepEqual(call.argv, ['status', '--format', 'json']);
    assert.equal(call.env.CURSOR_API_KEY, undefined);
    assert.equal(call.env.CURSOR_AUTH_TOKEN, undefined);
    assert.equal(call.env.GIT_CONFIG_GLOBAL, join(home, '.config', 'git', 'config'));
    assert.equal(call.env.GH_CONFIG_DIR, join(home, '.config', 'gh'));
  }

  const launchA = await kit.launch(a.id);
  const launchB = await kit.launch(b.id);
  assert.equal(launchA.ok, true); assert.equal(launchB.ok, true);
  if (launchA.ok && launchB.ok) {
    assert.equal(launchA.set.XDG_CONFIG_HOME, folderA);
    assert.equal(launchB.set.XDG_CONFIG_HOME, folderB);
    assert.equal(launchA.set.GIT_CONFIG_GLOBAL, join(home, '.config', 'git', 'config'));
    assert.equal(launchA.set.GH_CONFIG_DIR, join(home, '.config', 'gh'));
    assert.ok(launchA.unset.includes('CURSOR_API_KEY'));
    assert.ok(launchA.unset.includes('CURSOR_AUTH_TOKEN'));
  }
  // Losing A's own login leaves A signed out and B ready: neither folder reads the other.
  rmSync(authA);
  assert.equal((await kit.status(a.id)).state, 'signed_out');
  assert.equal((await kit.status(b.id)).state, 'ready');

  assert.deepEqual(kit.resumeArgs('cursor', { kind: 'id', value: 'chat_1' }), ['--resume', 'chat_1']);
  assert.throws(() => kit.resumeArgs('cursor', { kind: 'id', value: '-sneaky' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => kit.resumeArgs('cursor', { kind: 'path', value: 'chat_1' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');

  await kit.remove(a.id);
  assert.equal((await kit.status(b.id)).state, 'ready');
  await assert.rejects(kit.status(a.id), CliAccountError);

  assert.throws(() => cliAccounts({ stateDir: join(home, '.config', 'cursor'), bins: { cursor: cursor.bin }, env: { HOME: home, PATH: '/unused' } }),
    (e: unknown) => e instanceof CliAccountError && e.code === 'bad-option');
});

test('cursor status reads isAuthenticated, never the exit code', async () => {
  const root = scratchDir('cursor-cli-status');
  const stateDir = join(root, 'pools'); const home = join(root, 'home');
  const cursor = fakeCursor(join(root, 'bins'));
  const base = { HOME: home, PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { cursor: cursor.bin }, env: base });
  const { account, signIn: command } = await kit.add('cursor');
  assert.equal((await kit.status(account.id)).state, 'signing');
  assert.equal((await kit.launch(account.id)).ok, false);
  await signIn(kit, command.shell);
  assert.equal((await kit.status(account.id)).state, 'ready');

  // A non-zero exit with isAuthenticated: true still reads ready: the JSON decides.
  const nonzero = cliAccounts({ stateDir, bins: { cursor: cursor.bin }, env: { ...base, CURSOR_STATUS_MODE: 'signed-in-nonzero-exit' } });
  assert.equal((await nonzero.status(account.id)).state, 'ready');

  // Signed out at the real exit code: `cursor-agent status` exits 0 and prints isAuthenticated: false.
  rmSync(kit.folderOf(account.id) + '/cursor/auth.json');
  const signedOut = await kit.status(account.id);
  assert.equal(signedOut.state, 'signed_out');
  assert.equal(signedOut.why, undefined);
  assert.doesNotMatch(JSON.stringify(signedOut), /private-fake-token|access_token/);
  assert.equal((await kit.launch(account.id)).ok, false);

  const malformed = cliAccounts({ stateDir, bins: { cursor: cursor.bin }, env: { ...base, CURSOR_STATUS_MODE: 'malformed' } });
  const broken = await malformed.status(account.id);
  assert.equal(broken.state, 'signed_out');
  assert.doesNotMatch(JSON.stringify(broken), /private-fake-token/);
});

test('a moved XDG_CONFIG_HOME still commits in a scratch repo under a managed folder', async () => {
  const root = scratchDir('cursor-cli-git');
  const stateDir = join(root, 'pools'); const home = join(root, 'home');
  mkdirSync(join(home, '.config', 'git'), { recursive: true });
  // The pool HOME's real global git file, exactly what the launch must keep reachable.
  writeFileSync(join(home, '.config', 'git', 'config'), '[user]\n\tname = Umer\n\temail = umer@example.test\n');
  const cursor = fakeCursor(join(root, 'bins'));
  const env = { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin' };
  const kit = cliAccounts({ stateDir, bins: { cursor: cursor.bin }, env });
  const { account, signIn: command } = await kit.add('cursor');
  await signIn(kit, command.shell);
  const launch = await kit.launch(account.id);
  assert.equal(launch.ok, true);
  if (!launch.ok) return;
  const folder = launch.set.XDG_CONFIG_HOME!;
  assert.equal(folder, kit.launchEnv(account.id).set.XDG_CONFIG_HOME);

  const repo = join(folder, 'scratch'); mkdirSync(repo);
  const git = (args: string[], extra: Record<string, string | undefined>) => {
    const child = spawnSync('git', args, { cwd: repo, encoding: 'utf8',
      env: { PATH: env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: folder, ...launch.set, ...extra } });
    return { code: child.status, out: `${child.stdout}${child.stderr}` };
  };
  assert.equal(git(['init', '-q', '.'], {}).code, 0);
  writeFileSync(join(repo, 'note.txt'), 'hello');
  assert.equal(git(['add', 'note.txt'], {}).code, 0);
  // `user.useConfigOnly` turns git's identity guess off, the same wall the exit-128 report hit.
  assert.deepEqual(git(['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', 'first'], {}).code, 0,
    'the launch keeps the pool HOME\'s real global git file reachable');
  assert.equal(git(['log', '-1', '--format=%ae'], {}).out.trim(), 'umer@example.test');
  // Without that one variable the moved XDG_CONFIG_HOME hides the identity: the exit-128 cause.
  const hidden = git(['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', 'second'], { GIT_CONFIG_GLOBAL: undefined });
  assert.equal(hidden.code, 128, hidden.out);
  assert.match(hidden.out, /Author identity unknown|auto-detection is disabled/);
  assert.equal(git(['log', '-1', '--format=%s'], {}).out.trim(), 'first', 'the refused commit created nothing');
});
