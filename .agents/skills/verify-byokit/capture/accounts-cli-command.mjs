// Built bin (dist/accounts-cli.js) in a real child process: pool.json, fake native CLIs, list/pick/rest/unrest
// and the folder prepare. No secret may reach an answer, and a new folder must share only the plan's names.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
} finally {
  rmSync(root, { recursive: true, force: true });
}
