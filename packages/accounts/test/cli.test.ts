import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, CliAccountError, type CliProvider } from '../src/cli.ts';
import { scratchDir } from '../../test-support.ts';

function fake(dir: string, provider: CliProvider) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `${provider} 'fake`); const log = join(dir, `${provider}.jsonl`);
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),env:process.env})+'\\n');
const account = {email:'alice.work@example.test',planType:'plus',subscriptionType:'pro',access_token:'private-fake-token'};
if (process.argv[2] === 'app-server') {
 let b=''; process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const r=JSON.parse(b.slice(0,i));b=b.slice(i+1);console.log(JSON.stringify({id:r.id,result:r.id===1?{}:{account}}));}});
} else if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify({loggedIn:true,...account}));
`, { mode: 0o755 });
  return { bin, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) };
}

test('managed CLI flow: add, marker-gated status, native sign-in, rename, launch environment and remove', async () => {
  const root = scratchDir('cli-flow'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude'); const codex = fake(join(root, 'bins'), 'codex');
  const history = join(root, 'history'); mkdirSync(history); writeFileSync(join(history, 'keep'), 'history');
  const env = { HOME: join(root, 'home'), PATH: '/unused', EXTRA_PASSED: 'only-this' };
  const prepared: string[] = [];
  const kit = cliAccounts({ stateDir, bins: { claude: claude.bin, codex: codex.bin }, env,
    historyFrom: { claude: history, codex: history }, prepare: async (folder, provider) => { prepared.push(provider); assert.equal(statSync(folder).mode & 0o777, 0o700); } });
  assert.equal(kit.termsAcknowledged(), false); kit.acknowledgeTerms();
  assert.equal(readFileSync(join(stateDir, 'auto-terms-v1.json'), 'utf8'), '{"acknowledged":true}');
  for (const provider of ['claude', 'codex'] as const) {
    const { account, signIn } = await kit.add(provider);
    const folder = kit.launchEnv(account.id).set[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'];
    assert.equal(account.state, 'signing');
    assert.equal(readlinkSync(join(folder, provider === 'claude' ? 'projects' : 'sessions')), history);
    assert.equal((await kit.status(account.id)).state, 'signing', 'native true is not enough before the marker');
    assert.equal((await cliAccounts({ stateDir, bins: { claude: claude.bin, codex: codex.bin }, env }).status(account.id)).state, 'signing', 'pending survives host restart');
    const run = spawnSync('/bin/sh', ['-c', signIn.shell], { encoding: 'utf8', env: { AMBIENT_SECRET: 'never-inherit', PATH: '/unused' } });
    assert.equal(run.status, 0, run.stderr); assert.ok(existsSync(signIn.completion));
    assert.equal(statSync(signIn.completion).mode & 0o777, 0o600);
    const ready = await kit.status(account.id);
    assert.equal(ready.state, 'ready'); assert.equal(ready.email, 'alice.work@example.test');
    assert.equal(ready.name, 'Alice'); assert.doesNotMatch(JSON.stringify(ready), /private-fake-token|access_token/);
    assert.equal((await kit.rename(account.id, ' Work ')).name, 'Work');
    const launch = kit.launchEnv(account.id);
    assert.deepEqual(launch.set, { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: folder });
    assert.ok(launch.unset.includes(provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'));
    const source = kit.usageSource(account.id);
    assert.equal(source?.home, provider === 'codex' ? folder : undefined);
    assert.deepEqual(kit.kinds(provider), [provider]);
    assert.deepEqual(kit.resumeArgs(provider, { kind: 'id', value: 'conversation' }), provider === 'claude' ? ['--resume', 'conversation'] : ['resume', 'conversation']);
    assert.throws(() => kit.resumeArgs('pi', { kind: 'path', value: 'history' }), CliAccountError);
    const calls = (provider === 'claude' ? claude : codex).calls();
    const login = calls.find((c) => c.argv.includes(provider === 'claude' ? 'login' : '--device-auth'));
    assert.deepEqual(login.argv, provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth']);
    for (const call of calls) assert.deepEqual(call.env, signIn.env, 'status and login get exactly the passed environment plus the folder');
    const again = kit.signInAgain(account.id); assert.equal(existsSync(again.completion), false);
    assert.equal((await kit.status(account.id)).state, 'signing');
    await kit.remove(account.id); assert.equal(existsSync(folder), false);
    await assert.rejects(kit.status(account.id), CliAccountError);
  }
  assert.deepEqual(prepared, ['claude', 'codex']); assert.deepEqual(await kit.list(), []);
  assert.equal(readFileSync(join(history, 'keep'), 'utf8'), 'history');
  assert.equal(statSync(join(stateDir, 'accounts-v1.json')).mode & 0o777, 0o600);
});

test('legacy bytes, host-owned rows, rollback, cancellation and folder escape rejection', async () => {
  const root = scratchDir('cli-legacy'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude'); const env = { HOME: join(root, 'home'), PATH: '/unused' };
  mkdirSync(join(stateDir, 'claude', 'abcdef'), { recursive: true });
  const found = { id: 'found-claude', provider: 'claude', name: 'Default', folder: join(env.HOME, '.claude'), found: true };
  const managed = { id: 'pa_legacy', provider: 'claude', name: '', folder: join(stateDir, 'claude', 'abcdef'), found: false };
  const body = JSON.stringify({ version: 1, accounts: [found, managed] });
  writeFileSync(join(stateDir, 'accounts-v1.json'), body);
  const kit = cliAccounts({ stateDir, env, bins: { claude: claude.bin } });
  assert.equal((await kit.list()).length, 1); assert.equal(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'), body);
  assert.equal((await kit.status(managed.id)).state, 'ready', 'migration retains completed native sign-ins');
  await kit.rename(managed.id, 'Personal');
  assert.equal(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'), JSON.stringify({ version: 1, accounts: [found, { ...managed, name: 'Personal' }] }));
  await assert.rejects(kit.remove(found.id), CliAccountError);
  const added = await kit.add('claude'); const folder = kit.launchEnv(added.account.id).set.CLAUDE_CONFIG_DIR;
  assert.deepEqual(await kit.cancel(added.account.id), { removed: true }); assert.equal(existsSync(folder), false);
  const failing = cliAccounts({ stateDir, env, bins: { claude: claude.bin }, prepare: async () => { throw new Error('private-fake-token'); } });
  await assert.rejects(failing.add('claude'), (e: Error) => e instanceof CliAccountError && e.code === 'prepare-failed' && !e.message.includes('private-fake-token'));
  assert.deepEqual(readdirSync(join(stateDir, 'claude')), ['abcdef']);
  await assert.rejects(kit.rename(managed.id, ' '.repeat(4)), CliAccountError);
  await assert.rejects(kit.rename(managed.id, 'x'.repeat(65)), CliAccountError);
  assert.throws(() => cliAccounts({ stateDir: join(env.HOME, '.claude'), bins: {}, env }), CliAccountError);
  const outside = join(root, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'keep'), 'untouched');
  symlinkSync(outside, join(stateDir, 'claude', 'deadbeef'));
  writeFileSync(join(stateDir, 'accounts-v1.json'), JSON.stringify({ version: 1, accounts: [found, managed, { ...managed, id: 'escape', folder: outside }, { ...managed, id: 'symlink', folder: join(stateDir, 'claude', 'deadbeef') }] }));
  assert.deepEqual((await kit.list()).map((a) => a.id), [managed.id]);
  await assert.rejects(kit.remove('escape'), CliAccountError); await assert.rejects(kit.remove('symlink'), CliAccountError);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'untouched');
});
