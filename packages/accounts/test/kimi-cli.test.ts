// Managed Kimi Code CLI: two app-owned accounts, each with its own KIMI_CODE_HOME.
// Fake binary only; never a real login or the owner's ~/.kimi-code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, CliAccountError } from '../src/cli.ts';
import { scratchDir } from '../../test-support.ts';

function fakeKimi(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'kimi-fake');
  const log = join(dir, 'kimi.jsonl');
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
if (process.argv[2] === 'login') process.exit(0);
process.exit(2);
`, { mode: 0o755 });
  return {
    bin,
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; env: Record<string, string> }),
  };
}

async function finishSignIn(kit: ReturnType<typeof cliAccounts>, id: string, shell: string) {
  const run = spawnSync('/bin/sh', ['-c', shell], { encoding: 'utf8', env: { PATH: '/unused' } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await kit.status(id)).state, 'ready');
}

test('kimi two accounts: isolated folders, resume, remove, default-login guard', async () => {
  const root = scratchDir('kimi-cli-two');
  const stateDir = join(root, 'plans');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const kimi = fakeKimi(join(root, 'bins'));
  const parent = join(stateDir, 'kimi');
  const env = {
    HOME: home,
    PATH: '/unused',
    KIMI_API_KEY: 'owner-key-override',
    KIMI_CODE_CREDENTIALS: join(home, '.kimi-code', 'credentials', 'kimi-code.json'),
  };
  const kit = cliAccounts({ stateDir, bins: { kimi: kimi.bin }, env });

  const { account: a, signIn: signA } = await kit.add('kimi');
  assert.equal(a.provider, 'kimi');
  assert.equal(a.state, 'signing');
  assert.deepEqual(signA.argv, [kimi.bin, 'login']);
  assert.ok(signA.env.KIMI_CODE_HOME.startsWith(parent + '/'));
  assert.equal(signA.env.KIMI_API_KEY, undefined, 'owner key override is unset at login');
  assert.equal(signA.env.KIMI_CODE_CREDENTIALS, undefined);
  await finishSignIn(kit, a.id, signA.shell);

  const { account: b, signIn: signB } = await kit.add('kimi');
  assert.ok(signB.env.KIMI_CODE_HOME.startsWith(parent + '/'));
  assert.notEqual(signA.env.KIMI_CODE_HOME, signB.env.KIMI_CODE_HOME);
  await finishSignIn(kit, b.id, signB.shell);

  const launchA = await kit.launch(a.id);
  const launchB = await kit.launch(b.id);
  assert.equal(launchA.ok, true);
  assert.equal(launchB.ok, true);
  if (launchA.ok && launchB.ok) {
    assert.notEqual(launchA.set.KIMI_CODE_HOME, launchB.set.KIMI_CODE_HOME);
    assert.equal(launchA.set.KIMI_CODE_HOME, signA.env.KIMI_CODE_HOME);
    assert.equal(launchB.set.KIMI_CODE_HOME, signB.env.KIMI_CODE_HOME);
    assert.ok(launchA.unset.includes('KIMI_API_KEY'));
    assert.ok(launchA.unset.includes('KIMI_CODE_CREDENTIALS'));
  }

  assert.deepEqual(kit.resumeArgs('kimi', { kind: 'id', value: 'ses_1' }), ['--session', 'ses_1']);
  assert.throws(() => kit.resumeArgs('kimi', { kind: 'id', value: '-sneaky' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => kit.resumeArgs('kimi', { kind: 'id', value: '' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => kit.resumeArgs('kimi', { kind: 'path', value: 'ses_1' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');

  await kit.remove(a.id);
  assert.equal((await kit.status(b.id)).state, 'ready');
  assert.equal((await kit.launch(b.id)).ok, true);
  await assert.rejects(kit.status(a.id), CliAccountError);

  for (const call of kimi.calls()) {
    assert.deepEqual(call.argv, ['login']);
    assert.ok(call.env.KIMI_CODE_HOME.startsWith(parent + '/'));
    assert.equal(call.env.KIMI_API_KEY, undefined);
    assert.equal(call.env.KIMI_CODE_CREDENTIALS, undefined);
  }

  assert.throws(() => cliAccounts({ stateDir: join(home, '.kimi-code'), bins: { kimi: kimi.bin }, env: { HOME: home, PATH: '/unused' } }),
    (e: unknown) => e instanceof CliAccountError && e.code === 'bad-option');
});
