import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { usage, UsageError, claudeWindows, codexWindows, goWindows, zaiWindows, WORDS, usageWords, type Source, type Window } from '../src/index.ts';
import { fakeCodex, fakeFetch, usageContract } from '../src/testing/index.ts';
import { fingerprint } from '../src/store.ts';
import payloads from './usage-payloads.json' with { type: 'json' };
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };

const nowMs = 1788600000000;
for (const provider of ['codex', 'opencode', 'zai'] as const) {
  usageContract(() => {
    const dir = scratchDir('usage-contract');
    const data = payloads[provider];
    const http = fakeFetch([{ body: data.raw }]);
    const codex = fakeCodex({ dir: join(dir, 'bin'), raw: payloads.codex.raw });
    const home = join(dir, 'sign-in'); mkdirSync(home);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: payloads.codex.identity } }));
    const source: Source = provider === 'codex' ? { provider, bin: codex.bin, home } : { provider, key: data.identity };
    const options = { stateDir: join(dir, 'state'), salt: payloads.salt, fetch: http.fetch };
    const reader = usage(options);
    assert.equal(reader.account(source), data.fingerprint);
    return { usage: reader, source, expected: data.windows as Window[], nowMs, restart: () => usage(options),
      fake: { calls: () => provider === 'codex' ? codex.invocations().length : http.calls.length,
        fail: () => { if (provider === 'codex') codex.script({ corrupt: true }); else http.push({ status: 429 }); },
        disconnect: () => { if (source.provider === 'codex') unlinkSync(source.bin); else source.key = ''; } } };
  }, { test: (name, fn) => test(`${provider}: ${name}`, fn) });
}

test('recorded parsers, fingerprint inputs, finite raw reset times and words', () => {
  assert.deepEqual(claudeWindows(payloads.claude.raw), payloads.claude.windows);
  assert.deepEqual(claudeWindows({ rate_limits: payloads.claude.raw }), payloads.claude.windows);
  assert.deepEqual(goWindows(payloads.opencode.raw.usage), payloads.opencode.windows);
  assert.deepEqual(zaiWindows(payloads.zai.raw.data.limits), payloads.zai.windows);
  assert.deepEqual(codexWindows(payloads.codex.raw), payloads.codex.windows);
  for (const provider of ['claude','codex','opencode','zai'] as const) assert.equal(fingerprint(payloads.salt)(provider,payloads[provider].identity),payloads[provider].fingerprint);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 150, resets_at: -999999999 } }), [{provider:'claude',kind:'session',usedPercent:100,minutes:300,resetsAt:-999999999}]);
  assert.deepEqual(goWindows({rolling:{percent:-1,status:'ok'}}), []);
  assert.deepEqual(goWindows({rolling:{percent:33,status:'rate-limited'}}), [{provider:'opencode',kind:'rolling',usedPercent:33,minutes:300,limited:true}]);
  assert.deepEqual(codexWindows({rateLimits:{limitName:'Other\n  limit',primary:{usedPercent:-2,windowDurationMins:20,resetsAt:4}}}),[{provider:'codex',kind:'custom',usedPercent:0,minutes:20,resetsAt:4,limit:'Other limit'}]);
  for (const text of Object.values(WORDS)) assert.doesNotMatch(text.replace(/\{\w+\}/g,'X'),new RegExp(plain.pattern,'i'));
  assert.equal(usageWords('auth',{name:'Plan'}),"Plan turned this sign-in down. Sign in again in its own app.");
});

test('per-account backoff, minimum retry interval, key changes and dynamic fetch', async () => {
  const dir = scratchDir('usage-backoff');
  const fake = fakeFetch([{body:payloads.opencode.raw},{status:429,retryAfter:'600'},{body:payloads.opencode.raw},{body:payloads.opencode.raw}]);
  const saved = globalThis.fetch;
  const reader = usage({stateDir:join(dir,'state')});
  globalThis.fetch = fake.fetch;
  try {
    const a: Source = {provider:'opencode',key:'one'};
    const good = await reader.read(a,{nowMs});
    assert.deepEqual(good.windows,payloads.opencode.windows);
    assert.equal((await reader.read(a,{nowMs:nowMs+60_000})).code,'rate-limited');
    assert.equal((await reader.read(a,{nowMs:nowMs+659_999})).code,'rate-limited');
    assert.equal(fake.calls.length,2);
    const b: Source = {provider:'opencode',key:'two'};
    assert.notEqual(reader.account(a),reader.account(b));
    assert.equal(reader.lastKnown(b,{nowMs}),undefined);
    assert.equal((await reader.read(b,{nowMs:nowMs+61_000})).code,undefined);
    assert.equal((await reader.read(a,{nowMs:nowMs+660_000})).code,undefined);
    assert.equal(fake.calls.length,4);
    assert.equal(fake.calls[0].url,'https://opencode.ai/zen/go/v1/usage');
    assert.equal(fake.calls[0].init?.redirect,'error');
    assert.deepEqual(fake.calls[0].init?.headers,{accept:'application/json',authorization:'Bearer one'});
    const file = join(dir,'state','plans-v1.json');
    assert.equal(statSync(file).mode & 0o777,0o600); assert.equal(statSync(join(dir,'state')).mode & 0o777,0o700);
    assert.doesNotMatch(readFileSync(file,'utf8'),/Bearer|"one"|"two"/);
  } finally {globalThis.fetch=saved;}
});

test('codex relogin, API-key folder identities, explicit environment and bounded fault output', async () => {
  const dir = scratchDir('usage-codex'); const home = join(dir,'home');mkdirSync(home);
  const fake = fakeCodex({dir:join(dir,'bin'),raw:payloads.codex.raw});
  const source: Source = {provider:'codex',bin:fake.bin,home,env:{HOME:home,ONLY_THIS:'passed'}};
  const reader = usage({stateDir:join(dir,'state'),salt:payloads.salt});
  assert.equal(reader.account(source),fingerprint(payloads.salt)('codex',`codex-home\0${home}`));
  assert.notEqual(reader.account(source),reader.account({...source,home:join(dir,'other')}));
  await reader.read(source,{nowMs});
  writeFileSync(join(home,'auth.json'),JSON.stringify({tokens:{account_id:'another-account'}}));
  assert.equal(reader.lastKnown(source,{nowMs}),undefined);
  fake.script({flood:true});
  assert.equal((await reader.read(source,{nowMs})).code,'incomplete');
  const calls = fake.invocations(); assert.equal(calls.length,2);
  assert.deepEqual(calls[0].argv,['app-server']);
  assert.deepEqual(calls[0].env,{HOME:home,ONLY_THIS:'passed',CODEX_HOME:home});
  assert.deepEqual(calls[0].requests.map((r) => (r as {method:string}).method),['initialize','account/rateLimits/read']);
});

test('failed payloads and provider refusals are codes without bodies or secrets', async () => {
  const dir = scratchDir('usage-errors');
  const fake = fakeFetch([{status:401},{status:403},{body:{success:false}},{body:{unexpected:'secret'}},{text:'secret'},{text:'x'.repeat(65537)},{status:503}]);
  const reader = usage({stateDir:join(dir,'state'),fetch:fake.fetch});
  for (const [i,code] of ['auth','no-plan','no-plan','incomplete','incomplete','incomplete','unavailable'].entries()) {
    const source: Source = {provider:'zai',key:`secret-${i}`};
    const r = await reader.read(source,{nowMs});assert.equal(r.code,code);assert.deepEqual(r.windows,[]);assert.doesNotMatch(JSON.stringify(r),/secret/);
    await reader.read(source,{nowMs:nowMs+59_999});assert.equal(fake.calls.length,i+1);
  }
  assert.equal(fake.calls[0].url,'https://api.z.ai/api/monitor/usage/quota/limit');
  await assert.rejects(reader.read({provider:'codex',bin:'codex',home:dir}),UsageError);
  await assert.rejects(reader.read({provider:'codex',bin:'/codex',home:''}),UsageError);
  await assert.rejects(reader.read({provider:'codex',bin:'/codex',home:dir,env:{BAD:'a\0b'}}),UsageError);
});

test('HTTP deadline aborts a stalled response without returning the provider body', async (t) => {
  t.mock.timers.enable({apis:['setTimeout']});
  const dir = scratchDir('usage-timeout');
  let signal: AbortSignal | undefined;
  const reader = usage({stateDir:join(dir,'state'),fetch:async (_url,init) => {
    signal = init?.signal ?? undefined;
    return new Promise((_resolve,reject) => signal?.addEventListener('abort',() => reject(new Error('secret'))));
  }});
  const pending = reader.read({provider:'zai',key:'test-key'},{nowMs});
  t.mock.timers.tick(10_000);
  assert.equal((await pending).code,'unavailable');assert.equal(signal?.aborted,true);
});

test('store ignores oversized and old-shaped files and keeps the newest reading', async () => {
  const dir = scratchDir('usage-store');const stateDir = join(dir,'state');mkdirSync(stateDir,{mode:0o755});
  const fake = fakeFetch([{body:payloads.zai.raw},{body:payloads.zai.raw}]);
  const reader = usage({stateDir,fetch:fake.fetch});const source: Source = {provider:'zai',key:'test-key'};
  writeFileSync(join(stateDir,'plans-v1.json'),'x'.repeat(256*1024+1));
  assert.equal(reader.lastKnown(source,{nowMs}),undefined);
  writeFileSync(join(stateDir,'plans-v1.json'),JSON.stringify({plans:{zai:{account:reader.account(source),at:nowMs,raw:payloads.zai.raw.data.limits}}}));
  assert.equal(reader.lastKnown(source,{nowMs}),undefined);
  const first = await reader.read(source,{nowMs});
  assert.equal(statSync(stateDir).mode & 0o777,0o700);
  await usage({stateDir,fetch:fake.fetch}).read(source,{nowMs:nowMs-1});
  assert.deepEqual(usage({stateDir}).lastKnown(source,{nowMs}),first);
});

test('Codex timeout escalates when the fake ignores SIGTERM', async (t) => {
  const dir = scratchDir('usage-kill');const home = join(dir,'home');mkdirSync(home);
  const fake = fakeCodex({dir:join(dir,'bin')});fake.script({hang:true,ignoreTerm:true});
  t.mock.timers.enable({apis:['setTimeout']});
  const reader = usage({stateDir:join(dir,'state')});
  const pending = reader.read({provider:'codex',bin:fake.bin,home},{nowMs});
  // Let the real child record both requests before advancing the supervised deadline.
  const deadline = Date.now() + 5000;
  while (fake.invocations().length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(fake.invocations().length,1);
  t.mock.timers.tick(20_000);assert.equal((await pending).code,'unavailable');
  t.mock.timers.tick(1000);
  // Give SIGKILL and close handlers their real event-loop turn before mock reset.
  await new Promise<void>((resolve) => setImmediate(resolve));
});
