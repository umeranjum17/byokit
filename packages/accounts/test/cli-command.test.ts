// The `byokit-accounts` command, driven the way a pool owner runs it: a real child process over a throwaway
// HOME and state root, fake native CLIs, and the pool.json the command reads. `list` and `pick` must answer the
// same rows `cliAccounts` already produces, no row may carry a secret, and a new folder must share only the
// names in the plan's table — never a sign-in file, session store, log or Pi models.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliAccounts } from '../src/cli.ts';
import { fakeCodex } from '@byokit/usage/testing';
import { scratchDir } from '../../test-support.ts';

const BIN = fileURLToPath(new URL('../src/accounts-cli.ts', import.meta.url));
const HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'byokit-accounts' };
const PENDING = '.byokit-signin-pending';
const codexRaw = (usedPercent: number) => ({ account: { email: 'umer@example.test', planType: 'plus' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_788_616_800 } } } });

/** A fake Claude: `auth status` is signed in, and its output carries a canary that must never reach a row. */
function fakeClaude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const out = fs.existsSync(process.env.CLAUDE_CONFIG_DIR + '/signed-out');
if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify({ loggedIn: !out, email: 'umer@example.test', subscriptionType: 'max', access_token: 'private-fake-token' }));
`, { mode: 0o755 });
  return bin;
}

function fakeBinary(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(bin, `#!${process.execPath}\n`, { mode: 0o755 });
  return bin;
}

type Fixture = { root: string; stateDir: string; home: string; bins: { claude: string; codex: string; pi: string } };

function fixture(name: string, usedPercent = 90): Fixture {
  const root = scratchDir(name); const stateDir = join(root, 'pool'); const home = join(root, 'home');
  mkdirSync(stateDir); mkdirSync(home);
  const bins = { claude: fakeClaude(join(root, 'bin')), codex: fakeCodex({ dir: join(root, 'codex'), raw: codexRaw(usedPercent) }).bin, pi: fakeBinary(join(root, 'bin'), 'pi') };
  writeFileSync(join(stateDir, 'pool.json'), JSON.stringify({ bins, home, path: '/unused' }));
  return { root, stateDir, home, bins };
}

function run(stateDir: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [BIN, ...args, '--state', stateDir], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const kitOf = (f: Fixture) => cliAccounts({ stateDir: f.stateDir, bins: f.bins, env: { HOME: f.home, PATH: '/unused' }, claudeHeaders: HEADERS });

/** Add one account through the command and finish its native sign-in, as the person's shell would. */
function ready(f: Fixture, tool: 'claude' | 'codex') {
  const added = run(f.stateDir, 'add', tool);
  assert.equal(added.status, 0, added.stderr);
  const answer = JSON.parse(added.stdout) as { account: { id: string }; signIn: { env: Record<string, string>; shell: string } };
  const folder = answer.signIn.env[tool === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']!;
  assert.ok(folder, `add ${tool} named its folder`);
  writeFileSync(join(folder, '.byokit-signin-complete'), '');
  return { id: answer.account.id, folder, signIn: answer.signIn };
}

test('list --json: one reading row per account, and never a secret', async () => {
  const f = fixture('accounts-command-list');
  const claude = ready(f, 'claude');
  const chatgpt = ready(f, 'codex');

  const listed = run(f.stateDir, 'list', '--json');
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as Record<string, unknown>[];
  assert.deepEqual(rows.map((r) => r.tool), ['claude', 'codex'], 'one row per account, roster order');
  assert.deepEqual(rows.map((r) => r.id), [claude.id, chatgpt.id]);
  assert.ok(rows.every((r) => r.state === 'ready'));
  const allowed = new Set(['id', 'tool', 'name', 'state', 'restUntil', 'why', 'email', 'plan', 'addedAt', 'room', 'windows', 'readAt']);
  for (const row of rows) for (const key of Object.keys(row)) assert.ok(allowed.has(key), `unexpected row field ${key}`);
  assert.doesNotMatch(listed.stdout, /private-fake-token/, 'no native output reaches a row');

  // Codex room is read through the real `@byokit/usage` reader over the fake app-server; Claude has no
  // credential file in its managed folder, so its room is unknown and no request is made.
  const codex = rows.find((r) => r.tool === 'codex')!;
  assert.equal((codex.room as { left: number }).left, 10);
  assert.deepEqual((codex.windows as { usedPercent: number }[]).map((w) => w.usedPercent), [90]);
  assert.ok(typeof codex.readAt === 'number' && Date.now() - codex.readAt < 60_000);
  assert.equal((rows.find((r) => r.tool === 'claude')!.room as { left: string }).left, 'unknown');
});

test('pick --json: the same account, the same env and the same rows as cliAccounts.pick', async () => {
  const f = fixture('accounts-command-pick');
  ready(f, 'claude');
  const chatgpt = ready(f, 'codex');

  const picked = run(f.stateDir, 'pick', 'codex', '--json');
  assert.equal(picked.status, 0, picked.stderr);
  const answer = JSON.parse(picked.stdout) as { ok: boolean; id: string; room: { left: number }; set: Record<string, string>; unset: string[]; rows: { id: string; state: string }[] };
  const kit = kitOf(f);
  const expected = await kit.pick('codex');
  assert.ok(expected.ok);
  assert.equal(answer.ok, true);
  assert.equal(answer.id, expected.account.id);
  assert.equal(answer.id, chatgpt.id);
  assert.equal(answer.room.left, expected.room.left);
  assert.deepEqual(answer.set, kit.launchEnv(answer.id).set);
  assert.deepEqual(answer.unset, kit.launchEnv(answer.id).unset);
  const listed = JSON.parse(run(f.stateDir, 'list', '--json').stdout) as { id: string; tool: string }[];
  assert.deepEqual(answer.rows.map((r) => r.id), listed.filter((r) => r.tool === 'codex').map((r) => r.id), 'pick rows are the same rows list shows');

  // A resting account leaves no candidate: a plain refusal on stderr, exit 1, and every row still listed.
  const rested = run(f.stateDir, 'rest', chatgpt.id, '--until', String(Date.now() + 3_600_000), '--why', 'rate_limit');
  assert.equal(rested.status, 0, rested.stderr);
  const none = run(f.stateDir, 'pick', 'codex', '--json');
  assert.equal(none.status, 1);
  const refusal = JSON.parse(none.stdout) as { ok: boolean; reason: string; rows: { id: string; state: string }[] };
  assert.equal(refusal.ok, false);
  assert.equal(refusal.reason, 'No codex account can take a run right now.');
  assert.match(none.stderr, /No codex account can take a run right now\./);
  assert.deepEqual(refusal.rows.map((r) => [r.id, r.state]), [[chatgpt.id, 'resting']]);
});

test('rest and unrest round trip through the command and the file B1 persists', () => {
  const f = fixture('accounts-command-rests');
  const claude = ready(f, 'claude');
  const until = Date.now() + 3_600_000;

  const resting = run(f.stateDir, 'rest', claude.id, '--until', String(until), '--why', 'rate_limit');
  assert.equal(resting.status, 0, resting.stderr);
  const row = JSON.parse(resting.stdout) as { state: string; restUntil: number; id: string; tool: string };
  assert.deepEqual([row.id, row.tool, row.state, row.restUntil], [claude.id, 'claude', 'resting', until]);
  const file = join(f.stateDir, 'rests-v1.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, rests: [{ id: claude.id, until, why: 'rate_limit' }] });

  const shown = (JSON.parse(run(f.stateDir, 'list', '--json').stdout) as { state: string; restUntil?: number }[])[0]!;
  assert.deepEqual([shown.state, shown.restUntil], ['resting', until]);

  // A short wait is relative to now, and the default why is plain words.
  const short = run(f.stateDir, 'rest', claude.id, '--until', '45m');
  assert.equal(short.status, 0, short.stderr);
  const shortRow = JSON.parse(short.stdout) as { restUntil: number };
  assert.ok(shortRow.restUntil > Date.now() + 44 * 60_000 && shortRow.restUntil < Date.now() + 46 * 60_000);
  assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { rests: { why: string }[] }).rests[0]!.why, 'manual');

  const free = run(f.stateDir, 'unrest', claude.id);
  assert.equal(free.status, 0, free.stderr);
  assert.equal((JSON.parse(free.stdout) as { state: string }).state, 'ready');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, rests: [] });

  const unknown = run(f.stateDir, 'rest', 'pa_missing');
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.match(unknown.stderr, /Choose an account from the list\./);
});

test('a new folder shares only the plan table, never a sign-in file', () => {
  const f = fixture('accounts-command-prepare');
  const sharedSkills = join(f.root, 'agents-skills'); mkdirSync(sharedSkills);
  const claudeHome = join(f.home, '.claude'); mkdirSync(claudeHome);
  symlinkSync(sharedSkills, join(claudeHome, 'skills'));
  mkdirSync(join(claudeHome, 'agents')); mkdirSync(join(claudeHome, 'projects'));
  writeFileSync(join(claudeHome, 'settings.json'), '{"hooks":{"Stop":[]}}');
  writeFileSync(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{}}');
  writeFileSync(join(claudeHome, '.claude.json'), '{"trusted":true}');
  const codexHome = join(f.home, '.codex'); mkdirSync(codexHome);
  mkdirSync(join(codexHome, 'agents')); mkdirSync(join(codexHome, 'rules')); mkdirSync(join(codexHome, 'sessions')); mkdirSync(join(codexHome, 'log'));
  writeFileSync(join(codexHome, 'AGENTS.md'), '# rules');
  writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt-5"');
  writeFileSync(join(codexHome, 'auth.json'), '{"tokens":{}}');
  writeFileSync(join(codexHome, 'history.jsonl'), '{}');
  const piHome = join(f.home, '.pi', 'agent'); mkdirSync(piHome, { recursive: true });
  mkdirSync(join(piHome, 'extensions')); mkdirSync(join(piHome, 'skills')); mkdirSync(join(piHome, 'sessions'));
  writeFileSync(join(piHome, 'settings.json'), '{"theme":"dark"}');
  writeFileSync(join(piHome, 'models.json'), '{"apiKey":"ANTHROPIC_KEY"}');
  writeFileSync(join(piHome, 'auth.json'), '{"anthropic":{}}');
  writeFileSync(join(piHome, 'trust.json'), '{"trusted":true}');

  const added = (args: string[]) => {
    const result = run(f.stateDir, 'add', ...args);
    assert.equal(result.status, 0, result.stderr);
    const answer = JSON.parse(result.stdout) as { account: { id: string }; signIn: { argv: string[]; env: Record<string, string>; shell: string; instruction?: { command: string } } };
    return answer;
  };
  const folderOf = (env: Record<string, string>) => Object.values(env).find((value) => value.includes(f.stateDir))!;

  const claude = added(['claude']);
  assert.deepEqual(claude.signIn.argv, [f.bins.claude, 'auth', 'login', '--claudeai']);
  assert.match(claude.signIn.shell, /--claudeai/);
  const claudeFolder = folderOf(claude.signIn.env);
  assert.deepEqual(readdirSync(claudeFolder).sort(), [PENDING, 'agents', 'projects', 'settings.json', 'skills']);
  assert.equal(statSync(claudeFolder).mode & 0o777, 0o700);
  assert.equal(readlinkSync(join(claudeFolder, 'skills')), realpathSync(sharedSkills), 'skills links the person’s own shared skills');
  assert.equal(readlinkSync(join(claudeFolder, 'agents')), join(claudeHome, 'agents'));
  assert.equal(readlinkSync(join(claudeFolder, 'projects')), join(claudeHome, 'projects'), 'BYOKit’s own history link is left alone');
  assert.equal(readFileSync(join(claudeFolder, 'settings.json'), 'utf8'), readFileSync(join(claudeHome, 'settings.json'), 'utf8'));

  const codex = added(['codex']);
  assert.deepEqual(codex.signIn.argv, [f.bins.codex, 'login', '--device-auth']);
  assert.match(codex.signIn.shell, /--device-auth/);
  const codexFolder = folderOf(codex.signIn.env);
  assert.deepEqual(readdirSync(codexFolder).sort(), [PENDING, 'AGENTS.md', 'agents', 'config.toml', 'rules', 'sessions']);
  assert.equal(readlinkSync(join(codexFolder, 'AGENTS.md')), join(codexHome, 'AGENTS.md'));
  assert.equal(readlinkSync(join(codexFolder, 'sessions')), join(codexHome, 'sessions'));
  assert.equal(readFileSync(join(codexFolder, 'config.toml'), 'utf8'), 'model = "gpt-5"');

  const pi = added(['pi', '--provider', 'openai-codex']);
  assert.deepEqual(pi.signIn.argv, [f.bins.pi]);
  assert.equal(pi.signIn.instruction?.command, '/login openai-codex');
  const piFolder = folderOf(pi.signIn.env);
  assert.deepEqual(readdirSync(piFolder).sort(), [PENDING, 'extensions', 'sessions', 'settings.json', 'skills']);
  assert.equal(readlinkSync(join(piFolder, 'extensions')), join(piHome, 'extensions'));
  assert.equal(readFileSync(join(piFolder, 'settings.json'), 'utf8'), '{"theme":"dark"}');
  // Nothing linked is a sign-in file or Pi's models.json, and the command prints the next step.
  assert.doesNotMatch(readFileSync(join(f.stateDir, 'accounts-v1.json'), 'utf8'), /private-fake-token/);
});
