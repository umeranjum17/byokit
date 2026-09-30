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
