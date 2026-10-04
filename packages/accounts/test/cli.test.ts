import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, nativePiAccount, CliAccountError, type CliProvider } from '../src/cli.ts';
import { resolveSelection } from '../src/multi.ts';
import { roomOf } from '@byokit/usage';
import { scratchDir } from '../../test-support.ts';

function fake(dir: string, provider: CliProvider) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `${provider} 'fake`); const log = join(dir, `${provider}.jsonl`);
  writeFileSync(log, '');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.env.STATUS_MODE === 'hang') process.on('SIGTERM',()=>{});
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv:process.argv.slice(2),env:process.env,pid:process.pid})+'\\n');
const account = {email:'alice.work@example.test',planType:'plus',subscriptionType:'pro',access_token:'private-fake-token'};
if (process.argv[2] === 'app-server') {
 let b=''; process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const r=JSON.parse(b.slice(0,i));b=b.slice(i+1);console.log(JSON.stringify({id:r.id,result:r.id===1?{}:{account}}));}});
} else if (process.argv[2] === 'auth' && process.argv[3] === 'check') {
 const provider = process.argv[process.argv.indexOf('--provider')+1];
 const mode = process.env.STATUS_MODE;
 if (mode === 'hang') setInterval(()=>{},1000);
 else if (mode === 'flood') console.log('x'.repeat(64*1024+1));
 else if (mode === 'malformed') console.log('private-fake-token');
 else if (mode === 'invalid') {console.log(JSON.stringify({status:'invalid',provider,reason:'private-fake-token'}));process.exitCode=2;}
 else if (mode === 'out') {console.log(JSON.stringify({status:'not_ready',provider}));process.exitCode=1;}
 else console.log(JSON.stringify({status:'ready',provider:mode==='wrong-provider'?'other':provider,authType:mode==='key'?'api_key':'oauth',access_token:'private-fake-token'}));
} else if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
 if (process.env.STATUS_MODE === 'hang') setInterval(()=>{},1000);
 else if (process.env.STATUS_MODE === 'flood') console.log('x'.repeat(256*1024+1));
 else console.log(JSON.stringify({loggedIn:true,...account}));
}
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
    const nowMs = 1_800_000_000_000;
    const usageReading = { provider, at: nowMs, windows: [{ provider, kind: 'session' as const, usedPercent: 12, resetsAt: nowMs + 300_000 }] };
    const pick = resolveSelection([ready], {}, { account: 'auto', model: 'passed-model' }, () => roomOf(usageReading, nowMs), nowMs);
    assert.equal(pick.ok, true);
    if (pick.ok) assert.equal(pick.account.id, ready.id);
    assert.equal(pick.considered[0].resetsAt, nowMs + 300_000, 'normalized usage milliseconds reach shared account selection unchanged');
    assert.equal((await kit.rename(account.id, ' Work ')).name, 'Work');
    const launch = kit.launchEnv(account.id);
    assert.deepEqual(launch.set, { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: folder });
    assert.ok(launch.unset.includes(provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'));
    const source = kit.usageSource(account.id);
    assert.equal(source?.home, provider === 'codex' ? folder : undefined);
    assert.deepEqual(kit.kinds(provider), [provider]);
    assert.deepEqual(kit.resumeArgs(provider, { kind: 'id', value: 'conversation' }), provider === 'claude' ? ['--resume', 'conversation'] : ['resume', 'conversation']);
    assert.deepEqual(kit.resumeArgs('pi', { kind: 'path', value: 'history' }), ['--session', 'history']);
    const calls = (provider === 'claude' ? claude : codex).calls();
    const login = calls.find((c) => c.argv.includes(provider === 'claude' ? 'login' : '--device-auth'));
    assert.deepEqual(login.argv, provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth']);
    for (const call of calls) assert.deepEqual(call.env, signIn.env, 'status and login get exactly the passed environment plus the folder');
    const reading = kit.status(account.id);
    assert.throws(() => kit.signInAgain(account.id), CliAccountError, 'a synchronous sign-in cannot race an in-flight identity read');
    assert.equal((await reading).state, 'ready');
    const again = kit.signInAgain(account.id); assert.equal(existsSync(again.completion), false);
    assert.equal((await kit.status(account.id)).state, 'signing');
    await kit.remove(account.id); assert.equal(existsSync(folder), false);
    await assert.rejects(kit.status(account.id), CliAccountError);
  }
  assert.deepEqual(prepared, ['claude', 'codex']); assert.deepEqual(await kit.list(), []);
  assert.equal(readFileSync(join(history, 'keep'), 'utf8'), 'history');
  assert.equal(statSync(join(stateDir, 'accounts-v1.json')).mode & 0o777, 0o600);
});

test('read-only native Pi descriptor selects only an independent owned folder and exact session', () => {
  const root = scratchDir('cli-pi'); const home = join(root, 'home'); const stateDir = join(root, 'plans');
  const folder = join(stateDir, 'pi', 'abcdef'); mkdirSync(folder, { recursive: true });
  const auth = join(folder, 'auth.json'); writeFileSync(auth, 'unreadable-fixture-grant', { mode: 0 });
  const descriptor = nativePiAccount({ stateDir, folder, bin: '/app/bin/pi', home });
  assert.equal(descriptor.kind, 'pi'); assert.equal(descriptor.bin, '/app/bin/pi');
  assert.deepEqual(descriptor.launch.set, { PI_CODING_AGENT_DIR: folder });
  assert.deepEqual(descriptor.resumeArgs({ kind: 'path', value: join(root, 'umer.jsonl') }), ['--session', join(root, 'umer.jsonl')]);
  assert.deepEqual(descriptor.resumeArgs({ kind: 'id', value: '11111111-1111-4111-8111-111111111111' }), ['--session', '11111111-1111-4111-8111-111111111111']);
  for (const value of ['', '--resume', 'bad\u0000value']) assert.throws(() => descriptor.resumeArgs({ kind: 'path', value }), CliAccountError);
  assert.throws(() => nativePiAccount({ stateDir, folder: home, bin: '/app/bin/pi', home }), CliAccountError);
  assert.throws(() => nativePiAccount({ stateDir: join(home, '.pi'), folder, bin: '/app/bin/pi', home }), CliAccountError);
  assert.throws(() => nativePiAccount({ stateDir, folder, bin: 'pi', home }), CliAccountError);
  symlinkSync(folder, join(stateDir, 'pi', 'deadbeef'));
  assert.throws(() => nativePiAccount({ stateDir, folder: join(stateDir, 'pi', 'deadbeef'), bin: '/app/bin/pi', home }), CliAccountError);
  assert.equal(statSync(auth).mode & 0o777, 0, 'descriptor does not modify grants');
});

test('missing provider binary keeps list and Auto isolated without consuming pending markers', async () => {
  const root = scratchDir('cli-unavailable'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude');
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const unavailable = { id: 'pa_umer_codex', provider: 'codex', name: 'Umer', folder: join(stateDir, 'codex', 'abcdef'), found: false };
  const ready = { id: 'pa_umer_claude', provider: 'claude', name: 'Umer Work', folder: join(stateDir, 'claude', 'abcdef'), found: false };
  for (const r of [unavailable, ready]) mkdirSync(r.folder, { recursive: true });
  const pending = join(unavailable.folder, '.byokit-signin-pending'); writeFileSync(pending, 'pending');
  const roster = JSON.stringify({ version: 1, accounts: [unavailable, ready] });
  writeFileSync(join(stateDir, 'accounts-v1.json'), roster);
  const kit = cliAccounts({ stateDir, env, bins: { claude: claude.bin } });
  const rows = await kit.list();
  assert.deepEqual(rows.map(r => r.state), ['not_included', 'ready']);
  assert.equal((await kit.status(unavailable.id)).state, 'not_included');
  assert.equal(readFileSync(pending, 'utf8'), 'pending');
  assert.equal(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'), roster);
  const pick = resolveSelection(rows, {}, { account: 'auto', model: 'passed-model' }, () => ({ left: 'unknown' }), Date.now());
  assert.equal(pick.ok, true); if (pick.ok) assert.equal(pick.account.id, ready.id);
  assert.throws(() => kit.signInAgain(unavailable.id), e => e instanceof CliAccountError && e.code === 'bad-option');
  await assert.rejects(kit.add('codex'), e => e instanceof CliAccountError && e.code === 'bad-option');
  assert.throws(() => kit.usageSource(unavailable.id), e => e instanceof CliAccountError && e.code === 'bad-option');
  const restored = cliAccounts({ stateDir, env, bins: { codex: fake(join(root, 'bins'), 'codex').bin } });
  assert.equal((await restored.status(unavailable.id)).state, 'signing', 'availability does not complete a pending login');
});

test('native Claude status resolves at its deadline and reaps a child that ignores termination', async (t) => {
  const root = scratchDir('cli-deadline'); const claude = fake(join(root, 'bins'), 'claude');
  const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { claude: claude.bin }, env: { HOME: join(root, 'home'), PATH: '/unused', STATUS_MODE: 'hang' } });
  const { account, signIn } = await kit.add('claude'); writeFileSync(signIn.completion, 'complete', { mode: 0o600 });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = kit.status(account.id);
  const end = Date.now() + 5000;
  while (claude.calls().length === 0 && Date.now() < end) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(claude.calls().length, 1);
  const pid = claude.calls()[0].pid;
  t.mock.timers.tick(15_000); assert.equal((await pending).state, 'signed_out');
  t.mock.timers.tick(1000);
  let alive = true;
  for (let i = 0; i < 1000 && alive; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the owned child is reaped after escalation');
  // Overflow resolves before child close; its late cleanup must not clear a later test's mocked timer.
  t.mock.timers.reset();
  const flood = cliAccounts({ stateDir: join(root, 'plans'), bins: { claude: claude.bin }, env: { HOME: join(root, 'home'), PATH: '/unused', STATUS_MODE: 'flood' } });
  assert.equal((await flood.status(account.id)).state, 'signed_out');
});

test('Pi auth-check deadline is bounded and reaps only its owned child', async (t) => {
  const root = scratchDir('pi-deadline'); const pi = fake(join(root, 'bins'), 'pi');
  const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { pi: pi.bin }, env: { HOME: join(root, 'home'), PATH: '/unused', STATUS_MODE: 'hang' } });
  const { account } = await kit.add('pi', { piProvider: 'openai-codex' });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = kit.status(account.id);
  const end = Date.now() + 5000;
  while (!pi.calls().length && Date.now() < end) await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(pi.calls().length, 1); const pid = pi.calls()[0].pid;
  t.mock.timers.tick(15_000);
  const result = await pending; assert.equal(result.state, 'signed_out'); assert.equal(result.why, 'unknown');
  t.mock.timers.tick(1000);
  let alive = true;
  for (let i = 0; i < 1000 && alive; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false);
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
  symlinkSync(outside, join(root, 'alias'));
  assert.throws(() => cliAccounts({ stateDir: join(root, 'alias', 'new'), bins: {}, env }), CliAccountError);
  assert.equal(existsSync(join(outside, 'new')), false, 'an ancestor alias is rejected before folder creation');
  const attacked = await kit.add('claude');
  symlinkSync(join(outside, 'keep'), attacked.signIn.completion);
  const result = spawnSync('/bin/sh', ['-c', attacked.signIn.shell], { encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'completion creation cannot clobber a linked outside file');
  await assert.rejects(kit.status(attacked.account.id), CliAccountError);
  assert.equal(readFileSync(join(outside, 'keep'), 'utf8'), 'untouched');
  await kit.remove(attacked.account.id);
});


test('managed Pi uses TUI instructions, OAuth-only readiness, isolated roster and ready-only Auto', async () => {
  const root = scratchDir('managed-pi'); const pi = fake(join(root, 'bins'), 'pi');
  const stateDir = join(root, 'plans'); const env = { HOME: join(root, 'home'), PATH: '/unused', PI_CODING_AGENT_DIR: '/forbidden', PI_CODING_AGENT_SESSION_DIR: '/forbidden', ANTHROPIC_API_KEY: 'canary-secret', OPENAI_API_KEY: 'canary-secret', CLAUDE_CONFIG_DIR: '/forbidden', CODEX_HOME: '/forbidden' };
  const make = (mode = 'oauth', bins: Partial<Record<CliProvider, string>> = { pi: pi.bin }) => cliAccounts({ stateDir, bins, env: { ...env, STATUS_MODE: mode } });
  const kit = make(); const { account, signIn } = await kit.add('pi', { piProvider: 'openai-codex' });
  const folder = kit.launchEnv(account.id).set.PI_CODING_AGENT_DIR;
  assert.equal(account.name, 'ChatGPT'); assert.equal(account.piProvider, 'openai-codex');
  assert.deepEqual(signIn.argv, [pi.bin]); assert.deepEqual(signIn.instruction, { words: 'cli.piLogin', command: '/login openai-codex' });
  assert.ok(!signIn.shell.includes('/login')); assert.deepEqual(kit.launchArgs(account.id), ['--provider', 'openai-codex']);
  assert.deepEqual(kit.kinds('pi'), ['pi']); assert.equal(kit.usageSource(account.id), undefined);
  for (const kind of ['id', 'path'] as const) assert.deepEqual(kit.resumeArgs('pi', { kind, value: 'session.jsonl' }), ['--session', 'session.jsonl']);
  for (const value of ['', '--flag', 'bad\0value']) assert.throws(() => kit.resumeArgs('pi', { kind: 'id', value }), CliAccountError);
  await assert.rejects(kit.add('pi', { piProvider: 'qwen-portal' }), CliAccountError);
  await assert.rejects(kit.add('pi', { piProvider: 'openai-codex; echo secret' }), CliAccountError);
  const login = spawnSync('/bin/sh', ['-c', signIn.shell], { encoding: 'utf8', env: { AMBIENT_SECRET: 'canary-secret' } });
  assert.equal(login.status, 0, login.stderr); assert.equal(existsSync(signIn.completion), false, 'TUI exit is not sign-in completion');
  assert.equal((await make('out').status(account.id)).state, 'signing');
  const ready = await kit.status(account.id); assert.equal(ready.state, 'ready');
  assert.equal(ready.email, undefined); assert.equal(ready.plan, undefined); assert.equal(ready.why, undefined);
  assert.equal(existsSync(join(folder, '.byokit-signin-pending')), false);
  await kit.rename(account.id, 'Personal ChatGPT');
  assert.equal((await make().status(account.id)).name, 'Personal ChatGPT', 'identity survives restart');
  for (const [mode, why] of [['key', 'api_key'], ['invalid', 'unknown'], ['malformed', 'unknown'], ['flood', 'unknown'], ['wrong-provider', 'unknown'], ['out', undefined]] as const) {
    const row = await make(mode).status(account.id); assert.equal(row.state, 'signed_out'); assert.equal(row.why, why);
    assert.doesNotMatch(JSON.stringify(row), /private-fake-token|access_token/);
    assert.equal(resolveSelection([row], {}, { account: 'auto', model: 'passed-model' }, () => ({ left: 'unknown' }), Date.now()).ok, false);
  }
  assert.equal(resolveSelection([ready], {}, { account: 'auto', model: 'passed-model' }, () => ({ left: 'unknown' }), Date.now()).ok, true);
  assert.equal((await make('oauth', {}).status(account.id)).state, 'not_included');
  const calls = pi.calls();
  assert.deepEqual(calls[0].argv, []);
  for (const c of calls) {
    assert.equal(c.env.PI_CODING_AGENT_DIR, folder);
    assert.doesNotMatch(JSON.stringify(c), /canary-secret|forbidden/);
    if (c.argv.length) assert.deepEqual(c.argv, ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh']);
  }
  const roster = join(stateDir, 'pi-accounts-v1.json'); const bytes = readFileSync(roster, 'utf8');
  assert.equal(existsSync(join(stateDir, 'accounts-v1.json')), false);
  // An old loader's complete legacy-roster rewrite does not know about or destroy Pi rows.
  writeFileSync(join(stateDir, 'accounts-v1.json'), JSON.stringify({ version: 1, accounts: [] }));
  const claude = fake(join(root, 'bins'), 'claude');
  const legacy = cliAccounts({ stateDir, bins: { claude: claude.bin }, env });
  const added = await legacy.add('claude'); await legacy.rename(added.account.id, 'Work'); await legacy.remove(added.account.id);
  assert.equal(readFileSync(roster, 'utf8'), bytes);
  assert.equal((await make().status(account.id)).name, 'Personal ChatGPT');
  const pending = await kit.add('pi', { piProvider: 'github-copilot' });
  assert.deepEqual(await make('out').cancel(pending.account.id), { removed: false }, 'restart cancellation keeps named account');
  assert.equal((await make('out').status(pending.account.id)).state, 'signed_out');
  assert.deepEqual(await kit.cancel(pending.account.id), { removed: true });
});

test('explicit adoption maps found metadata to new empty managed folders, idempotently and cancellably', async () => {
  const root = scratchDir('cli-adopt'); const stateDir = join(root, 'plans'); mkdirSync(stateDir);
  const bins = Object.fromEntries((['claude', 'codex', 'pi'] as const).map(p => [p, fake(join(root, 'bins'), p).bin]));
  const env = { HOME: join(root, 'home'), PATH: '/unused', STATUS_MODE: 'out' };
  const found = (['claude', 'codex', 'pi'] as const).map(provider => ({ id: `found-${provider}`, provider, name: `Found ${provider}`, folder: join(root, `source-${provider}`), found: true }));
  for (const row of found) { mkdirSync(row.folder); writeFileSync(join(row.folder, 'auth.json'), 'never-copy-secret'); }
  writeFileSync(join(stateDir, 'accounts-v1.json'), JSON.stringify({ version: 1, accounts: found }));
  const prepared: string[] = [];
  const kit = cliAccounts({ stateDir, bins, env, prepare: async folder => { prepared.push(folder); assert.equal(existsSync(join(folder, 'auth.json')), false); } });
  for (const row of found) {
    assert.throws(() => kit.signInAgain(row.id), e => e instanceof CliAccountError && e.code === 'unknown-account');
    const metadata = row.provider === 'pi' ? { piProvider: 'openai-codex' } : undefined;
    if (row.provider === 'pi') await assert.rejects(kit.adopt(row.id), e => e instanceof CliAccountError && e.code === 'bad-option');
    const [first, again] = await Promise.all([kit.adopt(row.id, metadata), kit.adopt(row.id, metadata)]);
    assert.equal(first.account.id, again.account.id); assert.equal(first.account.adoptedFrom, row.id); assert.equal(first.account.name, row.name);
    const folder = Object.values(kit.launchEnv(first.account.id).set)[0];
    assert.notEqual(folder, row.folder); assert.equal(existsSync(join(folder, 'auth.json')), false);
    assert.equal(readFileSync(join(row.folder, 'auth.json'), 'utf8'), 'never-copy-secret');
    const restarted = cliAccounts({ stateDir, bins, env });
    assert.equal((await restarted.adopt(row.id, metadata)).account.id, first.account.id);
    await assert.rejects(kit.adopt(first.account.id), e => e instanceof CliAccountError && e.code === 'unknown-account');
    assert.deepEqual(await kit.cancel(first.account.id), { removed: true }); assert.equal(existsSync(folder), false);
    assert.equal(readFileSync(join(row.folder, 'auth.json'), 'utf8'), 'never-copy-secret');
  }
  assert.equal(prepared.length, 3);
  await assert.rejects(kit.adopt('found-missing'), e => e instanceof CliAccountError && e.code === 'unknown-account');
  const roster = JSON.parse(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'));
  assert.deepEqual(roster.accounts, found);
});
