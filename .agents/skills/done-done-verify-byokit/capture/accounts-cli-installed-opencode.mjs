// Built public Accounts CLI; OpenCode and its login store are synthetic fixtures under this run's evidence root.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { cliAccounts } from '@byokit/accounts/cli';

const require = createRequire(import.meta.url);
assert.match(require.resolve('@byokit/accounts/cli'), /packages\/accounts\/dist\/cli\.js$/);
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
const root = mkdtempSync(join(evidence, 'installed-opencode-'));
const lines = [];
const note = (line) => { lines.push(line); console.log(line); };
try {
  const stateDir = join(root, 'state'), home = join(root, 'home');
  const storeDir = join(home, '.local', 'share', 'opencode');
  mkdirSync(stateDir); mkdirSync(storeDir, { recursive: true });
  const store = join(storeDir, 'auth.json'); writeFileSync(store, '{"synthetic":"fixture login; never read by the kit"}');
  const calls = join(root, 'calls.jsonl'); writeFileSync(calls, '');
  const bin = join(root, 'opencode');
  writeFileSync(bin, `#!${process.execPath}
const fs=require('node:fs');
const keys=['HOME','OPENCODE_API_KEY','OPENCODE_CONFIG','OPENCODE_CONFIG_CONTENT','OPENCODE_DB','CLAUDE_CONFIG_DIR','CODEX_HOME','OPENCODE_CONFIG_DIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME'];
const env=Object.fromEntries(keys.filter(k=>k in process.env).map(k=>[k,process.env[k]]));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({argv:process.argv.slice(2),env})+'\\n');
console.log('fixture OpenCode ran');
`, { mode: 0o755 });
  const env = { HOME: home, PATH: '/unused', OPENCODE_API_KEY: 'synthetic-api-key', OPENCODE_CONFIG: '/fixture/config.json',
    OPENCODE_CONFIG_CONTENT: 'synthetic-config', OPENCODE_DB: '/fixture/opencode.db', CLAUDE_CONFIG_DIR: '/fixture/claude', CODEX_HOME: '/fixture/codex' };
  const kit = cliAccounts({ stateDir, bins: { opencode: bin }, env, installed: true });
  const rows = await kit.list();
  assert.deepEqual(rows.map((row) => [row.id, row.provider]), [['installed-opencode', 'opencode']]);
  const account = rows[0];
  assert.deepEqual([account.state, account.why, account.reason], ['unknown', 'unknown', 'unavailable']);
  assert.match(account.cause, /non-secret sign-in check/);
  assert.equal(readFileSync(calls, 'utf8'), '', 'listing never runs OpenCode as a status probe');
  note('list: installed-opencode; state unknown because OpenCode has no non-secret sign-in check');

  const launch = await kit.launch(account.id);
  assert.equal(launch.ok, true); assert.deepEqual(launch.set, {});
  const requiredUnset = ['OPENCODE_API_KEY', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DB', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
  assert.ok(requiredUnset.every((key) => launch.unset.includes(key)));
  const childEnv = { ...env, ...launch.set };
  for (const key of launch.unset) delete childEnv[key];
  const run = spawnSync(bin, ['--version'], { encoding: 'utf8', env: childEnv });
  assert.equal(run.status, 0, run.stderr);
  const observed = JSON.parse(readFileSync(calls, 'utf8'));
  assert.deepEqual(observed.argv, ['--version']); assert.equal(observed.env.HOME, home);
  assert.ok(requiredUnset.every((key) => !(key in observed.env)));
  assert.ok(!['OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'].some((key) => key in observed.env));
  assert.doesNotMatch(JSON.stringify(observed), /synthetic-api-key|synthetic-config|fixture\/opencode\.db/);
  note('launch: the supplied OpenCode binary ran with HOME preserved, no folder/XDG overrides, and all six per-use overrides removed');

  const missingHome = join(root, 'missing-home'); mkdirSync(missingHome);
  const missing = cliAccounts({ stateDir: join(root, 'missing-state'), bins: { opencode: bin }, env: { HOME: missingHome, PATH: '/unused' }, installed: true });
  assert.deepEqual(await missing.list(), []);
  const noBinary = cliAccounts({ stateDir: join(root, 'no-binary-state'), bins: {}, env, installed: true });
  assert.deepEqual(await noBinary.list(), []);
  const optOut = cliAccounts({ stateDir: join(root, 'opt-out-state'), bins: { opencode: bin }, env });
  assert.deepEqual(await optOut.list(), []);
  note('guards: missing store, missing binary, and installed:false each produce no installed OpenCode row');
  note('PASS: deterministic installed OpenCode CLI journey; no real OpenCode login or network');

  writeFileSync(join(evidence, 'opencode-installed.log'), [
    'Command: node .agents/skills/done-done-verify-byokit/capture/accounts-cli-installed-opencode.mjs', ...lines,
  ].join('\n') + '\n');
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({
    target: { version: require(join(process.cwd(), 'packages/accounts/package.json')).version },
    start: 'Synthetic OpenCode binary and auth.json in a disposable HOME; no real login or network',
    steps: [
      'List installed accounts with the synthetic OpenCode binary and login-store path present; observe installed-opencode with unknown status and the non-secret-check reason.',
      'Launch the installed account and run the supplied binary with the returned environment; observe HOME preserved, the six per-use overrides removed, and no folder or XDG override.',
      'List again with the store missing, the binary missing, and installed discovery disabled; observe no installed OpenCode row in each case.',
    ],
    result: 'The installed OpenCode account is listed only with its binary and store, stays honestly unknown, and launches with the user HOME and no BYOKit folder overrides.',
  }, null, 2) + '\n');
} finally {
  rmSync(root, { recursive: true, force: true });
}
