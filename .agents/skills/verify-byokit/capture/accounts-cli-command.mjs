// Built bin (dist/accounts-cli.js) in a real child process: pool.json, fake native CLIs, list/pick/rest/unrest,
// the plain table, readings-v1.json with `--cached`, use/prefer-v1.json and env. No secret may reach an
// answer, and a new folder must share only the plan's names.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(join(process.cwd(), 'package.json'));
const dist = dirname(require.resolve('@byokit/accounts/cli'));
const BIN = join(dist, 'accounts-cli.js');
const { fakeCodex } = await import(require.resolve('@byokit/usage/testing'));

const root = mkdtempSync(join(tmpdir(), 'byk-accounts-command-'));
const stateDir = join(root, 'pool'); const home = join(root, 'home');
mkdirSync(stateDir); mkdirSync(home);
const claudeBin = join(root, 'claude');
writeFileSync(claudeBin, `#!${process.execPath}
const fs = require('node:fs');
const out = fs.existsSync(process.env.CLAUDE_CONFIG_DIR + '/signed-out');
if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify({ loggedIn: !out, email: 'umer.work@example.test', subscriptionType: 'max', access_token: 'private-fake-token' }));
`, { mode: 0o755 });
const codex = fakeCodex({ dir: join(root, 'codex'), raw: { account: { email: 'umer@example.test', planType: 'plus' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1_788_616_800 } } } } });
const piBin = join(root, 'pi');
writeFileSync(piBin, `#!${process.execPath}\n`, { mode: 0o755 });
writeFileSync(join(stateDir, 'pool.json'), JSON.stringify({ bins: { claude: claudeBin, codex: codex.bin, pi: piBin }, home, path: '/unused' }));

// The person's own default folders, so prepare has something to share.
const sharedSkills = join(root, 'agents-skills'); mkdirSync(sharedSkills);
mkdirSync(join(home, '.claude'), { recursive: true });
symlinkSync(sharedSkills, join(home, '.claude', 'skills'));
mkdirSync(join(home, '.claude', 'agents')); mkdirSync(join(home, '.claude', 'projects'));
writeFileSync(join(home, '.claude', 'settings.json'), '{"hooks":{"Stop":[]}}');
writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{}}');
writeFileSync(join(home, '.claude', '.claude.json'), '{"trusted":true}');
mkdirSync(join(home, '.codex', 'agents'), { recursive: true }); mkdirSync(join(home, '.codex', 'rules')); mkdirSync(join(home, '.codex', 'sessions'));
writeFileSync(join(home, '.codex', 'AGENTS.md'), '# rules');
writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5"');
writeFileSync(join(home, '.codex', 'auth.json'), '{"tokens":{}}');

const run = (...args) => spawnSync(process.execPath, [BIN, ...args, '--state', stateDir], { encoding: 'utf8' });
/** Add one account and hand back its id and folder; its native sign-in is finished by `finish`. */
function add(tool) {
  const added = run('add', tool);
  assert.equal(added.status, 0, added.stderr);
  const answer = JSON.parse(added.stdout);
  const folder = answer.signIn.env[tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
  return { id: answer.account.id, folder, answer };
}
const finish = (account) => writeFileSync(join(account.folder, '.byokit-signin-complete'), '');

try {
  const claude = add('claude');
  const chatgpt = add('codex');

  // prepare: only the plan's names, the history link BYOKit already made, and never a sign-in file.
  assert.deepEqual(readdirSync(claude.folder).sort(), ['.byokit-signin-pending', 'agents', 'projects', 'settings.json', 'skills']);
  assert.equal(statSync(claude.folder).mode & 0o777, 0o700);
  assert.equal(readlinkSync(join(claude.folder, 'skills')), realpathSync(sharedSkills));
  assert.equal(readlinkSync(join(claude.folder, 'projects')), join(home, '.claude', 'projects'));
  assert.equal(readFileSync(join(claude.folder, 'settings.json'), 'utf8'), '{"hooks":{"Stop":[]}}');
  assert.ok(!readdirSync(claude.folder).some((name) => /credentials|\.claude\.json|auth\.json|trust\.json|models\.json/.test(name)));
  console.log('cli-command-prepare:', readdirSync(claude.folder).sort().join(' '), '0600/0700, no sign-in file');
  finish(claude); finish(chatgpt);

  // list: one reading row per account, the same rows pick answers, and no secret.
  const listed = run('list', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout);
  assert.deepEqual(rows.map((r) => [r.tool, r.state]), [['claude', 'ready'], ['codex', 'ready']]);
  assert.equal(rows.find((r) => r.tool === 'codex').room.left, 10);
  assert.equal(rows.find((r) => r.tool === 'claude').room.left, 'unknown');
  assert.doesNotMatch(listed.stdout, /private-fake-token/);
  console.log('cli-command-list:', rows.map((r) => `${r.tool}=${r.state}/${r.room.left}/${r.windows.length}w`).join(' '), 'no secret');

  // pick: the chosen account and the env a launch needs.
  const picked = run('pick', 'codex', '--json');
  assert.equal(picked.status, 0, picked.stderr);
  const choice = JSON.parse(picked.stdout);
  assert.equal(choice.ok, true);
  assert.equal(choice.id, chatgpt.id);
  assert.equal(choice.set.CODEX_HOME, chatgpt.folder);
  assert.ok(choice.unset.includes('OPENAI_API_KEY'));
  assert.deepEqual(choice.rows.map((r) => r.id), rows.filter((r) => r.tool === 'codex').map((r) => r.id));
  console.log('cli-command-pick:', choice.id, 'room', choice.room.left, 'set', Object.keys(choice.set).join(','));

  // rest and unrest round trip, then no candidate is a plain refusal that still lists the row.
  const resting = run('rest', chatgpt.id, '--until', '45m', '--why', 'rate_limit');
  assert.equal(resting.status, 0, resting.stderr);
  const restRow = JSON.parse(resting.stdout);
  assert.equal(restRow.state, 'resting');
  assert.ok(restRow.restUntil > Date.now() + 44 * 60_000 && restRow.restUntil < Date.now() + 46 * 60_000);
  assert.equal(statSync(join(stateDir, 'rests-v1.json')).mode & 0o777, 0o600);
  console.log('cli-command-rest:', restRow.state, 'until', new Date(restRow.restUntil).toISOString());
  const none = run('pick', 'codex', '--json');
  assert.equal(none.status, 1);
  const refusal = JSON.parse(none.stdout);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'No codex account can take a run right now.');
  assert.deepEqual(refusal.rows.map((r) => r.state), ['resting']);
  console.log('cli-command-none:', none.status, refusal.reason, 'rows', refusal.rows.length);
  const free = run('unrest', chatgpt.id);
  assert.equal(free.status, 0, free.stderr);
  assert.equal(JSON.parse(free.stdout).state, 'ready');
  assert.equal(JSON.parse(run('status', chatgpt.id).stdout).state, 'ready');
  console.log('cli-command-unrest:', JSON.parse(free.stdout).state);

  // A wrong id is a plain message and a non-zero code, never a stack.
  const unknown = run('rest', 'pa_missing');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Choose an account from the list\./);
  console.log('cli-command-unknown:', unknown.stderr.trim());

  // A second Codex account, so a stored preference has something to win against.
  const second = add('codex'); finish(second);
  const chosen = () => JSON.parse(run('pick', 'codex', '--json').stdout).id;
  assert.equal(chosen(), chatgpt.id, 'ties keep roster order before any `use`');

  // use: one tool preference in prefer-v1.json (0600), the table says it in plain words, and pick obeys it.
  const used = run('use', second.id);
  assert.equal(used.status, 0, used.stderr);
  const usedRow = JSON.parse(used.stdout);
  assert.deepEqual([usedRow.ok, usedRow.tool, usedRow.id, usedRow.preferred], [true, 'codex', second.id, true]);
  assert.equal(typeof usedRow.name, 'string');
  const preferFile = join(stateDir, 'prefer-v1.json');
  assert.equal(statSync(preferFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(preferFile, 'utf8')), { version: 1, tools: { codex: second.id } });
  assert.equal(chosen(), second.id, 'the stored account wins while it is ready');
  const marked = JSON.parse(run('list', '--json').stdout).filter((r) => r.preferred === true);
  assert.deepEqual(marked.map((r) => r.id), [second.id], 'exactly the stored row is preferred');
  assert.equal(JSON.parse(readFileSync(preferFile, 'utf8')).tools.codex, second.id);
  console.log('cli-command-use:', second.id, 'preferred, prefer-v1.json 0600');

  // The plain table: aligned rows, the same ids, the word `preferred`, and no colour code.
  const tableOut = run('list');
  assert.equal(tableOut.status, 0, tableOut.stderr);
  assert.match(tableOut.stdout, /^id\s+tool\s+name\s+state\s+room\s+reset\s+note\n/);
  assert.doesNotMatch(tableOut.stdout, /\u001b\[/);
  assert.match(tableOut.stdout.split('\n').find((l) => l.startsWith(second.id)), /preferred/);
  assert.doesNotMatch(tableOut.stdout.split('\n').find((l) => l.startsWith(chatgpt.id)), /preferred/);
  assert.doesNotMatch(tableOut.stdout, /private-fake-token/);
  console.log('cli-command-table:\n' + tableOut.stdout.trimEnd());

  // A stored account that rests falls back to the normal order; the clear ends the preference.
  assert.equal(run('rest', second.id, '--until', '45m').status, 0);
  assert.equal(chosen(), chatgpt.id, 'a resting stored account is not a candidate');
  assert.equal(run('unrest', second.id).status, 0);
  assert.equal(chosen(), second.id);
  assert.equal(run('use', '--clear', 'codex').status, 0);
  assert.deepEqual(JSON.parse(readFileSync(preferFile, 'utf8')), { version: 1, tools: {} });
  const before = readFileSync(preferFile, 'utf8');
  const noop = run('use', '--clear', 'claude');
  assert.equal(noop.status, 0, noop.stderr);
  assert.equal(readFileSync(preferFile, 'utf8'), before, 'a clear with no entry changes nothing');
  console.log('cli-command-use-clear:', 'fallback, clear, no-op clear');

  // env: folder paths only, and a real shell applying them, with the reader moved away.
  renameSync(claudeBin, claudeBin + '.away');
  const env = run('env', claude.id);
  assert.equal(env.status, 0, env.stderr);
  assert.match(env.stdout, /^export CLAUDE_CONFIG_DIR='/m);
  assert.match(env.stdout, /^unset ANTHROPIC_API_KEY$/m);
  assert.doesNotMatch(env.stdout, /private-fake-token/);
  const script = ['export ANTHROPIC_API_KEY=canary',
    `eval "$(${[process.execPath, BIN, 'env', claude.id, '--state', stateDir].map((v) => `'${v}'`).join(' ')})"`,
    `printf '%s|%s' "$CLAUDE_CONFIG_DIR" "${'${ANTHROPIC_API_KEY-unset}'}"`].join('\n');
  const shell = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(shell.status, 0, shell.stderr);
  assert.equal(shell.stdout, `${claude.folder}|unset`, 'a shell applies the folder and drops the override');
  renameSync(claudeBin + '.away', claudeBin);
  console.log('cli-command-env:', shell.stdout, 'no key, no read');

  // cached: the last reading of every row, from the file alone, with no reader left to run.
  const savedRows = JSON.parse(run('list', '--json').stdout);
  const readings = join(stateDir, 'readings-v1.json');
  assert.equal(statSync(readings).mode & 0o777, 0o600);
  assert.doesNotMatch(readFileSync(readings, 'utf8'), /private-fake-token/);
  const ran = join(root, 'reader-ran');
  writeFileSync(codex.bin, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(ran)}, 'x');\n`, { mode: 0o755 });
  const cached = run('list', '--json', '--cached');
  assert.equal(cached.status, 0, cached.stderr);
  assert.deepEqual(JSON.parse(cached.stdout), savedRows, 'the saved reading comes back whole');
  assert.equal(existsSync(ran), false, 'no reader ran for the cached list');
  run('list', '--json');
  assert.ok(existsSync(ran), 'a live list does run its reader');
  console.log('cli-command-cached:', savedRows.length, 'rows from readings-v1.json, no reader');
} finally {
  rmSync(root, { recursive: true, force: true });
}
