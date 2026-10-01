import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { decoy, traceFs, CANARY } from '../../accounts/src/testing/index.ts';
import { scratchDir } from '../../test-support.ts';
import { fakeCodex } from '../src/testing/index.ts';
import { usage } from '../src/index.ts';
import { fingerprint } from '../src/store.ts';
import payloads from './usage-payloads.json' with { type: 'json' };

test('isolation: only the passed sign-in folder is read; ambient sign-ins and keys are untouched', () => {
  const root = scratchDir('usage-isolation'); const d = decoy(join(root,'decoy'));
  const home = join(root,'passed');mkdirSync(home);
  writeFileSync(join(home,'auth.json'),JSON.stringify({tokens:{account_id:'passed-account'}}));
  const stateDir = join(root,'state');
  const fake = fakeCodex({dir:join(root,'fake'),raw:payloads.codex.raw});
  const log = join(root,'trace');writeFileSync(log,'');
  const module = new URL('../src/index.ts',import.meta.url).href;
  const child = spawnSync(process.execPath,['--import',traceFs,'--input-type=module','-e',`
    const { usage } = await import(${JSON.stringify(module)});
    const reader = usage({ stateDir: ${JSON.stringify(stateDir)} });
    const source = ${JSON.stringify({provider:'codex',bin:fake.bin,home})};
    if ((await reader.read(source)).windows.length !== 2) throw new Error('missing fake reading');
    reader.account(source); reader.connected(source); reader.lastKnown(source);
  `],{encoding:'utf8',env:{...process.env,...d.env,TRACE_ROOTS:[...d.roots,home,stateDir].join(':'),TRACE_LOG:log}});
  assert.equal(child.status,0,child.stderr);
  const touches = readFileSync(log,'utf8').trim().split('\n');
  assert.ok(touches.includes(join(home,'auth.json')));
  assert.ok(touches.some((p) => p.startsWith(stateDir)));
  assert.ok(touches.every((p) => p === join(home,'auth.json') || p === stateDir || p.startsWith(stateDir+'/')),touches.join('\n'));
  assert.deepEqual(d.changed(),[]);assert.deepEqual(d.ran(),[]);assert.deepEqual(d.leaks(stateDir),[]);
  const invocation = fake.invocations()[0];assert.deepEqual(invocation.env,{CODEX_HOME:home});
  assert.doesNotMatch(JSON.stringify(invocation),new RegExp(CANARY));
  assert.doesNotMatch(JSON.stringify(invocation),new RegExp(d.home));
});

test('isolation: credential symlinks cannot cause reads beyond the named folder', () => {
  const root = scratchDir('usage-symlink'); const home = join(root,'passed');mkdirSync(home);
  const outside = join(root,'outside.json');writeFileSync(outside,JSON.stringify({tokens:{account_id:'outside'}}));
  symlinkSync(outside,join(home,'auth.json'));
  const fake = fakeCodex({dir:join(root,'fake')});
  const reader = usage({stateDir:join(root,'state')});
  assert.equal(reader.account({provider:'codex',bin:fake.bin,home}),fingerprint('byokit/usage/account')('codex',`codex-home\0${home}`));
  assert.notEqual(reader.account({provider:'codex',bin:fake.bin,home}),reader.account({provider:'codex',bin:fake.bin,home:join(root,'different')}));
});

test('Claude managed-folder source never opens a default login, escapes its root, or leaks canary tokens', () => {
  const root = scratchDir('claude-source-isolation'); const d = decoy(join(root, 'decoy'));
  const stateDir = join(root, 'plans'); const folder = join(stateDir, 'claude', 'abcdef'); mkdirSync(folder, { recursive: true });
  const credential = join(folder, '.credentials.json');
  writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: CANARY, refreshToken: `${CANARY}-refresh`, expiresAt: Date.now() + 300_000 } }));
  const before = readFileSync(credential, 'utf8');
  const log = join(root, 'trace'); writeFileSync(log, '');
  const module = new URL('../src/index.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const {usage,UsageError} = await import(${JSON.stringify(module)});
    const {readdirSync,readFileSync,symlinkSync,unlinkSync}=await import('node:fs');
    let calls=0;
    const reader=usage({stateDir:${JSON.stringify(stateDir)},fetch:async()=>{calls++;return new Response(JSON.stringify({five_hour:{utilization:12},access_token:${JSON.stringify(CANARY)}}));}});
    const source=${JSON.stringify({ provider: 'claude', folder, headers: { 'anthropic-beta': 'passed', 'User-Agent': 'passed' } })};
    const good=await reader.read(source);
    if(good.windows.length!==1)throw new Error('missing fake usage');
    for(const folder of [${JSON.stringify(join(d.home, '.claude'))},${JSON.stringify(join(root, 'outside'))}]){
      try{await reader.read({...source,folder,credentialsFile:${JSON.stringify(join(d.home, '.claude', '.credentials.json'))}});throw new Error('accepted escape');}catch(e){if(!(e instanceof UsageError))throw e;}
    }
    reader.account(source);reader.connected(source);reader.lastKnown(source);
    const failed=await usage({stateDir:${JSON.stringify(stateDir)},fetch:async()=>{throw new Error(${JSON.stringify(CANARY)});}}).read(source);
    unlinkSync(${JSON.stringify(credential)});
    symlinkSync(${JSON.stringify(join(d.home, '.claude', '.credentials.json'))},${JSON.stringify(credential)});
    const linked=await reader.read(source);
    if(linked.code!=='not-connected')throw new Error('credential link accepted');
    if(calls!==1)throw new Error('unexpected provider request');
    console.log(JSON.stringify({good,failed,linked}));
  `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...d.env, TRACE_ROOTS: [...d.roots, stateDir].join(':'), TRACE_LOG: log } });
  assert.equal(child.status, 0, child.stderr); assert.doesNotMatch(child.stdout + child.stderr, new RegExp(CANARY));
  const touches = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(touches.includes(credential));
  // Symlink creation names the target without opening it; all other operations stay under stateDir.
  assert.ok(touches.every((p) => p === stateDir || p.startsWith(stateDir + '/') || p === join(d.home, '.claude', '.credentials.json')), touches.join('\n'));
  assert.equal(touches.filter((p) => p === join(d.home, '.claude', '.credentials.json')).length, 1);
  assert.deepEqual(d.changed(), []); assert.deepEqual(d.ran(), []);
  assert.doesNotMatch(readFileSync(join(stateDir, 'plans-v2.json'), 'utf8'), new RegExp(CANARY));
  assert.ok(before.includes(CANARY), 'the request exercised a real managed canary credential');
});


test('isolation: ephemeral snapshot reads no credentials, ambient login or persistent state', () => {
  const root = scratchDir('usage-ephemeral'); const d = decoy(join(root, 'decoy'));
  const stateDir = join(root, 'state'); mkdirSync(stateDir);
  const log = join(root, 'trace'); writeFileSync(log, '');
  const module = new URL('../src/index.ts', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const { usage, roomOf } = await import(${JSON.stringify(module)});
    const reader = usage({stateDir:${JSON.stringify(stateDir)},fetch:async()=>{throw new Error('unexpected HTTP');}});
    const source = {provider:'claude',ephemeral:true,read:async()=>({raw:{rate_limits:${JSON.stringify(payloads.claude.raw)}},at:1788600000000})};
    const result = await reader.read(source,{nowMs:1788600000000});
    if(roomOf(result,1788600000000).left!==58)throw new Error('snapshot not usable');
    if(reader.account(source)!==undefined||reader.lastKnown(source)!==undefined||!reader.connected(source))throw new Error('identity/cache boundary');
  `], {encoding:'utf8',env:{...process.env,...d.env,TRACE_ROOTS:[...d.roots,stateDir].join(':'),TRACE_LOG:log}});
  assert.equal(child.status, 0, child.stderr);
  assert.equal(readFileSync(log, 'utf8'), '');
  assert.deepEqual(d.changed(), []); assert.deepEqual(d.ran(), []);
});
