import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { usage, fingerprint, fileUsageStore, memoryUsageStore, memoryBackoffPolicy, retryAfterMs, backoffDelayMs, roomOf, tokenLedger, callLedger, normalizeTokens, priceCall, memoryTokenLedgerStore, TokenLedgerError, UsageError, claudeWindows, codexWindows, goWindows, zaiWindows, WORDS, usageWords, type Source, type Window } from '../src/index.ts';
import { fakeCodex, fakeFetch, usageContract } from '../src/testing/index.ts';
import payloads from './usage-payloads.json' with { type: 'json' };
import edge from '../../../fixtures/conformance/usage-typescript.json' with { type: 'json' };
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
  writeFileSync(statuslineFile, JSON.stringify({ rate_limits: payloads.claude.raw, fetched_at: nowMs, accessToken: 'secret-snapshot', unrelated: 'private-path' }));
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
    return calls === 1 ? { raw: { ...payloads.claude.raw, token: 'never-store', path: 'private-path' }, at: clock } : { code: 'rate-limited', retryAfterMs: 120_000 };
  } };
  const reader = usage(options);
  const first = await reader.read(source, { nowMs });
  assert.deepEqual(first.windows, payloads.claude.windows);
  assert.doesNotMatch(JSON.stringify(seen), /hook-account|never-store|private-path|raw/);
  const failed = await reader.read(source, { nowMs: nowMs + 60_000 });
  assert.equal(failed.code, 'rate-limited'); assert.equal(failed.at, first.at);
  const restart = usage(options);
  assert.deepEqual(restart.lastKnown(source, { nowMs: nowMs + 61_000 }), failed);
  assert.equal((await restart.read(source, { nowMs: nowMs + 659_999 })).code, 'rate-limited');
  assert.equal(calls, 2);
  const other: Source = { ...source, accountUuid: 'another-account', read: async () => ({ raw: payloads.claude.raw }) };
  assert.equal((await restart.read(other, { nowMs: nowMs + 61_000 })).code, undefined);
  assert.equal((await restart.read({ ...source, connected: () => false }, { nowMs })).code, 'not-connected');
});

test('roomOf uses the tightest window, ms resets, span mapping and 24h freshness', () => {
  const reading = { provider: 'codex' as const, at: nowMs, windows: payloads.codex.windows as Window[] };
  assert.deepEqual(roomOf(reading, nowMs), { left: 10, span: 'week', resetsAt: 1788616800000, at: nowMs, ageMs: 0, freshness: 'fresh' });
  assert.deepEqual(roomOf(reading, nowMs + 86_400_001), { left: 'unknown', at: nowMs, ageMs: 86_400_001, freshness: 'stale' });
  assert.deepEqual(roomOf({ ...reading, windows: [] }, nowMs), { left: 'unknown', at: nowMs, ageMs: 0, freshness: 'fresh' });
  for (const [kind, span] of [['session','session'],['weekly','week'],['monthly','month'],['rolling','tightest'],['custom','tightest']] as const) {
    assert.deepEqual(roomOf({ ...reading, windows: [{ provider: 'codex', kind, usedPercent: 20 }] }, nowMs), { left: 80, span, at: nowMs, ageMs: 0, freshness: 'fresh' });
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


test('member token ledger: local days, seven-day caps, boundaries and host persistence', () => {
  const store = memoryTokenLedgerStore();
  const ledger = tokenLedger({ store, cap: (member) => member === 'alice' ? 100 : undefined });
  const start = new Date(2026, 8, 1).getTime(); const end = new Date(2026, 8, 8).getTime();
  ledger.record('alice', 10, start - 1); // outside the seven local days
  ledger.record('alice', 20, start);
  ledger.record('alice', 30, start + 1000);
  ledger.record('alice', 40, new Date(2026, 8, 7, 23, 59).getTime());
  ledger.record('alice', 500, end); // upper bound excluded
  ledger.record('bob', 200, start);
  const restarted = tokenLedger({ store, cap: 100 });
  const all = restarted.query('alice', start, end);
  assert.equal(all.tokens, 90);
  assert.deepEqual(all.days, [{ date: '2026-09-01', tokens: 50 }, { date: '2026-09-07', tokens: 40 }]);
  assert.deepEqual(all.week, { from: start, to: end, tokens: 90, cap: 100, remaining: 10 });
  const today = ledger.query('alice', new Date(2026, 8, 7).getTime(), end);
  assert.equal(today.tokens, 40); assert.equal(today.week.tokens, 90);
  ledger.record('alice', 20, start + 2000);
  assert.equal(ledger.query('alice', start, end).week.remaining, 0);
  assert.equal(ledger.query('bob', start, end).week.tokens, 200);
  assert.equal(ledger.query('bob', start, end).week.remaining, undefined);
  assert.equal(tokenLedger().query('alice', start, end).tokens, 0);
  assert.equal(tokenLedger({ cap: 0 }).query('alice', start, end).week.remaining, 0);
  assert.throws(() => ledger.record('alice', -1, start), TokenLedgerError);
  assert.throws(() => ledger.record('', 1, start), TokenLedgerError);
  assert.throws(() => ledger.query('alice', end, start), TokenLedgerError);
  assert.throws(() => ledger.record('alice', 1, NaN), TokenLedgerError);
  const broken = tokenLedger({ store: { record() { throw new Error('secret'); }, query() { throw new Error('secret'); } } });
  assert.throws(() => broken.record('alice', 1, start), (error: unknown) => error instanceof TokenLedgerError && error.code === 'store' && !error.message.includes('secret'));
  assert.throws(() => broken.query('alice', start, end), TokenLedgerError);
});


test('runtime call ledger: normalized provider counts, honest unknowns, app prices and shared member store', () => {
  for (const fixture of payloads.runtime) assert.deepEqual(normalizeTokens(fixture.provider, fixture.raw), fixture.tokens);
  assert.deepEqual(normalizeTokens('claude', {}), { provenance: 'unknown' });
  assert.deepEqual(normalizeTokens('codex', { input_tokens: 100, output_tokens: 10, total_tokens: 999 }), { provenance: 'unknown' });
  assert.deepEqual(normalizeTokens('codex', { input: 100, output: 10, provenance: 'estimated' }), { provenance: 'unknown' });
  const store = memoryTokenLedgerStore(); const time = new Date(2026, 8, 7, 12).getTime();
  const ledger = callLedger({ store, prices: { codex: { model: { billing: 'api', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1 } }, claude: { model: { billing: 'subscription', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1, cacheWritePerMillion: 3 } } } });
  const base = { account: 'account-one', model: 'model', runId: 'run-one', time, billing: 'api' as const };
  const first = ledger.record('alice', { ...base, provider: 'codex', usage: { ...payloads.runtime[0].raw, secret: 'never-store' }, durationMs: 120, limits: payloads.codex.windows as Window[] });
  assert.deepEqual(first.cost, { amount: 0.00037, currency: 'USD', billing: 'api', label: "Person's API bill", basis: 'app-prices', estimated: true });
  assert.equal(first.tokens.total, 120); assert.equal(first.payer, 'alice');
  // The same run's retry is another call; another member never contributes to this member.
  ledger.record('alice', { ...base, provider: 'claude', billing: 'subscription', usage: payloads.runtime[1].raw, state: 'cancelled' });
  ledger.record('bob', { ...base, provider: 'codex', usage: payloads.runtime[0].raw });
  first.tokens.total = 999; // Returned values cannot mutate stored history.
  const restarted = callLedger({ store });
  const query = restarted.query('alice', time, time + 1);
  assert.equal(query.calls.length, 2); assert.equal(query.calls[1].state, 'cancelled');
  assert.equal(query.tokens.total, 240); assert.equal(query.tokens.input, 200); assert.equal(query.tokens.cachedInput, 60);
  assert.equal(query.costs.length, 2); assert.equal(query.costs[1].label, "Person's own plan");
  assert.equal(query.unpricedCalls, 0); assert.doesNotMatch(JSON.stringify(query), /never-store|usage/);
  assert.equal(tokenLedger({ store, cap: 500 }).query('alice', time, time + 1).week.remaining, 260);
  assert.equal(priceCall(normalizeTokens('codex', { input: 100, output: 20 }), undefined, 'api'), undefined);
  assert.equal(priceCall(normalizeTokens('codex', { input: 100, output: 20 }), { billing: 'api', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1 }, 'api'), undefined);
  assert.equal(callLedger().record('alice', { ...base, provider: 'codex', usage: payloads.runtime[0].raw }).cost, undefined);
  const unknown = restarted.record('alice', { ...base, provider: 'kimi', account: 'account-two', usage: { error: 'no reported counts' }, state: 'failed' });
  assert.equal(unknown.tokens.provenance, 'unknown'); assert.equal(unknown.cost, undefined);
  const partial = restarted.query('alice', time, time + 1);
  assert.equal(partial.tokens.total, undefined); assert.equal(partial.unpricedCalls, 1);
  const member = tokenLedger({ store, cap: 500 }).query('alice', time, time + 1);
  assert.equal(member.tokens, 240); assert.equal(member.unknownCalls, 1); assert.equal(member.week.remaining, undefined);
  assert.equal(member.week.unknownCalls, 1);
  assert.throws(() => ledger.record('alice', { ...base, provider: 'codex', durationMs: -1 }), TokenLedgerError);
  assert.throws(() => ledger.query('alice', time + 1, time), TokenLedgerError);
});


test('public Claude replacement helpers share disk last-good and account backoff across readers', async () => {
  const dir = scratchDir('usage-public-helpers');
  const credentialsFile = join(dir, 'credentials.json');
  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-secret', accountUuid: 'account-one' } }));
  const source: Source = { provider: 'claude', credentialsFile };
  const stateDir = join(dir, 'state');
  const store = fileUsageStore(stateDir);
  const backoff = memoryBackoffPolicy();
  const http = fakeFetch([{ body: payloads.claude.raw }, { status: 429, retryAfter: '600' }, { body: payloads.claude.raw }]);
  const options = { store, backoff, salt: payloads.salt, fetch: http.fetch };
  const reader = usage(options);
  const good = await reader.read(source, { nowMs });
  const account = fingerprint(payloads.salt)('claude', 'account-one');
  assert.equal(reader.account(source), account);
  assert.deepEqual(fileUsageStore(stateDir).get('claude', account), { at: nowMs, windows: good.windows, poll: good.poll });
  assert.equal((await reader.read(source, { nowMs: nowMs + 60_000 })).code, 'rate-limited');
  assert.equal(backoff.get('claude', account), nowMs + 660_000);
  backoff.set('claude', account, nowMs + 120_000);
  const restarted = usage({ ...options, store: fileUsageStore(stateDir) });
  const cached = restarted.lastKnown(source, { nowMs: nowMs + 120_000 })!;
  assert.equal(cached.at, good.at);
  assert.deepEqual(cached.windows, good.windows);
  assert.equal(cached.poll?.outcome, 'rate-limited');
  assert.deepEqual(await restarted.read(source, { nowMs: nowMs + 120_000 }), cached);
  assert.equal(http.calls.length, 2);
  assert.equal((await restarted.read(source, { nowMs: nowMs + 660_000 })).code, undefined);
  assert.equal(http.calls.length, 3);
  assert.doesNotMatch(readFileSync(join(stateDir, 'plans-v2.json'), 'utf8'), /fixture-secret|account-one|accessToken/);
  assert.equal(statSync(join(stateDir, 'plans-v2.json')).mode & 0o777, 0o600);
  assert.throws(() => fileUsageStore('relative'), UsageError);
  store.put('claude', 'fixture-secret', { at: nowMs, windows: good.windows, poll: good.poll });
  assert.equal(store.get('claude', 'fixture-secret'), undefined);
  assert.equal(retryAfterMs('600', nowMs), 600_000);
  assert.equal(retryAfterMs(new Date(nowMs + 600_000).toUTCString(), nowMs), 600_000);
  assert.equal(retryAfterMs(new Date(nowMs - 60_000).toUTCString(), nowMs), 0);
  for (const header of [null, undefined, '', '  ', 'invalid']) assert.equal(retryAfterMs(header, nowMs), undefined);
  assert.equal(backoffDelayMs(undefined), 300_000);
  assert.equal(backoffDelayMs(NaN), 300_000);
  assert.equal(backoffDelayMs(600_000), 600_000);
});

test('shared Auto inputs: hard blocks, reset clocks, scoped precedence and reading age', async () => {
  for (const fixture of edge.codex) {
    const source: Source = { provider: 'codex', accountId: 'edge-account', access: 'synthetic-token' };
    const stateDir = scratchDir('usage-hard');
    const reader = usage({ stateDir, fetch: fakeFetch([{ body: fixture.raw }]).fetch });
    const reading = await reader.read(source, { nowMs: edge.now });
    const room = roomOf(reading, edge.now);
    assert.equal(room.left, fixture.left);
    if ('reset' in fixture) assert.equal(reading.windows[0]?.resetsAt, fixture.reset);
    if (('limit_reached' in fixture.raw.rate_limit && fixture.raw.rate_limit.limit_reached)) {
      assert.equal(room.limited, true);
      assert.equal(roomOf(usage({ stateDir }).lastKnown(source, { nowMs: edge.now + 86_400_001 })!, edge.now + 86_400_001).left, 0);
      assert.equal(roomOf(reading, edge.now + 86_400_001).left, 0);
      assert.equal(roomOf(reader.lastKnown(source, { nowMs: edge.now + 86_400_001 })!, edge.now + 86_400_001).left, 0);
      if (!('primary_window' in fixture.raw.rate_limit)) assert.deepEqual(reading.windows, []);
      else assert.equal(reading.windows[0]?.usedPercent, 20);
    }
  }
  assert.deepEqual(goWindows({ rolling: { status: 'rate-limited' } }), [{ provider: 'opencode', kind: 'rolling', minutes: 300, limited: true }]);
  const windows = claudeWindows(edge.claude);
  assert.equal(windows.length, 4);
  assert.equal(windows[3]?.usedPercent, undefined);
  const scoped = roomOf({ provider: 'claude', at: edge.now, windows }, edge.now);
  assert.equal(scoped.left, 0);
  assert.deepEqual(scoped.scope, { model: 'synthetic-model', surface: 'subagent' });
  assert.equal(roomOf({ provider: 'claude', at: edge.now, windows: windows.filter((w) => w.usedPercent !== 100) }, edge.now).left, 'unknown');
  assert.deepEqual(claudeWindows({ limits: [{ kind: 'weekly_all' }], seven_day: { utilization: 0 } }), [{ provider: 'claude', kind: 'weekly' }]);
  for (const fixture of edge.age) {
    const reading = { provider: 'claude' as const, windows: [{ provider: 'claude' as const, kind: 'session' as const, usedPercent: 20 }], ...('at' in fixture ? { at: fixture.at } : {}) };
    const room = roomOf(reading, edge.now);
    assert.equal(room.left, fixture.left); assert.equal(room.freshness, fixture.freshness);
  }
});

test('poll outcomes retain source age, separate refresh failure, durable retry and account pacing', async () => {
  const saved = new Map<string, import('../src/index.ts').StoredReading>();
  const retry = new Map<string, import('../src/index.ts').BackoffState>(); const contexts: unknown[] = []; let clock = edge.now;
  let calls = 0;
  const source: Source = { provider: 'claude', accountUuid: 'synthetic-account', origin: 'https://quota.example', read: async () => {
    calls++;
    if (calls === 1) return { raw: edge.claude, at: edge.now - 120_000 };
    return { code: edge.failures[(calls - 2) % edge.failures.length] as import('../src/index.ts').Code, retryAfterMs: 180_000 };
  } };
  const origins: string[] = [];
  const options: import('../src/index.ts').UsageOptions = {
    store: { get: (_, id) => saved.get(id), put: (_, id, r) => { saved.set(id, r); } },
    backoff: { get: (_, id) => retry.get(id), set: (_, id, _until, state) => { if (state) retry.set(id, state); else retry.delete(id); }, delayMs: (_, context) => { contexts.push(context); return 60_000; } },
    pace: async ({ origin, signal }) => { assert.equal(signal.aborted, false); origins.push(origin); },
  };
  const reader = usage(options);
  const first = await reader.read(source, { nowMs: clock });
  const failed = await reader.read(source, { nowMs: clock += 60_000 });
  assert.equal(failed.code, 'rate-limited'); assert.equal(failed.at, first.at);
  assert.equal(roomOf(failed, clock).left, 0); // real exhaustion, separate from the poll 429
  assert.equal(failed.poll?.at, clock); assert.equal(failed.poll?.retryAt, clock + 180_000);
  assert.equal(reader.lastKnown(source, { nowMs: clock })?.poll?.outcome, 'rate-limited');
  const restart = usage(options);
  await restart.read(source, { nowMs: clock + 179_999 }); assert.equal(calls, 2);
  const refreshed = await restart.read(source, { nowMs: clock += 180_000 });
  assert.equal(refreshed.code, 'refresh-failed');
  assert.equal(usage(options).lastKnown(source, { nowMs: clock })?.poll?.outcome, 'refresh-failed');
  assert.equal(restart.lastKnown(source, { nowMs: clock })?.poll?.outcome, 'refresh-failed'); assert.equal(refreshed.at, first.at);
  assert.equal(roomOf({ ...refreshed, windows: [{ provider: 'claude', kind: 'session', usedPercent: 20 }] }, clock).left, 80);
  const other: Source = { ...source, accountUuid: 'other', origin: 'https://another.example', read: async () => ({ raw: payloads.claude.raw, at: undefined }) };
  const undated = await restart.read(other, { nowMs: clock });
  assert.equal(undated.at, undefined); assert.equal(roomOf(undated, clock).freshness, 'unknown');
  assert.deepEqual(origins, ['https://quota.example', 'https://quota.example', 'https://quota.example', 'https://another.example']);
  assert.deepEqual(contexts, [{ outcome: 'rate-limited', failures: 1 }, { outcome: 'refresh-failed', failures: 1 }]);
  // File mtime changes do not make an undated or future quota measurement fresh.
  const dir = scratchDir('usage-observation');
  const credentialsFile = join(dir, 'credentials.json');
  const statuslineFile = join(dir, 'statusline.json');
  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic', accountUuid: 'snapshot' } }));
  for (const fetched_at of [undefined, clock + 1]) {
    writeFileSync(statuslineFile, JSON.stringify({ rate_limits: payloads.claude.raw, fetched_at }));
    utimesSync(statuslineFile, clock / 1000, clock / 1000);
    const snapshot = await usage({ fetch: async () => { throw new Error('endpoint must not stamp cached figures'); } }).read({ provider: 'claude', credentialsFile, statuslineFile }, { nowMs: clock });
    assert.equal(roomOf(snapshot, clock).freshness, fetched_at === undefined ? 'unknown' : 'future');
    assert.equal(roomOf(snapshot, clock).left, 'unknown');
  }
  let failures = 0;
  const transient = usage({ fetch: async () => { failures++; return new Response('{}', { status: 503 }); } });
  const failing: Source = { provider: 'codex', access: 'synthetic', accountId: 'transient' };
  assert.equal((await transient.read(failing, { nowMs: clock })).poll?.retryAt, clock + 60_000);
  assert.equal((await transient.read(failing, { nowMs: clock + 60_000 })).poll?.retryAt, clock + 180_000);
  await transient.read(failing, { nowMs: clock + 179_999 }); assert.equal(failures, 2);
  const abort = new AbortController(); let sent = 0;
  const paced = usage({ pace: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private')), { once: true })), fetch: async () => { sent++; return new Response('{}'); } });
  const pending = paced.read({ provider: 'codex', accountId: 'paced', access: 'synthetic' }, { nowMs: clock, signal: abort.signal });
  abort.abort();
  assert.equal((await pending).code, 'unavailable'); assert.equal(sent, 0);
});

test('managed Claude source shares pacing, scoped hard blocks and last-good poll health', async () => {
  const root = scratchDir('claude-managed-poll'); const folder = join(root, 'claude', 'abcdef'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-managed-token', expiresAt: nowMs + 900_000 } }));
  const source: Source = { provider: 'claude', folder, headers: { 'anthropic-beta': 'passed', 'User-Agent': 'passed' } };
  const http = fakeFetch([{ body: { limits: [{ kind: 'weekly_scoped', limit_reached: true, scope: { model: 'synthetic-model', surface: 'subagent' } }] } }, { status: 503 }]);
  const paced: unknown[] = [];
  const reader = usage({ stateDir: root, fetch: http.fetch, pace: async (request) => {
    paced.push({ provider: request.provider, account: request.account, origin: request.origin });
    assert.equal(request.signal.aborted, false);
  } });
  const good = await reader.read(source, { nowMs });
  assert.equal(good.windows[0].usedPercent, undefined);
  assert.equal(roomOf(good, nowMs).left, 0);
  assert.deepEqual(roomOf(good, nowMs).scope, { model: 'synthetic-model', surface: 'subagent' });
  assert.deepEqual(good.poll, { at: nowMs, outcome: 'ok' });
  const failed = await reader.read(source, { nowMs: nowMs + 60_000 });
  assert.equal(failed.at, good.at); assert.deepEqual(failed.windows, good.windows);
  assert.deepEqual(failed.poll, { at: nowMs + 60_000, outcome: 'unavailable', retryAt: nowMs + 120_000 });
  assert.deepEqual(usage({ stateDir: root }).lastKnown(source, { nowMs: nowMs + 61_000 }), failed);
  assert.equal(paced.length, 2); assert.deepEqual(paced[0], { provider: 'claude', account: reader.account(source), origin: 'https://api.anthropic.com' });
  const controller = new AbortController(); controller.abort();
  const cancelled = await usage({ fetch: http.fetch, stateDir: root, store: memoryUsageStore() }).read(source, { nowMs, signal: controller.signal });
  assert.equal(cancelled.code, 'unavailable'); assert.equal(http.calls.length, 2);
  assert.doesNotMatch(JSON.stringify({ good, failed, cancelled, paced }) + readFileSync(join(root, 'plans-v2.json'), 'utf8'), /synthetic-managed-token/);
});

test('shared Codex identity client returns only approved identity fields, with the passed environment', async () => {
  const { identity } = await import('../src/index.ts');
  const root = scratchDir('codex-identity'); const home = join(root, 'home'); mkdirSync(home);
  const fake = fakeCodex({ dir: join(root, 'bin'), raw: { account: { type: 'chatgpt', email: 'alice@example.test', planType: 'plus', access_token: 'secret-token' } } });
  const source = { provider: 'codex' as const, bin: fake.bin, home, env: { HOME: home, ONLY_PASSED: 'yes' } };
  assert.deepEqual(await identity(source), { signedIn: true, email: 'alice@example.test', plan: 'plus' });
  const invocation = fake.invocations()[0];
  assert.deepEqual(invocation.env, { ...source.env, CODEX_HOME: home });
  assert.deepEqual(invocation.requests.map((r) => (r as { method: string }).method), ['initialize', 'account/read']);
  fake.script({ raw: { account: null, access_token: 'secret-token' } });
  assert.deepEqual(await identity(source), { signedIn: false });
  fake.script({ flood: true }); assert.deepEqual(await identity(source), { signedIn: false });
  await assert.rejects(identity({ ...source, bin: 'codex' }), UsageError);
});

test('managed Claude usage is read-only, bounded and carries app-passed headers without exposing credentials', async () => {
  const root = scratchDir('claude-managed'); const folder = join(root, 'claude', 'abcdef'); mkdirSync(folder, { recursive: true });
  const credential = join(folder, '.credentials.json');
  const token = 'synthetic-secret-token';
  writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'synthetic-refresh', expiresAt: nowMs + 300_000 } }), { mode: 0o600 });
  const before = readFileSync(credential, 'utf8'); const metadata = statSync(credential);
  const source: Source = { provider: 'claude', folder, headers: { 'anthropic-beta': 'app-beta', 'User-Agent': 'app-agent' } };
  const http = fakeFetch([{ body: { ...payloads.claude.raw, access_token: token } }, { status: 429 }, { text: token }, { status: 401 }, { text: 'x'.repeat(65537) }]);
  const reader = usage({ stateDir: root, fetch: http.fetch });
  assert.ok(reader.connected(source)); const identity = reader.account(source);
  const [good, duplicate] = await Promise.all([reader.read(source, { nowMs }), reader.read(source, { nowMs })]);
  assert.deepEqual(good.windows, payloads.claude.windows); assert.deepEqual(good, duplicate); assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.deepEqual(http.calls[0].init?.headers, { accept: 'application/json', authorization: `Bearer ${token}`, 'anthropic-beta': 'app-beta', 'User-Agent': 'app-agent' });
  assert.equal(http.calls[0].init?.redirect, 'error');
  assert.deepEqual(await reader.read(source, { nowMs: nowMs + 59_999 }), good);
  assert.deepEqual(usage({ stateDir: root }).lastKnown(source, { nowMs: nowMs + 60_000 }), good);
  assert.equal((await reader.read(source, { nowMs: nowMs + 60_000 })).code, 'rate-limited');
  assert.equal((await reader.read(source, { nowMs: nowMs + 61_000 })).code, 'rate-limited'); assert.equal(http.calls.length, 2);
  for (const code of ['incomplete', 'auth', 'incomplete']) {
    const result = await usage({ stateDir: root, store: memoryUsageStore(), fetch: http.fetch }).read(source, { nowMs: nowMs + 60_000 });
    assert.equal(result.code, code); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-token|synthetic-refresh/);
  }
  assert.equal(readFileSync(credential, 'utf8'), before); assert.equal(statSync(credential).mtimeMs, metadata.mtimeMs);
  assert.doesNotMatch(readFileSync(join(root, 'plans-v2.json'), 'utf8'), /synthetic-secret-token|synthetic-refresh|access_token/);
  writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: nowMs - 1 } }));
  assert.notEqual(reader.account(source), identity, 'credential metadata change invalidates cached account readings without loading tokens');
  const expired = await usage({ stateDir: root, fetch: http.fetch }).read(source, { nowMs });
  assert.equal(expired.code, 'expired'); assert.deepEqual(expired.windows, []); assert.equal(http.calls.length, 5);
  unlinkSync(credential); assert.equal(reader.connected(source), false);
  assert.equal((await reader.read(source, { nowMs })).code, 'not-connected');
});
