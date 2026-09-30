import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { usage, roomOf, UsageError, claudeWindows, codexWindows, goWindows, zaiWindows, WORDS, usageWords, type Source, type Window } from '../src/index.ts';
import { fakeCodex, fakeFetch, usageContract } from '../src/testing/index.ts';
import { fingerprint } from '../src/store.ts';
import payloads from './usage-payloads.json' with { type: 'json' };
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };

const nowMs = 1788600000000;
for (const provider of ['claude', 'codex', 'opencode', 'zai', 'copilot', 'grok', 'minimax', 'gemini', 'kimi'] as const) {
  usageContract(() => {
    const dir = scratchDir('usage-contract');
    const data = payloads[provider];
    const http = fakeFetch([{ body: data.raw }]);
    const codex = fakeCodex({ dir: join(dir, 'bin'), raw: payloads.codex.raw });
    const home = join(dir, 'sign-in'); mkdirSync(home);
    writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: payloads.codex.identity } }));
    const credentialsFile = join(home, '.credentials.json');
    writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', accountUuid: payloads.claude.identity } }));
    const source: Source = provider === 'claude' ? { provider, credentialsFile } : provider === 'codex' ? { provider, bin: codex.bin, home } : provider === 'opencode' || provider === 'zai' ? { provider, key: 'fixture-key', accountId: data.identity } : provider === 'gemini' ? { provider, access: 'fixture-access', accountId: data.identity, project: 'fixture-project' } : { provider, access: 'fixture-access', accountId: data.identity };
    const options = { stateDir: join(dir, 'state'), salt: payloads.salt, fetch: http.fetch };
    const reader = usage(options);
    assert.equal(reader.account(source), fingerprint(payloads.salt)(provider, data.identity));
    return { usage: reader, source, expected: data.windows as Window[], nowMs, restart: () => usage(options),
      fake: { calls: () => provider === 'codex' ? codex.invocations().length : http.calls.length,
        fail: () => { if (provider === 'codex') codex.script({ corrupt: true }); else http.push({ status: 429 }); },
        disconnect: () => { if (source.provider === 'codex') unlinkSync(source.bin); else if (source.provider === 'claude') unlinkSync(source.credentialsFile); else if ('key' in source) source.key = ''; else source.access = ''; } } };
  }, { test: (name, fn) => test(`${provider}: ${name}`, fn) });
}

test('recorded parsers, fingerprint inputs, finite raw reset times and words', () => {
  assert.deepEqual(claudeWindows(payloads.claude.raw), payloads.claude.windows);
  assert.deepEqual(claudeWindows({ rate_limits: payloads.claude.raw }), payloads.claude.windows);
  assert.deepEqual(goWindows(payloads.opencode.raw.usage), payloads.opencode.windows);
  assert.deepEqual(zaiWindows(payloads.zai.raw.data.limits), payloads.zai.windows);
  assert.deepEqual(codexWindows(payloads.codex.raw), payloads.codex.windows);
  for (const provider of ['claude','codex','opencode','zai'] as const) assert.equal(fingerprint(payloads.salt)(provider,payloads[provider].identity),payloads[provider].fingerprint);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 150, resets_at: -999999999 } }), [{provider:'claude',kind:'session',usedPercent:100,minutes:300,resetsAt:-999999999000}]);
  assert.deepEqual(goWindows({rolling:{percent:-1,status:'ok'}}), []);
  assert.deepEqual(goWindows({rolling:{percent:33,status:'rate-limited'}}), [{provider:'opencode',kind:'rolling',usedPercent:33,minutes:300,limited:true}]);
  assert.deepEqual(codexWindows({rateLimits:{limitName:'Other\n  limit',primary:{usedPercent:-2,windowDurationMins:20,resetsAt:4}}}),[{provider:'codex',kind:'custom',usedPercent:0,minutes:20,resetsAt:4000,limit:'Other limit'}]);
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
    const a: Source = {provider:'opencode',key:'one',accountId:'one-account'};
    const good = await reader.read(a,{nowMs});
    assert.deepEqual(good.windows,payloads.opencode.windows);
    assert.equal((await reader.read(a,{nowMs:nowMs+60_000})).code,'rate-limited');
    assert.equal((await reader.read(a,{nowMs:nowMs+659_999})).code,'rate-limited');
    assert.equal(fake.calls.length,2);
    const b: Source = {provider:'opencode',key:'two',accountId:'two-account'};
    assert.notEqual(reader.account(a),reader.account(b));
    assert.equal(reader.lastKnown(b,{nowMs}),undefined);
    assert.equal((await reader.read(b,{nowMs:nowMs+61_000})).code,undefined);
    assert.equal((await reader.read(a,{nowMs:nowMs+660_000})).code,undefined);
    assert.equal(fake.calls.length,4);
    assert.equal(fake.calls[0].url,'https://opencode.ai/zen/go/v1/usage');
    assert.equal(fake.calls[0].init?.redirect,'error');
    assert.deepEqual(fake.calls[0].init?.headers,{accept:'application/json',authorization:'Bearer one','User-Agent':'byokit/usage/0.2.0'});
    const file = join(dir,'state','plans-v2.json');
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
  const fake = fakeFetch([{status:401},{status:403},{body:{success:false}},{body:{unexpected:'secret'}},{text:'secret'},{text:'x'.repeat(65537)},{status:503},{status:201,body:payloads.zai.raw}]);
  const reader = usage({stateDir:join(dir,'state'),fetch:fake.fetch});
  for (const [i,code] of ['auth','no-plan','no-plan','incomplete','incomplete','incomplete','unavailable','unavailable'].entries()) {
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
  const reader = usage({stateDir,fetch:fake.fetch});const source: Source = {provider:'zai',key:'test-key',accountId:'test-account'};
  writeFileSync(join(stateDir,'plans-v2.json'),'x'.repeat(256*1024+1));
  assert.equal(reader.lastKnown(source,{nowMs}),undefined);
  writeFileSync(join(stateDir,'plans-v2.json'),JSON.stringify({plans:{zai:{account:reader.account(source),at:nowMs,raw:payloads.zai.raw.data.limits}}}));
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


test('Claude explicit files, snapshot freshness, expiry, renewal and account isolation', async () => {
  const dir = scratchDir('usage-claude');
  const credentialsFile = join(dir, 'credentials.json');
  const configFile = join(dir, 'config.json');
  const statuslineFile = join(dir, 'statusline.json');
  const source: Source = { provider: 'claude', credentialsFile, configFile, statuslineFile };
  const fake = fakeFetch([{ body: payloads.claude.raw }, { status: 429 }, { body: payloads.claude.raw }]);
  const reader = usage({ stateDir: join(dir, 'state'), fetch: fake.fetch, salt: payloads.salt });
  const credentials = (token: string, expiresAt: number, accountUuid?: string) => writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt, accountUuid } }));
  assert.equal((await reader.read(source, { nowMs })).code, 'not-connected');
  credentials('secret-one', nowMs + 100_000);
  writeFileSync(configFile, JSON.stringify({ oauthAccount: { accountUuid: payloads.claude.identity } }));
  assert.equal(reader.account(source), payloads.claude.fingerprint);
  writeFileSync(statuslineFile, JSON.stringify({ rate_limits: payloads.claude.raw, accessToken: 'secret-snapshot', unrelated: 'private-path' }));
  utimesSync(statuslineFile, nowMs / 1000, nowMs / 1000);
  const first = await reader.read(source, { nowMs });
  assert.deepEqual(first.windows, payloads.claude.windows);
  assert.equal(fake.calls.length, 0);
  // Snapshot expires after five minutes; the token has expired too, retaining last good data.
  assert.equal((await reader.read(source, { nowMs: nowMs + 300_000 })).code, 'expired');
  assert.equal(fake.calls.length, 0);
  credentials('secret-renewed', nowMs + 1_000_000);
  assert.equal(reader.account(source), payloads.claude.fingerprint);
  assert.equal((await reader.read(source, { nowMs: nowMs + 360_000 })).code, undefined);
  assert.equal(fake.calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.deepEqual(fake.calls[0].init?.headers, { accept: 'application/json', authorization: 'Bearer secret-renewed', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'byokit/usage/0.2.0' });
  assert.equal((await reader.read(source, { nowMs: nowMs + 420_000 })).code, 'rate-limited');
  credentials('secret-other', nowMs + 1_000_000, 'other-account');
  assert.equal(reader.lastKnown(source, { nowMs: nowMs + 420_000 }), undefined);
  assert.equal((await reader.read(source, { nowMs: nowMs + 420_000 })).code, undefined);
  assert.doesNotMatch(readFileSync(join(dir, 'state', 'plans-v2.json'), 'utf8'), /secret-|other-account|private-path/);
  // Credential symlinks, oversized files and relative paths never become a source.
  const link = join(dir, 'link.json'); symlinkSync(credentialsFile, link);
  assert.equal(reader.connected({ provider: 'claude', credentialsFile: link }), false);
  writeFileSync(credentialsFile, 'x'.repeat(65537));
  assert.equal(reader.connected(source), false);
  await assert.rejects(reader.read({ provider: 'claude', credentialsFile: '.credentials.json' }), UsageError);
  await assert.rejects(reader.read({ provider: 'claude', credentialsFile, configFile: 'relative' }), UsageError);
});



test('token sources: Codex wham identity, own UA, renewal and opaque credentials never persist', async () => {
  const dir = scratchDir('usage-token');
  const raw = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1788616800 }, secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: 1788616800 } }, account_secret: 'discard-this' };
  const fake = fakeFetch([{ body: raw }, { body: payloads.copilot.raw }]);
  const reader = usage({ stateDir: join(dir, 'state'), fetch: fake.fetch });
  const source: Source = { provider: 'codex', access: 'secret-token', accountId: 'account-one' };
  assert.deepEqual((await reader.read(source, { nowMs })).windows, payloads.codex.windows);
  assert.equal(fake.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal((fake.calls[0].init?.headers as Record<string, string>)['ChatGPT-Account-Id'], 'account-one');
  assert.equal((fake.calls[0].init?.headers as Record<string, string>)['User-Agent'], 'byokit/usage/0.2.0');
  assert.equal(reader.account(source), reader.account({ ...source, access: 'renewed-token' }));
  assert.doesNotMatch(readFileSync(join(dir, 'state', 'plans-v2.json'), 'utf8'), /secret-token|discard-this|account-one/);
  const opaque: Source = { provider: 'copilot', access: 'opaque-token' };
  const before = readFileSync(join(dir, 'state', 'plans-v2.json'), 'utf8');
  assert.equal(reader.account(opaque), undefined);
  assert.equal((await reader.read(opaque, { nowMs })).code, undefined);
  assert.equal(readFileSync(join(dir, 'state', 'plans-v2.json'), 'utf8'), before);
});

test('Claude source hook and public store/backoff policy preserve per-account last-good readings', async () => {
  const saved = new Map<string, import('../src/index.ts').StoredReading>();
  const rests = new Map<string, number>(); const seen: unknown[] = []; let calls = 0;
  const options: import('../src/index.ts').UsageOptions = {
    store: { get: (provider, id) => saved.get(`${provider}:${id}`), put: (provider, id, reading) => { seen.push({ provider, id, reading }); saved.set(`${provider}:${id}`, reading); } },
    backoff: { get: (provider, id) => rests.get(`${provider}:${id}`), set: (provider, id, until) => { rests.set(`${provider}:${id}`, until); }, delayMs: (retry) => Math.max(600_000, retry ?? 0) },
  };
  const source: Source = { provider: 'claude', accountUuid: 'hook-account', read: async ({ nowMs: clock, signal }) => {
    assert.equal(signal.aborted, false); assert.ok(clock >= nowMs); calls++;
    return calls === 1 ? { raw: { ...payloads.claude.raw, token: 'never-store', path: 'private-path' } } : { code: 'rate-limited', retryAfterMs: 120_000 };
  } };
  const reader = usage(options);
  const first = await reader.read(source, { nowMs });
  assert.deepEqual(first.windows, payloads.claude.windows);
  assert.doesNotMatch(JSON.stringify(seen), /hook-account|never-store|private-path|raw/);
  const failed = await reader.read(source, { nowMs: nowMs + 60_000 });
  assert.equal(failed.code, 'rate-limited'); assert.equal(failed.at, first.at);
  const restart = usage(options);
  assert.deepEqual(restart.lastKnown(source, { nowMs: nowMs + 61_000 }), first);
  assert.equal((await restart.read(source, { nowMs: nowMs + 659_999 })).code, 'rate-limited');
  assert.equal(calls, 2);
  const other: Source = { ...source, accountUuid: 'another-account', read: async () => ({ raw: payloads.claude.raw }) };
  assert.equal((await restart.read(other, { nowMs: nowMs + 61_000 })).code, undefined);
  assert.equal((await restart.read({ ...source, connected: () => false }, { nowMs })).code, 'not-connected');
});

test('roomOf uses the tightest window, ms resets, span mapping and 24h freshness', () => {
  const reading = { provider: 'codex' as const, at: nowMs, windows: payloads.codex.windows as Window[] };
  assert.deepEqual(roomOf(reading, nowMs), { left: 10, span: 'week', resetsAt: 1788616800000, at: nowMs });
  assert.deepEqual(roomOf(reading, nowMs + 86_400_001), { left: 'unknown', at: nowMs });
  assert.deepEqual(roomOf({ ...reading, windows: [] }, nowMs), { left: 'unknown', at: nowMs });
  for (const [kind, span] of [['session','session'],['weekly','week'],['monthly','month'],['rolling','tightest'],['custom','tightest']] as const) {
    assert.deepEqual(roomOf({ ...reading, windows: [{ provider: 'codex', kind, usedPercent: 20 }] }, nowMs), { left: 80, span, at: nowMs });
  }
});

test('Gemini project discovery and Grok monthly fallback use fixed own-UA endpoints', async () => {
  const fake = fakeFetch([{ body: { cloudaicompanionProject: { id: 'project-one' } } }, { body: payloads.gemini.raw }, { body: { config: { isUnifiedBillingUser: true } } }, { body: { config: { monthlyLimit: 200, used: 100, periodEnd: '2026-09-05T14:00:00Z' } } }]);
  const reader = usage({ fetch: fake.fetch });
  assert.deepEqual((await reader.read({ provider: 'gemini', access: 'fake' }, { nowMs })).windows, payloads.gemini.windows);
  assert.equal(fake.calls[0].init?.method, 'POST');
  assert.equal(fake.calls[1].url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
  assert.deepEqual(JSON.parse(String(fake.calls[1].init?.body)), { project: 'project-one' });
  assert.deepEqual((await reader.read({ provider: 'grok', access: 'fake' }, { nowMs })).windows, [{ provider: 'grok', kind: 'monthly', usedPercent: 50, resetsAt: 1788616800000 }]);
  assert.equal(fake.calls[3].url, 'https://cli-chat-proxy.grok.com/v1/billing');
  for (const call of fake.calls) assert.equal((call.init?.headers as Record<string,string>)['User-Agent'], 'byokit/usage/0.2.0');
});
