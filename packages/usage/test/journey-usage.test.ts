// Consumer journeys for the published @byokit/usage surface, driven the way a host app uses it: the host owns
// sign-in, passes a token/key or the exact files it already selected, injects its own `fetch`, and reads room left.
// Every import is a published entry — `@byokit/usage`, `@byokit/usage/view` and `@byokit/usage/testing`, plus the
// consumer packages `@byokit/accounts`, `@byokit/decide` and `@byokit/openclaw` — never `../src`. The security and
// correctness contracts the old unit, mock-heavy and internal suites held survive as assertions inside a journey:
//   - usage-reading: which account is read — `read`/`account`/`lastKnown` per provider and per host identity, one
//     concurrent operation, the freshness floor, restart, and refusals that never return a provider body;
//   - billing-label: subscription vs API key labelled honestly — every `CallRecord` carries a `billingLabel`, and
//     a subscription quota is never turned into an API charge or an engine cost guess;
//   - account-isolation: a decoy HOME's ambient sign-ins, keys and files are byte-for-byte untouched, symlinks and
//     relative paths are refused, and a managed Claude folder cannot escape its root or open a default login;
//   - log-redaction: no token, credential, prompt or transcript body reaches a reading, store, error or log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import { scratchDir } from '../../test-support.ts';
import {
  usage, identity, fingerprint, fileUsageStore, memoryUsageStore, memoryBackoffPolicy, retryAfterMs, backoffDelayMs,
  roomOf, tokenLedger, callLedger, normalizeTokens, priceCall, memoryTokenLedgerStore, TokenLedgerError, UsageError,
  claudeWindows, codexWindows, goWindows, zaiWindows, WORDS, usageWords,
  type Source, type Window, type Reading, type UsageOptions, type StoredReading, type BackoffState,
} from '@byokit/usage';
import { planView, planLabel, modelLabel } from '@byokit/usage/view';
import { fakeCodex, fakeFetch } from '@byokit/usage/testing';
import { anthropic } from '@byokit/accounts';
import { decide, MemoryCache } from '@byokit/decide';
import type { RunEnd } from '@byokit/openclaw';
import { decoy, traceFs, CANARY } from '@byokit/accounts/testing';
import payloads from './usage-payloads.json' with { type: 'json' };
import edge from '../../../fixtures/conformance/usage-typescript.json' with { type: 'json' };
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };
import viewFixture from '../../../fixtures/conformance/usage-view-typescript.json' with { type: 'json' };

const nowMs = 1788600000000;
const providers = ['claude', 'codex', 'opencode', 'zai', 'copilot', 'grok', 'minimax', 'gemini', 'kimi'] as const;

/** One host bench per provider: a canned transport (or fake app-server) plus the exact source the app would pass. */
function bench(provider: (typeof providers)[number]) {
  const dir = scratchDir('usage-journey');
  const data = payloads[provider];
  const http = fakeFetch([{ body: data.raw }]);
  const codex = fakeCodex({ dir: join(dir, 'bin'), raw: payloads.codex.raw });
  const home = join(dir, 'sign-in'); mkdirSync(home);
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: payloads.codex.identity } }));
  const credentialsFile = join(home, '.credentials.json');
  writeFileSync(credentialsFile, JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', accountUuid: payloads.claude.identity } }));
  const source: Source = provider === 'claude' ? { provider, credentialsFile } : provider === 'codex' ? { provider, bin: codex.bin, home } : provider === 'opencode' || provider === 'zai' ? { provider, key: 'fixture-key', accountId: data.identity } : provider === 'gemini' ? { provider, access: 'fixture-access', accountId: data.identity, project: 'fixture-project' } : { provider, access: 'fixture-access', accountId: data.identity };
  const options = { stateDir: join(dir, 'state'), salt: payloads.salt, fetch: http.fetch };
  return { reader: usage(options), source, expected: data.windows as Window[], restart: () => usage(options),
    calls: () => provider === 'codex' ? codex.invocations().length : http.calls.length,
    fail: () => { if (provider === 'codex') codex.script({ corrupt: true }); else http.push({ status: 429 }); },
    disconnect: () => { if (source.provider === 'codex') unlinkSync(source.bin); else if (source.provider === 'claude') unlinkSync(source.credentialsFile); else if ('key' in source) source.key = ''; else source.access = ''; } };
}

test('a host reads every plan through the app-owned sign-in, keeps people apart and parses reported windows', async () => {
  for (const provider of providers) {
    const b = bench(provider);
    const [a, duplicate] = await Promise.all([b.reader.read(b.source, { nowMs }), b.reader.read(b.source, { nowMs })]);
    assert.deepEqual(a.windows, b.expected); assert.deepEqual(a, duplicate); assert.equal(a.code, undefined);
    const count = b.calls();
    assert.deepEqual(await b.reader.read(b.source, { nowMs: nowMs + 59_999 }), a);
    assert.equal(b.calls(), count, `${provider}: the freshness floor sent no second request`);
    assert.deepEqual(b.restart().lastKnown(b.source, { nowMs: nowMs + 60_000 }), a);
    assert.equal(b.restart().lastKnown(b.source, { nowMs: nowMs + 86_400_001 }), undefined);
    // A failed read stands on the last good reading only while the sign-in is still connected.
    b.fail();
    const failed = await b.reader.read(b.source, { nowMs: nowMs + 60_000 });
    assert.deepEqual(failed.windows, a.windows); assert.equal(failed.at, a.at); assert.ok(failed.code);
    b.disconnect(); assert.equal(b.reader.connected(b.source), false);
    assert.equal(b.reader.lastKnown(b.source, { nowMs: nowMs + 61_000 }), undefined);
    assert.equal((await b.reader.read(b.source, { nowMs: nowMs + 61_000 })).code, 'not-connected');
  }

  // Recorded parsers and the host identity fingerprint agree with the shared fixture.
  assert.deepEqual(claudeWindows(payloads.claude.raw), payloads.claude.windows);
  assert.deepEqual(claudeWindows({ rate_limits: payloads.claude.raw }), payloads.claude.windows);
  assert.deepEqual(goWindows(payloads.opencode.raw.usage), payloads.opencode.windows);
  assert.deepEqual(zaiWindows(payloads.zai.raw.data.limits), payloads.zai.windows);
  assert.deepEqual(codexWindows(payloads.codex.raw), payloads.codex.windows);
  for (const provider of ['claude', 'codex', 'opencode', 'zai'] as const) assert.equal(fingerprint(payloads.salt)(provider, payloads[provider].identity), payloads[provider].fingerprint);
  assert.deepEqual(claudeWindows({ five_hour: { utilization: 150, resets_at: -999999999 } }), [{ provider: 'claude', kind: 'session', usedPercent: 100, minutes: 300, resetsAt: -999999999000 }]);
  assert.deepEqual(goWindows({ rolling: { percent: -1, status: 'ok' } }), []);
  assert.deepEqual(goWindows({ rolling: { percent: 33, status: 'rate-limited' } }), [{ provider: 'opencode', kind: 'rolling', usedPercent: 33, minutes: 300, limited: true }]);
  assert.deepEqual(codexWindows({ rateLimits: { limitName: 'Other\n  limit', primary: { usedPercent: -2, windowDurationMins: 20, resetsAt: 4 } } }), [{ provider: 'codex', kind: 'custom', usedPercent: 0, minutes: 20, resetsAt: 4000, limit: 'Other limit' }]);
  for (const text of Object.values(WORDS)) assert.doesNotMatch(text.replace(/\{\w+\}/g, 'X'), new RegExp(plain.pattern, 'i'));
  assert.equal(usageWords('auth', { name: 'Plan' }), 'Plan turned this sign-in down. Sign in again in its own app.');

  // Token sources: Codex wham identity, the kit's own User-Agent, renewal keeping the account, opaque credentials never persisted.
  const tokenDir = scratchDir('usage-token');
  const raw = { rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 18000, reset_at: 1788616800 }, secondary_window: { used_percent: 90, limit_window_seconds: 604800, reset_at: 1788616800 } }, account_secret: 'discard-this' };
  const tokenHttp = fakeFetch([{ body: raw }, { body: payloads.copilot.raw }]);
  const tokenReader = usage({ stateDir: join(tokenDir, 'state'), fetch: tokenHttp.fetch });
  const tokenSource: Source = { provider: 'codex', access: 'secret-token', accountId: 'account-one' };
  assert.deepEqual((await tokenReader.read(tokenSource, { nowMs })).windows, payloads.codex.windows);
  assert.equal(tokenHttp.calls[0].url, 'https://chatgpt.com/backend-api/wham/usage');
  assert.equal((tokenHttp.calls[0].init?.headers as Record<string, string>)['ChatGPT-Account-Id'], 'account-one');
  assert.equal((tokenHttp.calls[0].init?.headers as Record<string, string>)['User-Agent'], 'byokit/usage/0.2.0');
  assert.equal(tokenReader.account(tokenSource), tokenReader.account({ ...tokenSource, access: 'renewed-token' }));
  assert.doesNotMatch(readFileSync(join(tokenDir, 'state', 'plans-v2.json'), 'utf8'), /secret-token|discard-this|account-one/);
  const opaque: Source = { provider: 'copilot', access: 'opaque-token' };
  const beforeOpaque = readFileSync(join(tokenDir, 'state', 'plans-v2.json'), 'utf8');
  assert.equal(tokenReader.account(opaque), undefined);
  assert.equal((await tokenReader.read(opaque, { nowMs })).code, undefined);
  assert.equal(readFileSync(join(tokenDir, 'state', 'plans-v2.json'), 'utf8'), beforeOpaque);

  // Gemini project discovery and Grok monthly fallback use fixed endpoints with the kit's own User-Agent.
  const discovery = fakeFetch([{ body: { cloudaicompanionProject: { id: 'project-one' } } }, { body: payloads.gemini.raw }, { body: { config: { isUnifiedBillingUser: true } } }, { body: { config: { monthlyLimit: 200, used: 100, periodEnd: '2026-09-05T14:00:00Z' } } }]);
  const discoveryReader = usage({ fetch: discovery.fetch });
  assert.deepEqual((await discoveryReader.read({ provider: 'gemini', access: 'fake' }, { nowMs })).windows, payloads.gemini.windows);
  assert.equal(discovery.calls[0].init?.method, 'POST');
  assert.equal(discovery.calls[1].url, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota');
  assert.deepEqual(JSON.parse(String(discovery.calls[1].init?.body)), { project: 'project-one' });
  assert.deepEqual((await discoveryReader.read({ provider: 'grok', access: 'fake' }, { nowMs })).windows, [{ provider: 'grok', kind: 'monthly', usedPercent: 50, resetsAt: 1788616800000 }]);
  assert.equal(discovery.calls[3].url, 'https://cli-chat-proxy.grok.com/v1/billing');
  for (const call of discovery.calls) assert.equal((call.init?.headers as Record<string, string>)['User-Agent'], 'byokit/usage/0.2.0');

  // Codex app-server: the passed binary/home and environment, and a credential change ends the last-good reading.
  const codexDir = scratchDir('usage-codex'); const home = join(codexDir, 'home'); mkdirSync(home);
  const fake = fakeCodex({ dir: join(codexDir, 'bin'), raw: payloads.codex.raw });
  const codexSource: Source = { provider: 'codex', bin: fake.bin, home, env: { HOME: home, ONLY_THIS: 'passed' } };
  const codexReader = usage({ stateDir: join(codexDir, 'state'), salt: payloads.salt });
  assert.equal(codexReader.account(codexSource), fingerprint(payloads.salt)('codex', `codex-home\0${home}`));
  assert.notEqual(codexReader.account(codexSource), codexReader.account({ ...codexSource, home: join(codexDir, 'other') }));
  await codexReader.read(codexSource, { nowMs });
  writeFileSync(join(home, 'auth.json'), JSON.stringify({ tokens: { account_id: 'another-account' } }));
  assert.equal(codexReader.lastKnown(codexSource, { nowMs }), undefined);
  fake.script({ flood: true });
  assert.equal((await codexReader.read(codexSource, { nowMs })).code, 'incomplete');
  const invocations = fake.invocations(); assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].argv, ['app-server']);
  assert.deepEqual(invocations[0].env, { HOME: home, ONLY_THIS: 'passed', CODEX_HOME: home });
  assert.deepEqual(invocations[0].requests.map((r) => (r as { method: string }).method), ['initialize', 'account/rateLimits/read']);

  // The shared Codex identity client returns only approved fields, with the passed environment.
  const idDir = scratchDir('codex-identity'); const idHome = join(idDir, 'home'); mkdirSync(idHome);
  const idFake = fakeCodex({ dir: join(idDir, 'bin'), raw: { account: { type: 'chatgpt', email: 'alice@example.test', planType: 'plus', access_token: 'secret-token' } } });
  const idSource = { provider: 'codex' as const, bin: idFake.bin, home: idHome, env: { HOME: idHome, ONLY_PASSED: 'yes' } };
  assert.deepEqual(await identity(idSource), { signedIn: true, email: 'alice@example.test', plan: 'plus' });
  const idInvocation = idFake.invocations()[0];
  assert.deepEqual(idInvocation.env, { ...idSource.env, CODEX_HOME: idHome });
  assert.deepEqual(idInvocation.requests.map((r) => (r as { method: string }).method), ['initialize', 'account/read']);
  idFake.script({ raw: { account: null, access_token: 'secret-token' } });
  assert.deepEqual(await identity(idSource), { signedIn: false });
  idFake.script({ flood: true }); assert.deepEqual(await identity(idSource), { signedIn: false });
  await assert.rejects(identity({ ...idSource, bin: 'codex' }), UsageError);

  // A symlinked credential cannot read beyond the named folder; identities stay distinct.
  const linkDir = scratchDir('usage-symlink'); const linkHome = join(linkDir, 'passed'); mkdirSync(linkHome);
  writeFileSync(join(linkDir, 'outside.json'), JSON.stringify({ tokens: { account_id: 'outside' } }));
  symlinkSync(join(linkDir, 'outside.json'), join(linkHome, 'auth.json'));
  const linkFake = fakeCodex({ dir: join(linkDir, 'fake') });
  const linkReader = usage({ stateDir: join(linkDir, 'state') });
  assert.equal(linkReader.account({ provider: 'codex', bin: linkFake.bin, home: linkHome }), fingerprint('byokit/usage/account')('codex', `codex-home\0${linkHome}`));
  assert.notEqual(linkReader.account({ provider: 'codex', bin: linkFake.bin, home: linkHome }), linkReader.account({ provider: 'codex', bin: linkFake.bin, home: join(linkDir, 'different') }));
});

test('a rate-limited or failing plan backs off per account, keeps the last good reading and tells exhaustion from refusal', async (t) => {
  // Per-account backoff, the minimum retry interval, key changes, dynamic fetch and an atomic 0600 store.
  const dir = scratchDir('usage-backoff');
  const fake = fakeFetch([{ body: payloads.opencode.raw }, { status: 429, retryAfter: '600' }, { body: payloads.opencode.raw }, { body: payloads.opencode.raw }]);
  const savedFetch = globalThis.fetch;
  const reader = usage({ stateDir: join(dir, 'state') });
  globalThis.fetch = fake.fetch;
  try {
    const a: Source = { provider: 'opencode', key: 'one', accountId: 'one-account' };
    assert.deepEqual((await reader.read(a, { nowMs })).windows, payloads.opencode.windows);
    assert.equal((await reader.read(a, { nowMs: nowMs + 60_000 })).code, 'rate-limited');
    assert.equal((await reader.read(a, { nowMs: nowMs + 659_999 })).code, 'rate-limited');
    assert.equal(fake.calls.length, 2);
    const b: Source = { provider: 'opencode', key: 'two', accountId: 'two-account' };
    assert.notEqual(reader.account(a), reader.account(b));
    assert.equal(reader.lastKnown(b, { nowMs }), undefined);
    assert.equal((await reader.read(b, { nowMs: nowMs + 61_000 })).code, undefined);
    assert.equal((await reader.read(a, { nowMs: nowMs + 660_000 })).code, undefined);
    assert.equal(fake.calls.length, 4);
    assert.equal(fake.calls[0].url, 'https://opencode.ai/zen/go/v1/usage');
    assert.equal(fake.calls[0].init?.redirect, 'error');
    assert.deepEqual(fake.calls[0].init?.headers, { accept: 'application/json', authorization: 'Bearer one', 'User-Agent': 'byokit/usage/0.2.0' });
    const file = join(dir, 'state', 'plans-v2.json');
    assert.equal(statSync(file).mode & 0o777, 0o600); assert.equal(statSync(join(dir, 'state')).mode & 0o777, 0o700);
    assert.doesNotMatch(readFileSync(file, 'utf8'), /Bearer|"one"|"two"/);
  } finally { globalThis.fetch = savedFetch; }

  // Refusals are codes without bodies or secrets; a bad source throws UsageError.
  const errorDir = scratchDir('usage-errors');
  const errorHttp = fakeFetch([{ status: 401 }, { status: 403 }, { body: { success: false } }, { body: { unexpected: 'secret' } }, { text: 'secret' }, { text: 'x'.repeat(65537) }, { status: 503 }, { status: 201, body: payloads.zai.raw }]);
  const errorReader = usage({ stateDir: join(errorDir, 'state'), fetch: errorHttp.fetch });
  for (const [i, code] of ['auth', 'no-plan', 'no-plan', 'incomplete', 'incomplete', 'incomplete', 'unavailable', 'unavailable'].entries()) {
    const source: Source = { provider: 'zai', key: `secret-${i}` };
    const r = await errorReader.read(source, { nowMs }); assert.equal(r.code, code); assert.deepEqual(r.windows, []); assert.doesNotMatch(JSON.stringify(r), /secret/);
    await errorReader.read(source, { nowMs: nowMs + 59_999 }); assert.equal(errorHttp.calls.length, i + 1);
  }
  assert.equal(errorHttp.calls[0].url, 'https://api.z.ai/api/monitor/usage/quota/limit');
  await assert.rejects(errorReader.read({ provider: 'codex', bin: 'codex', home: errorDir }), UsageError);
  await assert.rejects(errorReader.read({ provider: 'codex', bin: '/codex', home: '' }), UsageError);
  await assert.rejects(errorReader.read({ provider: 'codex', bin: '/codex', home: errorDir, env: { BAD: 'a\0b' } }), UsageError);

  // An HTTP deadline aborts a stalled response without returning the provider body.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timeoutDir = scratchDir('usage-timeout');
  let stalled: AbortSignal | undefined;
  const timeoutReader = usage({ stateDir: join(timeoutDir, 'state'), fetch: async (_url, init) => {
    stalled = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => stalled?.addEventListener('abort', () => reject(new Error('secret'))));
  } });
  const pending = timeoutReader.read({ provider: 'zai', key: 'test-key' }, { nowMs });
  t.mock.timers.tick(10_000);
  assert.equal((await pending).code, 'unavailable'); assert.equal(stalled?.aborted, true);
  t.mock.timers.reset();

  // The store ignores an oversized or old-shaped file and keeps the newest reading.
  const storeDir = scratchDir('usage-store'); const stateDir = join(storeDir, 'state'); mkdirSync(stateDir, { mode: 0o755 });
  const storeHttp = fakeFetch([{ body: payloads.zai.raw }, { body: payloads.zai.raw }]);
  const storeReader = usage({ stateDir, fetch: storeHttp.fetch }); const storeSource: Source = { provider: 'zai', key: 'test-key', accountId: 'test-account' };
  writeFileSync(join(stateDir, 'plans-v2.json'), 'x'.repeat(256 * 1024 + 1));
  assert.equal(storeReader.lastKnown(storeSource, { nowMs }), undefined);
  writeFileSync(join(stateDir, 'plans-v2.json'), JSON.stringify({ plans: { zai: { account: storeReader.account(storeSource), at: nowMs, raw: payloads.zai.raw.data.limits } } }));
  assert.equal(storeReader.lastKnown(storeSource, { nowMs }), undefined);
  const first = await storeReader.read(storeSource, { nowMs });
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  await usage({ stateDir, fetch: storeHttp.fetch }).read(storeSource, { nowMs: nowMs - 1 });
  assert.deepEqual(usage({ stateDir }).lastKnown(storeSource, { nowMs }), first);

  // A Codex child that ignores SIGTERM is still escalated to SIGKILL before the deadline resolves.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const killDir = scratchDir('usage-kill'); const killHome = join(killDir, 'home'); mkdirSync(killHome);
  const killFake = fakeCodex({ dir: join(killDir, 'bin') }); killFake.script({ hang: true, ignoreTerm: true });
  const killReader = usage({ stateDir: join(killDir, 'state') });
  const killing = killReader.read({ provider: 'codex', bin: killFake.bin, home: killHome }, { nowMs });
  const deadline = Date.now() + 5000;
  while (killFake.invocations().length === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(killFake.invocations().length, 1);
  t.mock.timers.tick(20_000); assert.equal((await killing).code, 'unavailable');
  t.mock.timers.tick(1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.reset();

  // Hard blocks, reset clocks, scoped precedence and reading age come from the shared Auto fixture.
  for (const fixture of edge.codex) {
    const source: Source = { provider: 'codex', accountId: 'edge-account', access: 'synthetic-token' };
    const edgeDir = scratchDir('usage-hard');
    const edgeReader = usage({ stateDir: edgeDir, fetch: fakeFetch([{ body: fixture.raw }]).fetch });
    const reading = await edgeReader.read(source, { nowMs: edge.now });
    const room = roomOf(reading, edge.now);
    assert.equal(room.left, fixture.left);
    if ('reset' in fixture) assert.equal(reading.windows[0]?.resetsAt, fixture.reset);
    if (('limit_reached' in fixture.raw.rate_limit && fixture.raw.rate_limit.limit_reached)) {
      assert.equal(room.limited, true);
      assert.equal(roomOf(usage({ stateDir: edgeDir }).lastKnown(source, { nowMs: edge.now + 86_400_001 })!, edge.now + 86_400_001).left, 0);
      assert.equal(roomOf(reading, edge.now + 86_400_001).left, 0);
      assert.equal(roomOf(edgeReader.lastKnown(source, { nowMs: edge.now + 86_400_001 })!, edge.now + 86_400_001).left, 0);
      if (!('primary_window' in fixture.raw.rate_limit)) assert.deepEqual(reading.windows, []);
      else assert.equal(reading.windows[0]?.usedPercent, 20);
    }
  }
  assert.deepEqual(goWindows({ rolling: { status: 'rate-limited' } }), [{ provider: 'opencode', kind: 'rolling', minutes: 300, limited: true }]);
  const scopedWindows = claudeWindows(edge.claude);
  assert.equal(scopedWindows.length, 4);
  assert.equal(scopedWindows[3]?.usedPercent, undefined);
  const scoped = roomOf({ provider: 'claude', at: edge.now, windows: scopedWindows }, edge.now);
  assert.equal(scoped.left, 0);
  assert.deepEqual(scoped.scope, { model: 'synthetic-model', surface: 'subagent' });
  assert.equal(roomOf({ provider: 'claude', at: edge.now, windows: scopedWindows.filter((w) => w.usedPercent !== 100) }, edge.now).left, 'unknown');
  assert.deepEqual(claudeWindows({ limits: [{ kind: 'weekly_all' }], seven_day: { utilization: 0 } }), [{ provider: 'claude', kind: 'weekly' }]);
  for (const fixture of edge.age) {
    const reading = { provider: 'claude' as const, windows: [{ provider: 'claude' as const, kind: 'session' as const, usedPercent: 20 }], ...('at' in fixture ? { at: fixture.at } : {}) };
    const room = roomOf(reading, edge.now);
    assert.equal(room.left, fixture.left); assert.equal(room.freshness, fixture.freshness);
  }

  // Poll outcomes separate a rate limit from a real exhaustion and from a refresh failure, and pacing is honoured.
  const saved = new Map<string, StoredReading>();
  const retry = new Map<string, BackoffState>(); const contexts: unknown[] = []; let clock = edge.now;
  let calls = 0;
  const source: Source = { provider: 'claude', accountUuid: 'synthetic-account', origin: 'https://quota.example', read: async () => {
    calls++;
    if (calls === 1) return { raw: edge.claude, at: edge.now - 120_000 };
    return { code: edge.failures[(calls - 2) % edge.failures.length] as Reading['code'], retryAfterMs: 180_000 };
  } };
  const origins: string[] = [];
  const options: UsageOptions = {
    store: { get: (_, id) => saved.get(id), put: (_, id, r) => { saved.set(id, r); } },
    backoff: { get: (_, id) => retry.get(id), set: (_, id, _until, state) => { if (state) retry.set(id, state); else retry.delete(id); }, delayMs: (_, context) => { contexts.push(context); return 60_000; } },
    pace: async ({ origin, signal }) => { assert.equal(signal.aborted, false); origins.push(origin); },
  };
  const pollReader = usage(options);
  const firstGood = await pollReader.read(source, { nowMs: clock });
  const rateLimited = await pollReader.read(source, { nowMs: clock += 60_000 });
  assert.equal(rateLimited.code, 'rate-limited'); assert.equal(rateLimited.at, firstGood.at);
  assert.equal(roomOf(rateLimited, clock).left, 0); // real exhaustion, separate from the poll 429
  assert.equal(rateLimited.poll?.at, clock); assert.equal(rateLimited.poll?.retryAt, clock + 180_000);
  assert.equal(pollReader.lastKnown(source, { nowMs: clock })?.poll?.outcome, 'rate-limited');
  const restart = usage(options);
  await restart.read(source, { nowMs: clock + 179_999 }); assert.equal(calls, 2);
  const refreshed = await restart.read(source, { nowMs: clock += 180_000 });
  assert.equal(refreshed.code, 'refresh-failed');
  assert.equal(usage(options).lastKnown(source, { nowMs: clock })?.poll?.outcome, 'refresh-failed');
  assert.equal(restart.lastKnown(source, { nowMs: clock })?.poll?.outcome, 'refresh-failed'); assert.equal(refreshed.at, firstGood.at);
  assert.equal(roomOf({ ...refreshed, windows: [{ provider: 'claude', kind: 'session', usedPercent: 20 }] }, clock).left, 80);
  const other: Source = { ...source, accountUuid: 'other', origin: 'https://another.example', read: async () => ({ raw: payloads.claude.raw, at: undefined }) };
  const undated = await restart.read(other, { nowMs: clock });
  assert.equal(undated.at, undefined); assert.equal(roomOf(undated, clock).freshness, 'unknown');
  assert.deepEqual(origins, ['https://quota.example', 'https://quota.example', 'https://quota.example', 'https://another.example']);
  assert.deepEqual(contexts, [{ outcome: 'rate-limited', failures: 1 }, { outcome: 'refresh-failed', failures: 1 }]);
  let transientFailures = 0;
  const transient = usage({ fetch: async () => { transientFailures++; return new Response('{}', { status: 503 }); } });
  const failing: Source = { provider: 'codex', access: 'synthetic', accountId: 'transient' };
  assert.equal((await transient.read(failing, { nowMs: clock })).poll?.retryAt, clock + 60_000);
  assert.equal((await transient.read(failing, { nowMs: clock + 60_000 })).poll?.retryAt, clock + 180_000);
  await transient.read(failing, { nowMs: clock + 179_999 }); assert.equal(transientFailures, 2);
  const abort = new AbortController(); let sent = 0;
  const paced = usage({ pace: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private')), { once: true })), fetch: async () => { sent++; return new Response('{}'); } });
  const pendingPaced = paced.read({ provider: 'codex', accountId: 'paced', access: 'synthetic' }, { nowMs: clock, signal: abort.signal });
  abort.abort();
  assert.equal((await pendingPaced).code, 'unavailable'); assert.equal(sent, 0);

  // A managed Claude folder shares pacing, scoped hard blocks and last-good poll health.
  const managedRoot = scratchDir('claude-managed-poll'); const folder = join(managedRoot, 'claude', 'abcdef'); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-managed-token', expiresAt: nowMs + 900_000 } }));
  const managedSource: Source = { provider: 'claude', folder, headers: { 'anthropic-beta': 'passed', 'User-Agent': 'passed' } };
  const managedHttp = fakeFetch([{ body: { limits: [{ kind: 'weekly_scoped', limit_reached: true, scope: { model: 'synthetic-model', surface: 'subagent' } }] } }, { status: 503 }]);
  const pacedCalls: unknown[] = [];
  const managedReader = usage({ stateDir: managedRoot, fetch: managedHttp.fetch, pace: async (request) => {
    pacedCalls.push({ provider: request.provider, account: request.account, origin: request.origin });
    assert.equal(request.signal.aborted, false);
  } });
  const managedGood = await managedReader.read(managedSource, { nowMs });
  assert.equal(managedGood.windows[0].usedPercent, undefined);
  assert.equal(roomOf(managedGood, nowMs).left, 0);
  assert.deepEqual(roomOf(managedGood, nowMs).scope, { model: 'synthetic-model', surface: 'subagent' });
  assert.deepEqual(managedGood.poll, { at: nowMs, outcome: 'ok' });
  const managedFailed = await managedReader.read(managedSource, { nowMs: nowMs + 60_000 });
  assert.equal(managedFailed.at, managedGood.at); assert.deepEqual(managedFailed.windows, managedGood.windows);
  assert.deepEqual(managedFailed.poll, { at: nowMs + 60_000, outcome: 'unavailable', retryAt: nowMs + 120_000 });
  assert.deepEqual(usage({ stateDir: managedRoot }).lastKnown(managedSource, { nowMs: nowMs + 61_000 }), managedFailed);
  assert.equal(pacedCalls.length, 2); assert.deepEqual(pacedCalls[0], { provider: 'claude', account: managedReader.account(managedSource), origin: 'https://api.anthropic.com' });
  const controller = new AbortController(); controller.abort();
  const cancelled = await usage({ fetch: managedHttp.fetch, stateDir: managedRoot, store: memoryUsageStore() }).read(managedSource, { nowMs, signal: controller.signal });
  assert.equal(cancelled.code, 'unavailable'); assert.equal(managedHttp.calls.length, 2);
  assert.doesNotMatch(JSON.stringify({ managedGood, managedFailed, cancelled, pacedCalls }) + readFileSync(join(managedRoot, 'plans-v2.json'), 'utf8'), /synthetic-managed-token/);
});

test('a host wires Claude from explicit files, a managed folder or its own snapshot; credentials never leak', async () => {
  // Explicit files: freshness beats the endpoint, an expired token retains last-good, renewal resumes, credentials never persist.
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
  const link = join(dir, 'link.json'); symlinkSync(credentialsFile, link);
  assert.equal(reader.connected({ provider: 'claude', credentialsFile: link }), false);
  writeFileSync(credentialsFile, 'x'.repeat(65537));
  assert.equal(reader.connected(source), false);
  await assert.rejects(reader.read({ provider: 'claude', credentialsFile: '.credentials.json' }), UsageError);
  await assert.rejects(reader.read({ provider: 'claude', credentialsFile, configFile: 'relative' }), UsageError);

  // A host-owned read hook with public store/backoff hooks preserves per-account last-good readings.
  const saved = new Map<string, StoredReading>();
  const rests = new Map<string, number>(); const seen: unknown[] = []; let hookCalls = 0;
  const options: UsageOptions = {
    store: { get: (provider, id) => saved.get(`${provider}:${id}`), put: (provider, id, reading) => { seen.push({ provider, id, reading }); saved.set(`${provider}:${id}`, reading); } },
    backoff: { get: (provider, id) => rests.get(`${provider}:${id}`), set: (provider, id, until) => { rests.set(`${provider}:${id}`, until); }, delayMs: (retry) => Math.max(600_000, retry ?? 0) },
  };
  const hookSource: Source = { provider: 'claude', accountUuid: 'hook-account', read: async ({ nowMs: clock, signal }) => {
    assert.equal(signal.aborted, false); assert.ok(clock >= nowMs); hookCalls++;
    return hookCalls === 1 ? { raw: { ...payloads.claude.raw, token: 'never-store', path: 'private-path' }, at: clock } : { code: 'rate-limited', retryAfterMs: 120_000 };
  } };
  const hookReader = usage(options);
  const hookFirst = await hookReader.read(hookSource, { nowMs });
  assert.deepEqual(hookFirst.windows, payloads.claude.windows);
  assert.doesNotMatch(JSON.stringify(seen), /hook-account|never-store|private-path|raw/);
  const hookFailed = await hookReader.read(hookSource, { nowMs: nowMs + 60_000 });
  assert.equal(hookFailed.code, 'rate-limited'); assert.equal(hookFailed.at, hookFirst.at);
  const hookRestart = usage(options);
  assert.deepEqual(hookRestart.lastKnown(hookSource, { nowMs: nowMs + 61_000 }), hookFailed);
  assert.equal((await hookRestart.read(hookSource, { nowMs: nowMs + 659_999 })).code, 'rate-limited');
  assert.equal(hookCalls, 2);
  const hookOther: Source = { ...hookSource, accountUuid: 'another-account', read: async () => ({ raw: payloads.claude.raw }) };
  assert.equal((await hookRestart.read(hookOther, { nowMs: nowMs + 61_000 })).code, undefined);
  assert.equal((await hookRestart.read({ ...hookSource, connected: () => false }, { nowMs })).code, 'not-connected');

  // The public file store and backoff policy share disk last-good and account backoff across readers.
  const helperDir = scratchDir('usage-public-helpers');
  const helperCredentials = join(helperDir, 'credentials.json');
  writeFileSync(helperCredentials, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-secret', accountUuid: 'account-one' } }));
  const helperSource: Source = { provider: 'claude', credentialsFile: helperCredentials };
  const helperState = join(helperDir, 'state');
  const store = fileUsageStore(helperState);
  const backoff = memoryBackoffPolicy();
  const helperHttp = fakeFetch([{ body: payloads.claude.raw }, { status: 429, retryAfter: '600' }, { body: payloads.claude.raw }]);
  const helperOptions = { store, backoff, salt: payloads.salt, fetch: helperHttp.fetch };
  const helperReader = usage(helperOptions);
  const good = await helperReader.read(helperSource, { nowMs });
  const account = fingerprint(payloads.salt)('claude', 'account-one');
  assert.equal(helperReader.account(helperSource), account);
  assert.deepEqual(fileUsageStore(helperState).get('claude', account), { at: nowMs, windows: good.windows, poll: good.poll });
  assert.equal((await helperReader.read(helperSource, { nowMs: nowMs + 60_000 })).code, 'rate-limited');
  assert.equal(backoff.get('claude', account), nowMs + 660_000);
  backoff.set('claude', account, nowMs + 120_000);
  const helperRestarted = usage({ ...helperOptions, store: fileUsageStore(helperState) });
  const cached = helperRestarted.lastKnown(helperSource, { nowMs: nowMs + 120_000 })!;
  assert.equal(cached.at, good.at);
  assert.deepEqual(cached.windows, good.windows);
  assert.equal(cached.poll?.outcome, 'rate-limited');
  assert.deepEqual(await helperRestarted.read(helperSource, { nowMs: nowMs + 120_000 }), cached);
  assert.equal(helperHttp.calls.length, 2);
  assert.equal((await helperRestarted.read(helperSource, { nowMs: nowMs + 660_000 })).code, undefined);
  assert.equal(helperHttp.calls.length, 3);
  assert.doesNotMatch(readFileSync(join(helperState, 'plans-v2.json'), 'utf8'), /fixture-secret|account-one|accessToken/);
  assert.equal(statSync(join(helperState, 'plans-v2.json')).mode & 0o777, 0o600);
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

  // The managed folder source is read-only, bounded, carries app-passed headers and never exposes credentials.
  const managedDir = scratchDir('claude-managed'); const managedFolder = join(managedDir, 'claude', 'abcdef'); mkdirSync(managedFolder, { recursive: true });
  const credential = join(managedFolder, '.credentials.json');
  const token = 'synthetic-secret-token';
  writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'synthetic-refresh', expiresAt: nowMs + 300_000 } }), { mode: 0o600 });
  const beforeCredential = readFileSync(credential, 'utf8'); const metadata = statSync(credential);
  const managedSource: Source = { provider: 'claude', folder: managedFolder, headers: { 'anthropic-beta': 'app-beta', 'User-Agent': 'app-agent' } };
  const managedHttp = fakeFetch([{ body: { ...payloads.claude.raw, access_token: token } }, { status: 429 }, { text: token }, { status: 401 }, { text: 'x'.repeat(65537) }]);
  const managedReader = usage({ stateDir: managedDir, fetch: managedHttp.fetch });
  assert.ok(managedReader.connected(managedSource)); const managedIdentity = managedReader.account(managedSource);
  const [managedGood, managedDuplicate] = await Promise.all([managedReader.read(managedSource, { nowMs }), managedReader.read(managedSource, { nowMs })]);
  assert.deepEqual(managedGood.windows, payloads.claude.windows); assert.deepEqual(managedGood, managedDuplicate); assert.equal(managedHttp.calls.length, 1);
  assert.equal(managedHttp.calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.deepEqual(managedHttp.calls[0].init?.headers, { accept: 'application/json', authorization: `Bearer ${token}`, 'anthropic-beta': 'app-beta', 'User-Agent': 'app-agent' });
  assert.equal(managedHttp.calls[0].init?.redirect, 'error');
  assert.deepEqual(await managedReader.read(managedSource, { nowMs: nowMs + 59_999 }), managedGood);
  assert.deepEqual(usage({ stateDir: managedDir }).lastKnown(managedSource, { nowMs: nowMs + 60_000 }), managedGood);
  assert.equal((await managedReader.read(managedSource, { nowMs: nowMs + 60_000 })).code, 'rate-limited');
  assert.equal((await managedReader.read(managedSource, { nowMs: nowMs + 61_000 })).code, 'rate-limited'); assert.equal(managedHttp.calls.length, 2);
  for (const code of ['incomplete', 'auth', 'incomplete']) {
    const result = await usage({ stateDir: managedDir, store: memoryUsageStore(), fetch: managedHttp.fetch }).read(managedSource, { nowMs: nowMs + 60_000 });
    assert.equal(result.code, code); assert.doesNotMatch(JSON.stringify(result), /synthetic-secret-token|synthetic-refresh/);
  }
  assert.equal(readFileSync(credential, 'utf8'), beforeCredential); assert.equal(statSync(credential).mtimeMs, metadata.mtimeMs);
  assert.doesNotMatch(readFileSync(join(managedDir, 'plans-v2.json'), 'utf8'), /synthetic-secret-token|synthetic-refresh|access_token/);
  writeFileSync(credential, JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt: nowMs - 1 } }));
  assert.notEqual(managedReader.account(managedSource), managedIdentity, 'credential metadata change invalidates cached account readings without loading tokens');
  const expired = await usage({ stateDir: managedDir, fetch: managedHttp.fetch }).read(managedSource, { nowMs });
  assert.equal(expired.code, 'expired'); assert.deepEqual(expired.windows, []); assert.equal(managedHttp.calls.length, 5);
  unlinkSync(credential); assert.equal(managedReader.connected(managedSource), false);
  assert.equal((await managedReader.read(managedSource, { nowMs })).code, 'not-connected');

  // The ephemeral snapshot reader is identity-free, uncached, source-local and honest about failure.
  let sharedCalls = 0;
  const shared = (): never => { sharedCalls++; throw new Error('shared identity state accessed'); };
  const ephemeralReader = usage({ store: { get: shared, put: shared }, backoff: { get: shared, set: shared }, pace: async () => shared(), fetch: async () => { shared(); return new Response(); } });
  let snapshotCalls = 0; let signedIn = true;
  const snapshot = { rate_limits: payloads.claude.raw, fetched_at: nowMs, accessToken: 'must-not-escape', folder: 'must-not-escape' };
  const ephemeralSource: Source = { provider: 'claude', ephemeral: true, connected: () => signedIn, read: async () => {
    snapshotCalls++;
    return snapshotCalls === 1 ? { raw: snapshot, at: snapshot.fetched_at } : { code: 'rate-limited', retryAfterMs: 600_000 };
  } };
  assert.equal(ephemeralReader.account(ephemeralSource), undefined);
  assert.equal(ephemeralReader.lastKnown(ephemeralSource), undefined);
  const fresh = await ephemeralReader.read(ephemeralSource, { nowMs });
  assert.deepEqual(fresh.windows, payloads.claude.windows);
  assert.equal(roomOf(fresh, nowMs).left, 58);
  assert.equal(roomOf(fresh, nowMs).freshness, 'fresh');
  assert.doesNotMatch(JSON.stringify(fresh), /must-not-escape|accessToken|folder/);
  const ephemeralFailed = await ephemeralReader.read(ephemeralSource, { nowMs: nowMs + 1 });
  assert.equal(ephemeralFailed.code, 'rate-limited');
  assert.deepEqual(ephemeralFailed.windows, []);
  assert.equal(ephemeralFailed.at, undefined);
  assert.equal(ephemeralFailed.poll?.retryAt, nowMs + 600_001);
  assert.equal((await ephemeralReader.read(ephemeralSource, { nowMs: nowMs + 2 })).code, 'rate-limited');
  assert.equal(snapshotCalls, 2);
  const ephemeralOther: Source = { provider: 'claude', ephemeral: true, read: async () => ({ raw: snapshot }) };
  assert.equal((await ephemeralReader.read(ephemeralOther, { nowMs })).code, undefined);
  assert.equal(roomOf(await ephemeralReader.read(ephemeralOther, { nowMs }), nowMs).freshness, 'unknown');
  assert.equal((await usage({}).read(ephemeralSource, { nowMs })).code, 'rate-limited');
  signedIn = false;
  assert.equal((await ephemeralReader.read(ephemeralSource, { nowMs })).code, 'not-connected');
  assert.equal(ephemeralReader.connected(ephemeralSource), false);
  assert.equal(ephemeralReader.lastKnown(ephemeralSource), undefined);
  assert.equal(snapshotCalls, 3);
  for (const answer of [{}, { raw: 'invalid' }, { code: 'not-connected' as const }, { code: 'auth' as const }, { code: 'expired' as const }]) {
    const result = await ephemeralReader.read({ provider: 'claude', ephemeral: true, read: async () => answer }, { nowMs });
    assert.equal(result.code, 'code' in answer ? answer.code : 'incomplete');
    assert.equal(roomOf(result, nowMs).left, 'unknown');
  }
  const hard = await ephemeralReader.read({ provider: 'claude', ephemeral: true, read: async () => ({ limited: true, at: nowMs }) }, { nowMs });
  assert.equal(roomOf(hard, nowMs).left, 0);
  await assert.rejects(ephemeralReader.read({ ...ephemeralOther, accountUuid: 'invented' } as Source), UsageError);
  assert.equal(sharedCalls, 0);
});

test('a host records runtime calls and measured tokens with honest billing labels and app prices', async () => {
  // The member token ledger: local days, seven-day caps, boundaries and host persistence.
  const store = memoryTokenLedgerStore();
  const ledger = tokenLedger({ store, cap: (member) => member === 'alice' ? 100 : undefined });
  const start = new Date(2026, 8, 1).getTime(); const end = new Date(2026, 8, 8).getTime();
  ledger.record('alice', 10, start - 1);
  ledger.record('alice', 20, start);
  ledger.record('alice', 30, start + 1000);
  ledger.record('alice', 40, new Date(2026, 8, 7, 23, 59).getTime());
  ledger.record('alice', 500, end);
  ledger.record('bob', 200, start);
  const restartedLedger = tokenLedger({ store, cap: 100 });
  const all = restartedLedger.query('alice', start, end);
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

  // The runtime call ledger: normalized counts, honest unknowns, app prices and a shared member store.
  for (const fixture of payloads.runtime) assert.deepEqual(normalizeTokens(fixture.provider, fixture.raw), fixture.tokens);
  assert.deepEqual(normalizeTokens('claude', {}), { provenance: 'unknown' });
  assert.deepEqual(normalizeTokens('codex', { input_tokens: 100, output_tokens: 10, total_tokens: 999 }), { provenance: 'unknown' });
  assert.deepEqual(normalizeTokens('codex', { input: 100, output: 10, provenance: 'estimated' }), { provenance: 'unknown' });
  const callStore = memoryTokenLedgerStore(); const time = new Date(2026, 8, 7, 12).getTime();
  const calls = callLedger({ store: callStore, prices: { codex: { model: { billing: 'api', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1 } }, claude: { model: { billing: 'subscription', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1, cacheWritePerMillion: 3 } } } });
  const base = { account: 'account-one', model: 'model', runId: 'run-one', time, billing: 'api' as const };
  const first = calls.record('alice', { ...base, provider: 'codex', usage: { ...payloads.runtime[0].raw, secret: 'never-store' }, durationMs: 120, limits: payloads.codex.windows as Window[] });
  assert.deepEqual(first.cost, { amount: 0.00037, currency: 'USD', billing: 'api', label: "Person's API bill", basis: 'app-prices', estimated: true });
  assert.equal(first.tokens.total, 120); assert.equal(first.payer, 'alice');
  calls.record('alice', { ...base, provider: 'claude', billing: 'subscription', usage: payloads.runtime[1].raw, state: 'cancelled' });
  calls.record('bob', { ...base, provider: 'codex', usage: payloads.runtime[0].raw });
  first.tokens.total = 999;
  const callRestart = callLedger({ store: callStore });
  const query = callRestart.query('alice', time, time + 1);
  assert.equal(query.calls.length, 2); assert.equal(query.calls[1].state, 'cancelled');
  assert.equal(query.tokens.total, 240); assert.equal(query.tokens.input, 200); assert.equal(query.tokens.cachedInput, 60);
  assert.equal(query.costs.length, 2); assert.equal(query.costs[1].label, "Person's own plan");
  assert.equal(query.unpricedCalls, 0); assert.doesNotMatch(JSON.stringify(query), /never-store|usage/);
  assert.equal(tokenLedger({ store: callStore, cap: 500 }).query('alice', time, time + 1).week.remaining, 260);
  assert.equal(priceCall(normalizeTokens('codex', { input: 100, output: 20 }), undefined, 'api'), undefined);
  assert.equal(priceCall(normalizeTokens('codex', { input: 100, output: 20 }), { billing: 'api', currency: 'USD', inputPerMillion: 2, outputPerMillion: 10, cachedInputPerMillion: 1 }, 'api'), undefined);
  assert.equal(callLedger().record('alice', { ...base, provider: 'codex', usage: payloads.runtime[0].raw }).cost, undefined);
  const unknown = callRestart.record('alice', { ...base, provider: 'kimi', account: 'account-two', usage: { error: 'no reported counts' }, state: 'failed' });
  assert.equal(unknown.tokens.provenance, 'unknown'); assert.equal(unknown.cost, undefined);
  const partial = callRestart.query('alice', time, time + 1);
  assert.equal(partial.tokens.total, undefined); assert.equal(partial.unpricedCalls, 1);
  const member = tokenLedger({ store: callStore, cap: 500 }).query('alice', time, time + 1);
  assert.equal(member.tokens, 240); assert.equal(member.unknownCalls, 1); assert.equal(member.week.remaining, undefined);
  assert.equal(member.week.unknownCalls, 1);
  assert.throws(() => calls.record('alice', { ...base, provider: 'codex', durationMs: -1 }), TokenLedgerError);
  assert.throws(() => calls.query('alice', time + 1, time), TokenLedgerError);

  // Host results aggregate per run with lane attribution, member limits and no extra calls.
  {
  const store = memoryTokenLedgerStore();
  const calls = callLedger({ store });
  const base = { provider: 'anthropic', account: 'host-account', model: 'model-one', runId: 'run-one', time: nowMs,
    lane: 'host', route: 'anthropic-cli', limits: payloads.claude.windows as Window[] };
  let requests = 0;
  const account = anthropic({ key: 'fixture-key', fetch: async () => {
    requests++;
    return Response.json({ id: 'message-one', type: 'message', role: 'assistant', model: 'model-one',
      content: [{ type: 'text', text: 'never-store-answer' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: payloads.runtime[1].raw.usage });
  } });
  const direct = await account.respond({ model: 'model-one', max_tokens: 100,
    messages: [{ role: 'user', content: 'never-store-prompt' }], result: true });
  const billed = calls.record('alice', { ...base, route: 'anthropic', billing: 'api', usage: direct });
  assert.equal(billed.billingLabel, "Person's API bill");
  const end: RunEnd = { ...payloads.hostRuns.openclaw, ok: true };
  assert.ok(end.ok);
  const subscription = calls.record('alice', { ...base, time: nowMs + 1, usage: end, usageFormat: 'openclaw' });
  assert.equal(subscription.billing, 'subscription');
  assert.equal(subscription.billingLabel, "Person's own plan");
  assert.deepEqual(subscription.tokens, payloads.runtime[1].tokens);
  assert.equal(subscription.cost, undefined); // Engine price guesses never enter the ledger.
  let decisions = 0;
  const cache = new MemoryCache();
  const backend = { name: 'fixture', leaves: false, async ask() {
    decisions++;
    return { check: { probabilities: { true: 1, false: 0 }, usage: payloads.hostRuns.decide, raw: { secret: 'never-store-secret' } } };
  } };
  const questions = { check: { kind: 'yesno' as const, question: 'Ready?' } };
  const options = { privacy: 'stays-here' as const, backends: [backend], cache };
  const answer = (await decide('fixture-state', questions, options)).check;
  calls.record('alice', { ...base, provider: 'fixture', route: 'decision', model: 'model-two', time: nowMs + 2, usage: answer });
  const cached = (await decide('fixture-state', questions, options)).check;
  assert.equal(cached.source, 'cache');
  calls.record('bob', { ...base, usage: direct });
  calls.record('alice', { ...base, runId: 'run-two', time: nowMs + 3, usage: { input: 1, output: 2, cachedInput: 0 } });
  calls.record('alice', { ...base, time: nowMs - 1, usage: direct });
  const restarted = callLedger({ store });
  const run = restarted.queryRun('alice', 'run-one', nowMs, nowMs + 3);
  assert.equal(run.runId, 'run-one');
  assert.equal(run.calls.length, 3);
  assert.deepEqual(run.tokens, payloads.hostRuns.tokens);
  assert.equal(run.tokens.cachedInput, undefined);
  assert.deepEqual(run.calls.map((call) => [call.lane, call.route, call.model]),
    [['host', 'anthropic', 'model-one'], ['host', 'anthropic-cli', 'model-one'], ['host', 'decision', 'model-two']]);
  assert.deepEqual(run.calls[0].limits, payloads.claude.windows);
  assert.deepEqual(restarted.runs('alice', nowMs, nowMs + 4).map((r) => [r.runId, r.tokens.total]), [['run-one', 290], ['run-two', 3]]);
  assert.equal(restarted.queryRun('bob', 'run-one', nowMs, nowMs + 3).tokens.total, 120);
  const allowance = tokenLedger({ store, cap: () => 500 }).query('alice', nowMs, nowMs + 4);
  assert.equal(allowance.tokens, 293);
  assert.equal(allowance.week.tokens, 413);
  assert.equal(allowance.week.remaining, 87);
  assert.doesNotMatch(JSON.stringify(run), /never-store|fixture-key|costUsd|raw/);
  run.calls[0].tokens.input = 999;
  run.calls[0].limits![0].usedPercent = 99;
  assert.equal(restarted.queryRun('alice', 'run-one', nowMs, nowMs + 3).tokens.input, 240);
  assert.deepEqual(restarted.queryRun('alice', 'run-one', nowMs, nowMs + 3).calls[0].limits, payloads.claude.windows);
  assert.deepEqual(restarted.queryRun('alice', 'missing', nowMs, nowMs + 4).tokens,
    { input: 0, output: 0, cachedInput: 0, cacheWrite: 0, total: 0, provenance: 'reported' });
  calls.record('alice', { ...base, time: nowMs + 4, state: 'failed' });
  assert.equal(restarted.queryRun('alice', 'run-one', nowMs, nowMs + 5).tokens.total, undefined);
  assert.equal(tokenLedger({ store, cap: 500 }).query('alice', nowMs, nowMs + 5).week.remaining, undefined);
  assert.deepEqual(normalizeTokens('anthropic', {}, 'openclaw'), { provenance: 'unknown' });
  assert.deepEqual(normalizeTokens('anthropic', { usage: { output: 7 } }, 'openclaw'),
    { output: 7, cachedInput: 0, cacheWrite: 0, provenance: 'partial' });
  assert.deepEqual(normalizeTokens('anthropic', { input: 10, output: 5, cacheRead: 2, total: 15 }, 'openclaw'), { provenance: 'unknown' });
  assert.throws(() => calls.record('alice', { ...base, lane: 'host\nsecret' }), TokenLedgerError);
  assert.throws(() => calls.record('alice', { ...base, route: '' }), TokenLedgerError);
  assert.throws(() => calls.record('alice', { ...base, usageFormat: 'other' as 'openclaw' }), TokenLedgerError);
  assert.throws(() => restarted.queryRun('alice', '', nowMs, nowMs + 5), TokenLedgerError);
  assert.throws(() => restarted.runs('alice', nowMs + 5, nowMs), TokenLedgerError);
  assert.throws(() => restarted.queryRun('alice', 'run-one', nowMs + 5, nowMs), TokenLedgerError);
  assert.equal(requests, 1);
  assert.equal(decisions, 1);
  }
});

test('a plan screen shows account-scoped activity and honest room, and stays portable', async () => {
  // roomOf keeps the tightest window, millisecond resets, span mapping and 24h freshness.
  const reading = { provider: 'codex' as const, at: nowMs, windows: payloads.codex.windows as Window[] };
  assert.deepEqual(roomOf(reading, nowMs), { left: 10, span: 'week', resetsAt: 1788616800000, at: nowMs, ageMs: 0, freshness: 'fresh' });
  assert.deepEqual(roomOf(reading, nowMs + 86_400_001), { left: 'unknown', at: nowMs, ageMs: 86_400_001, freshness: 'stale' });
  assert.deepEqual(roomOf({ ...reading, windows: [] }, nowMs), { left: 'unknown', at: nowMs, ageMs: 0, freshness: 'fresh' });
  for (const [kind, span] of [['session', 'session'], ['weekly', 'week'], ['monthly', 'month'], ['rolling', 'tightest'], ['custom', 'tightest']] as const) {
    assert.deepEqual(roomOf({ ...reading, windows: [{ provider: 'codex', kind, usedPercent: 20 }] }, nowMs), { left: 80, span, at: nowMs, ageMs: 0, freshness: 'fresh' });
  }

  // The plan view keeps every activity section account-scoped and a poll failure distinct from exhaustion.
  const ledger = callLedger();
  const call = ledger.record('umer', { provider: viewFixture.provider, account: viewFixture.account, model: viewFixture.model,
    runId: 'one', time: viewFixture.now, billing: 'subscription', usage: { total: viewFixture.tokens } });
  const other = { ...call, account: 'other', tokens: { total: 9, provenance: 'partial' as const } };
  const failed: Reading = { provider: 'codex', windows: [], code: 'rate-limited' };
  const view = planView({ provider: 'codex', account: viewFixture.account, calls: [call, other], nowMs: viewFixture.now,
    quota: { account: viewFixture.account, reading: failed } });
  assert.equal(view.label, viewFixture.planLabel); assert.equal(view.room.left, 'unknown');
  assert.equal(view.today.tokens, viewFixture.tokens); assert.equal(view.activity.tokens, viewFixture.tokens);
  assert.equal(view.people[0]?.tokens, viewFixture.tokens); assert.equal(view.models[0]?.label, viewFixture.modelLabel);
  assert.equal(view.activity.text, '1 recorded call in 30 days');
  const unknown = planView({ provider: 'codex', account: viewFixture.account, calls: [call, { ...call, tokens: { provenance: 'unknown' } }], nowMs: viewFixture.now });
  assert.equal(unknown.today.tokens, undefined); assert.equal(unknown.today.knownTokens, viewFixture.tokens);
  assert.equal(unknown.people[0]?.unknownCalls, 1);
  assert.throws(() => planView({ provider: 'codex', account: viewFixture.account, calls: [], nowMs: viewFixture.now, quota: { account: 'other', reading: failed } }));
  assert.equal(modelLabel('claude-opus-5-5'), 'Claude Opus 5.5');
  assert.equal(modelLabel('private-binary-name'), 'AI model');
  assert.equal(planLabel('claude'), 'Claude plan');
  assert.equal(planView({ provider: 'codex', account: viewFixture.account, calls: [], nowMs: viewFixture.now,
    quota: { account: viewFixture.account, reading: { ...failed, limited: true } } }).room.left, 0);

  // The published view entry bundles for the browser with no Node code.
  const bundle = await build({
    stdin: { contents: `import { planView } from '@byokit/usage/view'; globalThis.probe = planView;`,
      resolveDir: import.meta.dirname, sourcefile: 'plan-view.ts' },
    bundle: true, platform: 'browser', format: 'iife', write: false, metafile: true, logLevel: 'silent',
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.deepEqual(inputs.filter((path) => /node:/.test(path)), [], 'nothing from Node');
  assert.ok(bundle.outputFiles[0].text.length > 0);
});

test('a built consumer touches only the sign-in it was handed', () => {
  // The built log source opens only the selected synthetic transcript and emits no secrets.
  const logRoot = scratchDir('usage-log-isolation'); const logDecoy = decoy(join(logRoot, 'decoy'));
  const logPath = join(logRoot, 'selected.jsonl');
  writeFileSync(logPath, JSON.stringify({ type: 'assistant', timestamp: '2026-10-01T12:00:00Z', requestId: 'fixture-request',
    message: { role: 'assistant', id: 'fixture-message', model: 'fixture-model', content: CANARY,
      usage: { input_tokens: 10, output_tokens: 20 } } }) + '\n');
  const logTrace = join(logRoot, 'trace'); writeFileSync(logTrace, '');
  const logChild = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const { harnessLog, HarnessLogError } = await import('@byokit/usage');
    const source = harnessLog({files:[{path:${JSON.stringify(logPath)},format:'claude'}]});
    const result = await source.read();
    if(result.entries.length!==1||result.entries[0].usage.total!==30)throw new Error('missing counts');
    const unchanged=await source.read();
    if(unchanged.work.bytesRead||unchanged.work.parserCalls)throw new Error('rescanned transcript');
    let error;
    try { harnessLog({files:[{path:${JSON.stringify(CANARY)},format:'claude'}]}); }
    catch(e) { if(!(e instanceof HarnessLogError))throw e; error={message:e.message,code:e.code}; }
    console.log(JSON.stringify({result,unchanged,error}));
  `], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ...logDecoy.env, TRACE_ROOTS: [...logDecoy.roots, logPath].join(':'), TRACE_LOG: logTrace } });
  assert.equal(logChild.status, 0, logChild.stderr);
  assert.doesNotMatch(logChild.stdout + logChild.stderr, new RegExp(CANARY));
  const logTouches = readFileSync(logTrace, 'utf8').trim().split('\n');
  assert.ok(logTouches.includes(logPath)); assert.ok(logTouches.every((p) => p === logPath), logTouches.join('\n'));
  assert.deepEqual(logDecoy.changed(), []); assert.deepEqual(logDecoy.ran(), []);

  // Only the passed Codex sign-in folder is read; ambient sign-ins and keys are untouched.
  const codexRoot = scratchDir('usage-isolation'); const codexDecoy = decoy(join(codexRoot, 'decoy'));
  const codexHome = join(codexRoot, 'passed'); mkdirSync(codexHome);
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({ tokens: { account_id: 'passed-account' } }));
  const codexState = join(codexRoot, 'state');
  const codexFake = fakeCodex({ dir: join(codexRoot, 'fake'), raw: payloads.codex.raw });
  const codexTrace = join(codexRoot, 'trace'); writeFileSync(codexTrace, '');
  const codexChild = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const { usage } = await import('@byokit/usage');
    const reader = usage({ stateDir: ${JSON.stringify(codexState)} });
    const source = ${JSON.stringify({ provider: 'codex', bin: codexFake.bin, home: codexHome })};
    if ((await reader.read(source)).windows.length !== 2) throw new Error('missing fake reading');
    reader.account(source); reader.connected(source); reader.lastKnown(source);
  `], { encoding: 'utf8', env: { ...process.env, ...codexDecoy.env, TRACE_ROOTS: [...codexDecoy.roots, codexHome, codexState].join(':'), TRACE_LOG: codexTrace } });
  assert.equal(codexChild.status, 0, codexChild.stderr);
  const codexTouches = readFileSync(codexTrace, 'utf8').trim().split('\n');
  assert.ok(codexTouches.includes(join(codexHome, 'auth.json')));
  assert.ok(codexTouches.some((p) => p.startsWith(codexState)));
  assert.ok(codexTouches.every((p) => p === join(codexHome, 'auth.json') || p === codexState || p.startsWith(codexState + '/')), codexTouches.join('\n'));
  assert.deepEqual(codexDecoy.changed(), []); assert.deepEqual(codexDecoy.ran(), []); assert.deepEqual(codexDecoy.leaks(codexState), []);
  const codexInvocation = codexFake.invocations()[0]; assert.deepEqual(codexInvocation.env, { CODEX_HOME: codexHome });
  assert.doesNotMatch(JSON.stringify(codexInvocation), new RegExp(CANARY));
  assert.doesNotMatch(JSON.stringify(codexInvocation), new RegExp(codexDecoy.home));

  // A managed Claude folder never opens a default login, never escapes its root and never leaks a canary token.
  const managedRoot = scratchDir('claude-source-isolation'); const managedDecoy = decoy(join(managedRoot, 'decoy'));
  const managedState = join(managedRoot, 'plans'); const managedFolder = join(managedState, 'claude', 'abcdef'); mkdirSync(managedFolder, { recursive: true });
  const managedCredential = join(managedFolder, '.credentials.json');
  writeFileSync(managedCredential, JSON.stringify({ claudeAiOauth: { accessToken: CANARY, refreshToken: `${CANARY}-refresh`, expiresAt: Date.now() + 300_000 } }));
  const managedBefore = readFileSync(managedCredential, 'utf8');
  const managedTrace = join(managedRoot, 'trace'); writeFileSync(managedTrace, '');
  const managedChild = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const { usage, UsageError } = await import('@byokit/usage');
    const { symlinkSync, unlinkSync } = await import('node:fs');
    let calls=0;
    const reader=usage({stateDir:${JSON.stringify(managedState)},fetch:async()=>{calls++;return new Response(JSON.stringify({five_hour:{utilization:12},access_token:${JSON.stringify(CANARY)}}));}});
    const source=${JSON.stringify({ provider: 'claude', folder: managedFolder, headers: { 'anthropic-beta': 'passed', 'User-Agent': 'passed' } })};
    const good=await reader.read(source);
    if(good.windows.length!==1)throw new Error('missing fake usage');
    for(const folder of [${JSON.stringify(join(managedDecoy.home, '.claude'))},${JSON.stringify(join(managedRoot, 'outside'))}]){
      try{await reader.read({...source,folder,credentialsFile:${JSON.stringify(join(managedDecoy.home, '.claude', '.credentials.json'))}});throw new Error('accepted escape');}catch(e){if(!(e instanceof UsageError))throw e;}
    }
    reader.account(source);reader.connected(source);reader.lastKnown(source);
    const failed=await usage({stateDir:${JSON.stringify(managedState)},fetch:async()=>{throw new Error(${JSON.stringify(CANARY)});}}).read(source);
    unlinkSync(${JSON.stringify(managedCredential)});
    symlinkSync(${JSON.stringify(join(managedDecoy.home, '.claude', '.credentials.json'))},${JSON.stringify(managedCredential)});
    const linked=await reader.read(source);
    if(linked.code!=='not-connected')throw new Error('credential link accepted');
    if(calls!==1)throw new Error('unexpected provider request');
    console.log(JSON.stringify({good,failed,linked}));
  `], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...managedDecoy.env, TRACE_ROOTS: [...managedDecoy.roots, managedState].join(':'), TRACE_LOG: managedTrace } });
  assert.equal(managedChild.status, 0, managedChild.stderr); assert.doesNotMatch(managedChild.stdout + managedChild.stderr, new RegExp(CANARY));
  const managedTouches = readFileSync(managedTrace, 'utf8').trim().split('\n');
  assert.ok(managedTouches.includes(managedCredential));
  assert.ok(managedTouches.every((p) => p === managedState || p.startsWith(managedState + '/') || p === join(managedDecoy.home, '.claude', '.credentials.json')), managedTouches.join('\n'));
  assert.equal(managedTouches.filter((p) => p === join(managedDecoy.home, '.claude', '.credentials.json')).length, 1);
  assert.deepEqual(managedDecoy.changed(), []); assert.deepEqual(managedDecoy.ran(), []);
  assert.doesNotMatch(readFileSync(join(managedState, 'plans-v2.json'), 'utf8'), new RegExp(CANARY));
  assert.ok(managedBefore.includes(CANARY), 'the request exercised a real managed canary credential');

  // An ephemeral snapshot reads no credentials, ambient login or persistent state.
  const ephemeralRoot = scratchDir('usage-ephemeral'); const ephemeralDecoy = decoy(join(ephemeralRoot, 'decoy'));
  const ephemeralState = join(ephemeralRoot, 'state'); mkdirSync(ephemeralState);
  const ephemeralTrace = join(ephemeralRoot, 'trace'); writeFileSync(ephemeralTrace, '');
  const ephemeralChild = spawnSync(process.execPath, ['--import', traceFs, '--input-type=module', '-e', `
    const { usage, roomOf } = await import('@byokit/usage');
    const reader = usage({stateDir:${JSON.stringify(ephemeralState)},fetch:async()=>{throw new Error('unexpected HTTP');}});
    const source = {provider:'claude',ephemeral:true,read:async()=>({raw:{rate_limits:${JSON.stringify(payloads.claude.raw)}},at:1788600000000})};
    const result = await reader.read(source,{nowMs:1788600000000});
    if(roomOf(result,1788600000000).left!==58)throw new Error('snapshot not usable');
    if(reader.account(source)!==undefined||reader.lastKnown(source)!==undefined||!reader.connected(source))throw new Error('identity/cache boundary');
  `], { encoding: 'utf8', env: { ...process.env, ...ephemeralDecoy.env, TRACE_ROOTS: [...ephemeralDecoy.roots, ephemeralState].join(':'), TRACE_LOG: ephemeralTrace } });
  assert.equal(ephemeralChild.status, 0, ephemeralChild.stderr);
  assert.equal(readFileSync(ephemeralTrace, 'utf8'), '');
  assert.deepEqual(ephemeralDecoy.changed(), []); assert.deepEqual(ephemeralDecoy.ran(), []);
});
