import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, nativePiAccount, CliAccountError, type CliProvider } from '../src/cli.ts';
import { resolveSelection } from '../src/multi.ts';
import { clock, say } from '../src/words.ts';
import { roomOf, usage } from '@byokit/usage';
import { fakeFetch } from '@byokit/usage/testing';
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
 const mode = process.env.STATUS_MODE;
 const attempt = fs.readFileSync(${JSON.stringify(log)}, 'utf8').trim().split('\\n').length;
 if (mode === 'exit' || mode === 'exit-once' && attempt === 1) { console.error('private-fake-token alice.work@example.test private-account-id'); process.exit(23); }
 if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
 if (mode === 'write') { fs.closeSync(0); console.log(JSON.stringify({id:1,result:{}})); setInterval(()=>{},1000); return; }
 let b=''; process.stdin.on('data',c=>{b+=c;for(;;){const i=b.indexOf('\\n');if(i<0)break;const r=JSON.parse(b.slice(0,i));b=b.slice(i+1);
  if (mode === 'timeout' || mode === 'timeout-once' && attempt === 1) continue;
  if (mode === 'rpc-init' || mode === 'rpc' && r.id === 2) { console.log(JSON.stringify({id:r.id,error:{code:-32603,message:'private-fake-token',data:{email:'alice.work@example.test'}}})); continue; }
  if (r.id === 1) { console.log(JSON.stringify({id:1,result:{}})); continue; }
  if (mode === 'flood') { console.log('x'.repeat(65537)); continue; }
  const result = mode === 'out' ? {account:null,requiresOpenaiAuth:true} : mode === 'reply' ? {} : mode === 'malformed' ? null : mode === 'array' ? {account:[]} : mode === 'recorded'
   ? {account:{type:'chatgpt',email:'umer@example.test',planType:'prolite'},requiresOpenaiAuth:true,workspaceRouting:{chatgptAccountId:'private-account-id',backendOrigin:'https://chatgpt.com',accountRoutingOverride:'NO_CONSTRAINT'}} : {account};
  console.log(JSON.stringify({id:r.id,result}));
 }});
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
 else console.log(JSON.stringify({loggedIn:process.env.STATUS_MODE !== 'out',...account,...(process.env.AUTH_METHOD && {authMethod:process.env.AUTH_METHOD})}));
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
    const signing = await kit.launch(account.id);
    assert.equal(signing.ok, false);
    if (!signing.ok) { assert.equal(signing.code, 'signed_out'); assert.equal(signing.message, `Sign in to ${account.name} first.`); }
    assert.ok(!('set' in signing) && !('unset' in signing));
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
    const launch = await kit.launch(account.id);
    assert.equal(launch.ok, true);
    assert.equal(launch.account.id, account.id);
    if (provider === 'claude') {
      const signedOut = await cliAccounts({ stateDir, bins: { claude: claude.bin }, env: { ...env, STATUS_MODE: 'out' } }).launch(account.id);
      assert.equal(signedOut.ok, false);
      if (!signedOut.ok) { assert.equal(signedOut.code, 'signed_out'); assert.equal(signedOut.message, 'Sign in to Work first.'); }
      assert.ok(!('set' in signedOut) && !('unset' in signedOut));
    }
    assert.deepEqual(launch.set, { [provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']: folder });
    assert.ok(launch.unset.includes(provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'));
    const source = await kit.usageSource(account.id);
    assert.equal(source?.provider === 'codex' ? source.home : undefined, provider === 'codex' ? folder : undefined);
    assert.deepEqual(kit.kinds(provider), [provider]);
    assert.deepEqual(kit.resumeArgs(provider, { kind: 'id', value: 'conversation' }), provider === 'claude' ? ['--resume', 'conversation'] : ['resume', 'conversation']);
    assert.deepEqual(kit.resumeArgs('pi', { kind: 'path', value: 'history' }), ['--session', 'history']);
    const calls = (provider === 'claude' ? claude : codex).calls();
    const login = calls.find((c) => c.argv.includes(provider === 'claude' ? 'login' : '--device-auth'));
    assert.deepEqual(login.argv, provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login', '--device-auth']);
    for (const call of calls) assert.deepEqual(call.env, { ...signIn.env, ...(call.env.STATUS_MODE === 'out' ? { STATUS_MODE: 'out' } : {}) }, 'status and login get exactly the passed environment plus the folder');
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
  const refused = await kit.launch(unavailable.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) { assert.equal(refused.code, 'not_included'); assert.equal(refused.message, "Umer can't start on this computer yet."); }
  assert.ok(!('set' in refused) && !('unset' in refused));
  assert.equal(readFileSync(pending, 'utf8'), 'pending');
  assert.equal(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'), roster);
  const pick = resolveSelection(rows, {}, { account: 'auto', model: 'passed-model' }, () => ({ left: 'unknown' }), Date.now());
  assert.equal(pick.ok, true); if (pick.ok) assert.equal(pick.account.id, ready.id);
  assert.throws(() => kit.signInAgain(unavailable.id), e => e instanceof CliAccountError && e.code === 'bad-option');
  await assert.rejects(kit.add('codex'), e => e instanceof CliAccountError && e.code === 'bad-option');
  await assert.rejects(kit.usageSource(unavailable.id), e => e instanceof CliAccountError && e.code === 'bad-option');
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
  // The escalation SIGKILLs at once, but kill(pid, 0) also succeeds on the dead-but-unreaped zombie until this
  // process reaps it, so bound the wait on the clock like the spawn wait above instead of a loop count.
  let alive = true;
  const reaped = Date.now() + 5000;
  while (alive && Date.now() < reaped) {
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
  // A hung pi this status call did not start: the deadline must never signal a process it does not own.
  const sibling = spawn(pi.bin, ['auth', 'check', '--provider', 'openai-codex', '--json', '--no-refresh'], { env: { STATUS_MODE: 'hang' }, stdio: 'ignore' });
  t.after(() => { sibling.kill('SIGKILL'); });
  const booted = Date.now() + 5000;
  while (!pi.calls().some(c => c.pid === sibling.pid) && Date.now() < booted) await new Promise<void>(resolve => setImmediate(resolve));
  assert.ok(pi.calls().some(c => c.pid === sibling.pid), 'the unrelated hung pi is running');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = kit.status(account.id);
  const end = Date.now() + 5000;
  while (!pi.calls().some(c => c.pid !== sibling.pid) && Date.now() < end) await new Promise<void>(resolve => setImmediate(resolve));
  const owned = pi.calls().find(c => c.pid !== sibling.pid);
  assert.ok(owned, 'the status call started its own child'); const pid = owned.pid;
  t.mock.timers.tick(15_000);
  const result = await pending; assert.equal(result.state, 'signed_out'); assert.equal(result.why, 'unknown');
  t.mock.timers.tick(1000);
  let alive = true;
  const reaped = Date.now() + 5000;
  while (alive && Date.now() < reaped) {
    await new Promise<void>(resolve => setImmediate(resolve));
    try { process.kill(pid, 0); } catch { alive = false; }
  }
  assert.equal(alive, false, 'the owned child is reaped after escalation');
  let siblingAlive = true;
  const settle = Date.now() + 500;
  while (Date.now() < settle) await new Promise<void>(resolve => setImmediate(resolve));
  try { process.kill(sibling.pid!, 0); } catch { siblingAlive = false; }
  assert.equal(siblingAlive, true, 'the escalation never signals a process it does not own');
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
  const managedStatus = await kit.status(managed.id);
  assert.equal(managedStatus.state, 'ready', 'migration retains completed native sign-ins');
  assert.ok(typeof managedStatus.addedAt === 'number' && Number.isSafeInteger(managedStatus.addedAt) && managedStatus.addedAt > 0, 'a legacy row derives addedAt from its folder');
  await kit.rename(managed.id, 'Personal');
  assert.equal(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'), JSON.stringify({ version: 1, accounts: [found, { ...managed, name: 'Personal', addedAt: managedStatus.addedAt }] }));
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
  assert.ok(!signIn.shell.includes('/login')); assert.deepEqual(kit.launchArgs(account.id, 'gpt-6-sol'), ['--provider', 'openai-codex', '--model', 'gpt-6-sol']);
  // Pi's own per-provider default model is never used: no chosen model, no launch argv.
  for (const none of [undefined, '', '  ', '--provider']) assert.throws(() => kit.launchArgs(account.id, none), /^Error: Choose a model for openai-codex first: /);
  assert.deepEqual(kit.kinds('pi'), ['pi']);
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'pi', folder, piProvider: 'openai-codex' });
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
  assert.equal(await kit.usageSource(pending.account.id), undefined, 'a Pi provider with no quota route stays unknown');
  assert.deepEqual(await kit.cancel(pending.account.id), { removed: true });
});

test('managed Pi room comes from the folder login; a Pi provider with no route stays unknown', async () => {
  const root = scratchDir('pi-cli-usage'); const stateDir = join(root, 'plans');
  const bins = { pi: fake(join(root, 'bins'), 'pi').bin };
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  // ChatGPT's Codex windows and Kimi's weekly window, each from the account's own folder login.
  const codexQuota = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1788616800 },
    secondary_window: { used_percent: 60, limit_window_seconds: 604800, reset_at: 1788616800 } } };
  const kimiQuota = { usage: { limit: 100, remaining: 40, resetTime: '2026-09-05T14:00:00Z' } };
  const http = fakeFetch([{ body: codexQuota }, { body: kimiQuota }, { body: codexQuota }]);
  const kit = cliAccounts({ stateDir, bins, env, usage: usage({ stateDir, fetch: http.fetch }) });
  const login = (id: string, piProvider: string, token: unknown) =>
    writeFileSync(join(kit.folderOf(id), 'auth.json'), JSON.stringify({ [piProvider]: token }));
  const chatgpt = await kit.add('pi', { piProvider: 'openai-codex' });
  const kimi = await kit.add('pi', { piProvider: 'kimi-coding' });
  const copilot = await kit.add('pi', { piProvider: 'github-copilot' });
  const chatgptFolder = kit.folderOf(chatgpt.account.id); const kimiFolder = kit.folderOf(kimi.account.id);
  for (const id of [chatgpt.account.id, kimi.account.id, copilot.account.id]) assert.equal((await kit.status(id)).state, 'ready');
  assert.deepEqual(await kit.usageSource(chatgpt.account.id), { provider: 'pi', folder: chatgptFolder, piProvider: 'openai-codex' });
  assert.equal(await kit.usageSource(copilot.account.id), undefined, 'a Pi provider with no quota route stays unknown');
  assert.notEqual(chatgptFolder, kimiFolder, 'each Pi account keeps its own login folder');
  login(chatgpt.account.id, 'openai-codex', { type: 'oauth', access: 'codex-access-token', refresh: 'codex-refresh', expires: 0, accountId: 'acct-pi' });
  login(kimi.account.id, 'kimi-coding', { type: 'oauth', access: 'kimi-access-token', refresh: 'kimi-refresh', expires: 0 });
  const picked = await kit.pick('pi');
  assert.equal(picked.ok, true);
  if (!picked.ok) throw new Error('the ready pi row was not picked');
  const byId = (id: string) => picked.rows.find((r) => r.account.id === id)!;
  assert.equal(picked.account.id, chatgpt.account.id, 'equal room keeps list order');
  assert.equal(byId(chatgpt.account.id).room.left, 40);
  assert.deepEqual(byId(chatgpt.account.id).windows, [
    { provider: 'pi', kind: 'session', usedPercent: 25, minutes: 300, resetsAt: 1788616800000 },
    { provider: 'pi', kind: 'weekly', usedPercent: 60, minutes: 10080, resetsAt: 1788616800000 }]);
  assert.equal(byId(kimi.account.id).room.left, 40);
  assert.deepEqual(byId(kimi.account.id).windows, [{ provider: 'pi', kind: 'weekly', usedPercent: 60, minutes: 10080, resetsAt: 1788616800000 }]);
  assert.equal(byId(copilot.account.id).room.left, 'unknown');
  assert.ok(picked.rows.every((r) => r.room.left !== 0), 'no pi row reports zero room');
  assert.equal(http.calls.length, 2);
  assert.equal(http.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal((http.calls[0].init?.headers as Record<string, string>)['ChatGPT-Account-Id'], 'acct-pi');
  assert.equal((http.calls[0].init?.headers as Record<string, string>).authorization, 'Bearer codex-access-token');
  assert.equal(http.calls[1].url, 'https://api.kimi.com/coding/v1/usages');
  assert.equal((http.calls[1].init?.headers as Record<string, string>).authorization, 'Bearer kimi-access-token');
  assert.doesNotMatch(JSON.stringify(picked), /codex-access-token|kimi-access-token|codex-refresh/);
  // The ChatGPT account id also comes from the access token's own claim, as Pi's sign-in flow reads it.
  const claim = (payload: unknown) => `eyJhbGciOiJSUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
  login(chatgpt.account.id, 'openai-codex', { type: 'oauth', access: claim({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-claim' } }), refresh: 'r', expires: 0 });
  assert.equal((await kit.pick('pi')).rows.find((r) => r.account.id === chatgpt.account.id)!.room.left, 40);
  assert.equal((http.calls[2].init?.headers as Record<string, string>)['ChatGPT-Account-Id'], 'acct-claim');
  // Without either account id the route cannot be addressed, so the room stays unknown, never zero.
  login(chatgpt.account.id, 'openai-codex', { type: 'oauth', access: 'plain-access-token', refresh: 'r', expires: 0 });
  assert.equal((await kit.pick('pi')).rows.find((r) => r.account.id === chatgpt.account.id)!.room.left, 'unknown');
  assert.equal(http.calls.length, 3, 'a credential with no addressable account sends no request');
  // Losing the folder login leaves every row unknown, never zero.
  rmSync(join(chatgptFolder, 'auth.json')); rmSync(join(kimiFolder, 'auth.json'));
  const lost = await kit.pick('pi');
  assert.equal(lost.rows.length, 3);
  assert.ok(lost.rows.every((r) => r.room.left === 'unknown'), 'a missing reading is unknown, never zero');
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

test('two CLI logins with the same email stay distinguishable by addedAt', async () => {
  const root = scratchDir('cli-distinct'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude');
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { claude: claude.bin }, env });
  const first = await kit.add('claude'); writeFileSync(first.signIn.completion, 'complete', { mode: 0o600 });
  const second = await kit.add('claude'); writeFileSync(second.signIn.completion, 'complete', { mode: 0o600 });
  assert.equal(typeof first.account.addedAt, 'number');
  assert.notEqual(first.account.addedAt, second.account.addedAt);
  const rows = await kit.list();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.email === 'alice.work@example.test'), 'both logins carry the same email');
  const at = rows.map((r) => r.addedAt);
  assert.ok(at.every((v) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0), 'every managed row exposes a millisecond addedAt');
  assert.notEqual(at[0], at[1]);
  // The stamp is persisted, so a restart still tells the two apart.
  const restarted = cliAccounts({ stateDir, bins: { claude: claude.bin }, env });
  const again = (await restarted.list()).map((r) => r.addedAt).sort((a, b) => a! - b!);
  assert.deepEqual(again, at.slice().sort((a, b) => a! - b!));
  assert.deepEqual(JSON.parse(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8')).accounts.map((r: { addedAt: number }) => r.addedAt), at);
});

test('pre-existing same-email rows stay distinguishable through derived addedAt', async () => {
  const root = scratchDir('cli-legacy-distinct'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude'); const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const first = { id: 'pa_one', provider: 'claude', name: 'Work', folder: join(stateDir, 'claude', 'abcdef'), found: false };
  const second = { id: 'pa_two', provider: 'claude', name: 'Work', folder: join(stateDir, 'claude', 'fedcba'), found: false };
  mkdirSync(first.folder, { recursive: true });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  mkdirSync(second.folder, { recursive: true });
  const body = JSON.stringify({ version: 1, accounts: [first, second] });
  writeFileSync(join(stateDir, 'accounts-v1.json'), body);
  const rows = await cliAccounts({ stateDir, bins: { claude: claude.bin }, env }).list();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.email === 'alice.work@example.test'), 'both pre-existing logins carry the same email');
  assert.ok(rows.every((r) => typeof r.addedAt === 'number' && Number.isSafeInteger(r.addedAt) && r.addedAt > 0), 'every legacy managed row derives a millisecond addedAt');
  assert.notEqual(rows[0].addedAt, rows[1].addedAt, 'derived values separate the two same-email rows');
  assert.equal(readFileSync(join(stateDir, 'accounts-v1.json'), 'utf8'), body, 'deriving at read time never rewrites the roster');
});

test('persisted rest: status resting, launch refused, expiry, mode 0600, corrupt rewrite', async () => {
  const root = scratchDir('cli-rests'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude');
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { claude: claude.bin }, env });
  const { account, signIn } = await kit.add('claude');
  writeFileSync(signIn.completion, 'complete', { mode: 0o600 });
  await kit.rename(account.id, 'Work');
  assert.equal((await kit.status(account.id)).state, 'ready');
  const until = Date.now() + 3_600_000;
  const resting = await kit.rest(account.id, { until, why: 'rate_limit' });
  assert.equal(resting.state, 'resting');
  assert.equal(resting.until, until);
  const restsPath = join(stateDir, 'rests-v1.json');
  assert.equal(statSync(restsPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(restsPath, 'utf8')), { version: 1, rests: [{ id: account.id, until, why: 'rate_limit' }] });
  const refused = await kit.launch(account.id);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.code, 'resting');
    assert.equal(refused.message, say('status.resting', { name: 'Work', until: clock(until) }));
    assert.ok(!('set' in refused) && !('unset' in refused));
  }
  // Expired rests read as not resting; the next write prunes them.
  writeFileSync(restsPath, JSON.stringify({ version: 1, rests: [{ id: account.id, until: Date.now() - 1, why: 'rate_limit' }] }), { mode: 0o600 });
  assert.equal((await kit.status(account.id)).state, 'ready');
  const ready = await kit.launch(account.id);
  assert.equal(ready.ok, true);
  await kit.rest(account.id, { until: Date.now() + 60_000, why: 'rate_limit' });
  assert.deepEqual(JSON.parse(readFileSync(restsPath, 'utf8')).rests.map((r: { id: string }) => r.id), [account.id], 'expired rows are pruned on write');
  await kit.unrest(account.id);
  assert.equal((await kit.status(account.id)).state, 'ready');
  writeFileSync(restsPath, '{not-json', { mode: 0o600 });
  assert.equal((await kit.status(account.id)).state, 'ready', 'corrupt rests file reads as no rests');
  assert.deepEqual(JSON.parse(readFileSync(restsPath, 'utf8')), { version: 1, rests: [] });
  assert.equal(statSync(restsPath).mode & 0o777, 0o600);
});

test('installed CLIs signed in under the app HOME: listed, picked and launched with no folder; managed rows keep theirs', async () => {
  const root = scratchDir('cli-installed'); const stateDir = join(root, 'plans');
  const claude = fake(join(root, 'bins'), 'claude'); const codex = fake(join(root, 'bins'), 'codex');
  const home = join(root, 'home'); mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), 'never read');
  const env = { HOME: home, PATH: '/unused', ANTHROPIC_API_KEY: 'never-passed' };
  assert.deepEqual(await cliAccounts({ stateDir, bins: { claude: claude.bin }, env }).list(), [], 'only an app that asks lists installed CLIs');
  assert.throws(() => cliAccounts({ stateDir, bins: {}, env, installed: 'yes' as never }), { code: 'bad-option' });
  const kit = cliAccounts({ stateDir, bins: { claude: claude.bin, codex: codex.bin }, env, installed: true });
  const { account: managed } = await kit.add('claude');
  const rows = await kit.list();
  assert.deepEqual(rows.map((r) => [r.id, r.state, r.installed, r.email, r.name]), [
    [managed.id, 'signing', undefined, undefined, 'Claude'],
    ['installed-claude', 'ready', true, 'alice.work@example.test', 'Alice'],
    ['installed-codex', 'ready', true, 'alice.work@example.test', 'Alice'],
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /private-fake-token|access_token/);
  // The CLI's own status command, as the person runs it: their HOME, no folder variable, no per-use key.
  const status = claude.calls().at(-1);
  assert.deepEqual(status.argv, ['auth', 'status']);
  assert.equal(status.env.HOME, home);
  assert.equal('CLAUDE_CONFIG_DIR' in status.env, false);
  assert.equal('ANTHROPIC_API_KEY' in status.env, false);
  assert.equal(codex.calls().at(-1).env.CODEX_HOME, join(home, '.codex'));
  const launch = await kit.launch('installed-claude');
  assert.equal(launch.ok, true);
  if (launch.ok) { assert.deepEqual(launch.set, {}); assert.ok(launch.unset.includes('ANTHROPIC_API_KEY')); }
  assert.deepEqual(kit.launchEnv('installed-codex').set, {});
  assert.deepEqual(Object.keys(kit.launchEnv(managed.id).set), ['CLAUDE_CONFIG_DIR'], 'a managed account keeps its own folder');
  const pick = await kit.pick('claude');
  assert.equal(pick.ok && pick.account.id, 'installed-claude');
  for (const refused of [() => kit.folderOf('installed-claude'), () => kit.remove('installed-claude'), () => kit.rename('installed-claude', 'Work'),
    () => kit.rest('installed-claude', { until: Date.now() + 60_000, why: 'limit' }), () => kit.signInAgain('installed-claude')]) {
    await assert.rejects(async () => refused(), { code: 'unknown-account' });
  }
  assert.equal(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8'), 'never read');
  // The sign-in method is typed from Claude's own authMethod; absent when it does not say, and never for Codex.
  assert.deepEqual(rows.map((r) => r.method), [undefined, undefined, undefined]);
  const installed = (bin: string, extra: Record<string, string> = {}) => cliAccounts({ stateDir, bins: { claude: bin }, env: { ...env, ...extra }, installed: true });
  for (const [authMethod, method] of [['claude.ai', 'subscription'], ['api_key', 'api_key'], ['third_party', 'other']] as const) {
    assert.equal((await installed(claude.bin, { AUTH_METHOD: authMethod }).status('installed-claude')).method, method, authMethod);
  }
  assert.equal((await cliAccounts({ stateDir, bins: { codex: codex.bin }, env: { ...env, AUTH_METHOD: 'claude.ai' }, installed: true }).status('installed-codex')).method, undefined);
  // Signed out, or no answer: never ready, with the real cause.
 (bin: string, extra: Record<string, string> = {}) => cliAccounts({ stateDir, bins: { claude: bin }, env: { ...env, ...extra }, installed: true });
  const out = await installed(claude.bin, { STATUS_MODE: 'out' }).launch('installed-claude');
  assert.equal(out.ok, false);
  if (!out.ok) { assert.equal(out.code, 'signed_out'); assert.equal(out.message, 'Claude is not signed in on this computer.'); assert.equal(out.account.why, undefined); }
  const unreadable = await installed(claude.bin, { STATUS_MODE: 'flood' }).status('installed-claude');
  assert.deepEqual([unreadable.state, unreadable.why, unreadable.cause], ['signed_out', 'unknown', 'Claude on this computer answered in a way the app could not read.']);
  const absent = await installed(join(root, 'not-installed')).status('installed-claude');
  assert.deepEqual([absent.state, absent.why, absent.cause], ['signed_out', 'unknown', 'Claude on this computer could not start.']);
});

test('installed Codex launch distinguishes signed out from failed probes and retries only transient failures once', async () => {
  const root = scratchDir('codex-probes');
  for (const [mode, failure, calls, message] of [
    ['recorded', undefined, 1, undefined],
    ['out', undefined, 1, 'Codex is not signed in on this computer.'],
    ['reply', { code: 'reply' }, 1, 'Codex on this computer answered in a way the app could not read.'],
    ['malformed', { code: 'reply' }, 1, 'Codex on this computer answered in a way the app could not read.'],
    ['array', { code: 'reply' }, 1, 'Codex on this computer answered in a way the app could not read.'],
    ['flood', { code: 'reply' }, 1, 'Codex on this computer answered in a way the app could not read.'],
    ['exit', { code: 'exit', exitCode: 23, signal: null }, 2, 'Codex on this computer stopped before answering the account check.'],
    ['signal', { code: 'exit', exitCode: null, signal: 'SIGTERM' }, 2, 'Codex on this computer stopped before answering the account check.'],
    ['rpc-init', { code: 'rpc', rpcCode: -32603 }, 2, 'Codex on this computer refused the account check.'],
    ['rpc', { code: 'rpc', rpcCode: -32603 }, 2, 'Codex on this computer refused the account check.'],
    ['write', { code: 'write' }, 2, 'Codex on this computer could not receive the account check.'],
    ['exit-once', undefined, 2, undefined],
    ['timeout', { code: 'timeout' }, 2, 'Codex on this computer did not answer in time.'],
    ['timeout-once', undefined, 2, undefined],
  ] as const) {
    const codex = fake(join(root, mode), 'codex');
    const accounts = cliAccounts({ stateDir: join(root, `state-${mode}`), bins: { codex: codex.bin },
      env: { HOME: join(root, 'home'), PATH: '/unused', STATUS_MODE: mode }, installed: true });
    const launch = await accounts.launch('installed-codex');
    assert.equal(launch.ok, message === undefined, mode);
    assert.equal(launch.account.state, message === undefined ? 'ready' : 'signed_out', mode);
    assert.deepEqual(launch.account.probeFailure, failure, mode);
    assert.equal(launch.account.why, failure ? 'unknown' : undefined, mode);
    assert.equal(codex.calls().length, calls, `${mode}: bounded retry, never retry a signed-out or unreadable reply`);
    assert.doesNotMatch(JSON.stringify(launch), /private-fake-token|private-account-id|access_token/, mode);
    if (!launch.ok) { assert.equal(launch.message, message, mode); assert.equal(launch.account.cause, message, mode); }
    if (mode === 'recorded') {
      assert.equal(launch.account.email, 'umer@example.test'); assert.equal(launch.account.plan, 'prolite');
      assert.deepEqual(launch.ok && launch.set, {});
    }
  }
  const accounts = cliAccounts({ stateDir: join(root, 'missing-state'), bins: { codex: join(root, 'absent') },
    env: { HOME: join(root, 'home'), PATH: '/unused' }, installed: true });
  const launch = await accounts.launch('installed-codex');
  assert.equal(launch.ok, false);
  assert.deepEqual(launch.account.probeFailure, { code: 'start' });
  assert.equal(launch.account.cause, 'Codex on this computer could not start.');
});
