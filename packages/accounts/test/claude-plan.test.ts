import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Accounts, ClaudePlanExpiredError, ClaudePlanPlatformError, claudeAuthorization, claudeCode, keystoreStore, memoryStore, offered, planLabel, PROVIDERS, recordStore } from '../src/portable.ts';
import type { OAuthCredential, CredentialStore } from '@earendil-works/pi-ai';
import { needsReauth } from '../src/stores.ts';

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/claude-plan-typescript.json', import.meta.url), 'utf8'));
const stream = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/claude-messages-typescript.json', import.meta.url), 'utf8')).cases[0].stream;
const id = 'byokit-claude-plan';
const request = { provider: 'claude' as const, model: 'claude-opus-5-5', max_tokens: 100, messages: [{ role: 'user' as const, content: 'Hello' }] };
const token = (expires = fixture.now + 60_000): OAuthCredential => ({ type: 'oauth', access: 'recorded-access', refresh: 'recorded-refresh', expires });
function standIn(store = memoryStore()) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  let response: any = fixture.exchange, status = 200;
  const f = (async (url: any, init: RequestInit) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (String(url).endsWith('/v1/messages')) return new Response(status === 200 ? stream : JSON.stringify({ error: { message: 'recorded-access recorded-refresh' } }), { status });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  const a = new Accounts({ store: () => store, fetch: f, claudePlan: { now: () => fixture.now } });
  return { a, store, calls, set(value: any, code = 200) { response = value; status = code; } };
}

test('Claude is a default subscription route; API key remains separate and explicit', () => {
  assert.ok(offered().some((p) => p.key === 'claude'));
  assert.ok(!offered().some((p) => p.billing === 'api'));
  assert.equal(PROVIDERS.claude.billing, 'subscription');
  assert.deepEqual(new Accounts().providers.map((p) => p.key), ['chatgpt', 'grok', 'claude', 'kimi'], 'every subscription route the computer can drive; the phone ones came from catalogue device data');
});

test('offline authorization URL, independent random state and PKCE S256 verifier/challenge', async () => {
  const p = await claudeAuthorization(), other = await claudeAuthorization();
  const u = new URL(p.url);
  assert.equal(u.origin + u.pathname, fixture.authorize);
  for (const [key, value] of Object.entries({ client_id: fixture.clientId, redirect_uri: fixture.redirect, scope: fixture.scope, response_type: 'code', code: 'true', code_challenge_method: 'S256', state: p.state })) assert.equal(u.searchParams.get(key), value);
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/); assert.match(p.state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(p.state, p.verifier); assert.notEqual(p.verifier, other.verifier); assert.notEqual(p.state, other.state);
  assert.equal(u.searchParams.get('code_challenge'), createHash('sha256').update(p.verifier).digest('base64url'));
  await assert.rejects(claudeAuthorization({ crypto: {} as Crypto }), ClaudePlanPlatformError);
});

test('strict paste: code#state or redirect URL; rejects missing/mismatched/extra state', () => {
  assert.equal(claudeCode('code#state', 'state'), 'code');
  assert.equal(claudeCode(`${fixture.redirect}?code=code&state=state`, 'state'), 'code');
  for (const paste of ['code', 'code#wrong', '#state', 'code#state#extra', `${fixture.redirect}?code=code`]) assert.throws(() => claudeCode(paste, 'state'));
});

test('recorded manual flow: notify, paste, JSON exchange, member-owned credential and local logout', async () => {
  const s = standIn();
  const v = await s.a.login(1, 'claude');
  assert.equal(v?.via, 'browser'); assert.equal(v?.state, 'waiting');
  const state = new URL(v!.url!).searchParams.get('state');
  s.a.paste(1, 'claude', `recorded-code#${state}`);
  await s.a.finished(1, 'claude');
  assert.equal(s.a.view(1, 'claude')?.state, 'done');
  const c = await s.store.read(id); assert.deepEqual(c, { type: 'oauth', access: 'recorded-access', refresh: 'recorded-refresh', expires: fixture.now + 3600_000 });
  const exchange = s.calls[0]; assert.equal(exchange.url, fixture.token);
  assert.deepEqual({ ...exchange.body, code_verifier: '(verifier)' }, { grant_type: 'authorization_code', client_id: fixture.clientId, code: 'recorded-code', state, redirect_uri: fixture.redirect, code_verifier: '(verifier)' });
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), new URL(v!.url!).searchParams.get('code_challenge'));
  assert.equal(new Headers(exchange.init.headers).get('user-agent'), 'axios/1.7.9');
  await s.a.logout(1, 'claude'); assert.equal(await s.store.read(id), undefined); assert.equal(s.calls.length, 1, 'no invented revocation request');
});

test('state mismatch and cancellation exchange nothing; another member has an independent pending flow', async () => {
  const s = standIn();
  const v = await s.a.login(1, 'claude');
  s.a.paste(1, 'claude', 'code#wrong'); await s.a.finished(1, 'claude');
  assert.equal(s.a.view(1, 'claude')?.state, 'failed'); assert.equal(s.calls.length, 0); assert.equal(await s.store.read(id), undefined);
  await s.a.login(2, 'claude'); s.a.cancel(2, 'claude'); await s.a.finished(2, 'claude');
  assert.equal(s.calls.length, 0); assert.ok(v?.url); s.a.stop();
});

test('rotation is single-flight across concurrent resolves, saved before returning, omitted replacement requires sign-in and is never resent', async () => {
  const s = standIn(); await s.store.modify(id, async () => token()); s.set(fixture.rotation);
  const rt = await s.a.runtime(1);
  const all = await Promise.all(Array.from({ length: 12 }, () => rt.getAuth(id)));
  assert.equal(s.calls.length, 1); assert.ok(all.every((a) => a?.auth.apiKey === 'rotated-access'));
  assert.equal((await s.store.read(id) as OAuthCredential).refresh, 'rotated-refresh');
  assert.deepEqual(s.calls[0].body, { grant_type: 'refresh_token', client_id: fixture.clientId, refresh_token: 'recorded-refresh' });
  s.set(fixture.withoutRotation);
  await assert.rejects(rt.getAuth(id, { minOAuthValidityMs: 100_000_000 }), ClaudePlanExpiredError);
  assert.ok(needsReauth(await s.store.read(id)), 'the grant that may be spent stays marked, not deleted');
  await assert.rejects((await s.a.runtime(1)).getAuth(id, { minOAuthValidityMs: 100_000_000 }), ClaudePlanExpiredError);
  assert.equal(s.calls.length, 2);
});

test('invalid grant and missing refresh require sign-in; failed durable rotation sends nothing and keeps the sign-in', async () => {
  const invalid = standIn(); await invalid.store.modify(id, async () => token()); invalid.set(fixture.invalidGrant, 400);
  const rt = await invalid.a.runtime(1);
  await assert.rejects(rt.getAuth(id), ClaudePlanExpiredError); assert.equal(await rt.getAuth(id), undefined); assert.equal(invalid.calls.length, 1);
  const missing = standIn(); await missing.store.modify(id, async () => ({ ...token(), refresh: '' }));
  await assert.rejects((await missing.a.runtime(1)).getAuth(id), ClaudePlanExpiredError); assert.equal(missing.calls.length, 0);
  let data: any = { [id]: token() };
  const failing = standIn(recordStore(async () => ({ ...data }), async () => { throw new Error('secret-recorded-refresh'); })); failing.set(fixture.rotation);
  const broken = await failing.a.runtime(1);
  for (let i = 0; i < 2; i++) await assert.rejects(broken.getAuth(id), (e: Error) => !(e instanceof ClaudePlanExpiredError) && /kept for the next try/.test(e.message) && !e.message.includes('secret'));
  assert.equal(failing.calls.length, 0); assert.equal(data[id].refresh, 'recorded-refresh');
  // An answer the provider accepted spent the grant even when it cannot be used: never sent again.
  const unreadable = standIn(); await unreadable.store.modify(id, async () => token()); unreadable.set({ ...fixture.rotation, expires_in: 0 });
  for (let i = 0; i < 2; i++) await assert.rejects((await unreadable.a.runtime(1)).getAuth(id), ClaudePlanExpiredError);
  assert.equal(unreadable.calls.length, 1); assert.ok(needsReauth(await unreadable.store.read(id)));
});

test('a refresh that gets no answer or a server error keeps the Claude sign-in and the next try rotates the same grant', async () => {
  for (const lost of [async () => { throw new Error('recorded-refresh'); }, async () => new Response('{}', { status: 503 })]) {
    const store = memoryStore(); await store.modify(id, async () => token());
    const sent: string[] = [];
    let answer = lost;
    const a = new Accounts({ store: () => store, claudePlan: { now: () => fixture.now, fetch: (async (_url: any, init: RequestInit) => {
      sent.push(JSON.parse(init.body as string).refresh_token); return answer(); }) as typeof fetch } });
    const rt = await a.runtime(1);
    await assert.rejects(rt.getAuth(id), (e: Error) => !(e instanceof ClaudePlanExpiredError) && /kept for the next try/.test(e.message) && !e.message.includes('recorded-refresh'));
    const kept = await store.read(id) as OAuthCredential;
    assert.equal(kept.refresh, 'recorded-refresh'); assert.ok(!needsReauth(kept), 'still signed in');
    assert.equal(await a.signedIn(1, 'claude'), true);
    answer = async () => new Response(JSON.stringify(fixture.rotation));
    assert.equal((await rt.getAuth(id))?.auth.apiKey, 'rotated-access');
    assert.deepEqual(sent, ['recorded-refresh', 'recorded-refresh']);
    assert.equal((await store.read(id) as OAuthCredential).refresh, 'rotated-refresh');
  }
});

test('plan inference uses direct bearer/native headers and identity body; 401 requests re-auth without replay or billing fallback', async () => {
  const s = standIn(); await s.store.modify(id, async () => token(fixture.now + 3600_000));
  assert.equal(await s.a.respond(1, request), 'Hello! 👋');
  const call = s.calls[0], headers = new Headers(call.init.headers);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages'); assert.equal(headers.get('authorization'), 'Bearer recorded-access');
  assert.equal(headers.get('x-api-key'), null); assert.equal(headers.get('x-app'), 'cli');
  assert.equal(headers.get('anthropic-beta'), 'claude-code-20250219,oauth-2025-04-20'); assert.equal(headers.get('user-agent'), 'claude-code/2.1.74 (external, cli)');
  assert.equal(headers.get('anthropic-version'), '2023-06-01'); assert.equal(call.body.provider, undefined);
  assert.equal(call.body.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  s.set({}, 401);
  await assert.rejects(s.a.respond(1, request), ClaudePlanExpiredError);
  assert.equal(s.calls.length, 2); assert.equal(await s.store.read(id), undefined); assert.equal((await s.a.status(1, 'claude')).state, 'needs_again');
});

test('two members, device keystore adapter and unoffered account retain ownership', async () => {
  const saved = new Map<string, string>();
  const backend = { get: async (name: string) => saved.get(name) ?? null, set: async (name: string, value: string) => { saved.set(name, value); } };
  const stores = new Map<number, CredentialStore>();
  const a = new Accounts({ store: (member: number) => { let s = stores.get(member); if (!s) stores.set(member, s = keystoreStore(backend, `member.${member}`)); return s; } });
  await (await a.runtime(1)).credentialStore.modify(id, async () => token());
  assert.equal(await a.signedIn(1, 'claude'), true); assert.equal(await a.signedIn(2, 'claude'), false);
  await a.logout(2, 'claude'); assert.ok(saved.get('member.1')?.includes('recorded-access'));
  await assert.rejects(new Accounts({ offer: ['chatgpt'] }).login(1, 'claude'), /not offered/);
});

test('shared device store deduplicates short-lived rotations across Accounts instances', async () => {
  const s = standIn(); await s.store.modify(id, async () => token());
  s.set({ ...fixture.rotation, expires_in: 60 });
  const other = new Accounts({ store: () => s.store, fetch: (async () => { throw new Error('duplicate refresh'); }) as typeof fetch, claudePlan: { now: () => fixture.now } });
  const [first, second] = await Promise.all([s.a.runtime(1), other.runtime(1)]);
  const results = await Promise.all([first.getAuth(id), second.getAuth(id)]);
  assert.equal(s.calls.length, 1); assert.ok(results.every((r) => r?.auth.apiKey === 'rotated-access'));
});

test('malformed expiry/token replies and failed login saves never expose tokens through logs or public failures', async () => {
  const logged: string[] = [], original = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  try {
    for (const reply of [{ ...fixture.exchange, expires_in: 0 }, { ...fixture.exchange, expires_in: '3600' }, { ...fixture.exchange, access_token: '' }]) {
      const s = standIn(); s.set(reply);
      const v = await s.a.login(1, 'claude'); s.a.paste(1, 'claude', `code#${new URL(v!.url!).searchParams.get('state')}`);
      await s.a.finished(1, 'claude'); assert.equal(s.a.view(1, 'claude')?.state, 'failed'); assert.equal(await s.store.read(id), undefined);
    }
    const store = recordStore(async () => ({}), async () => { throw new Error('recorded-access recorded-refresh'); });
    const failed = standIn(store); const v = await failed.a.login(1, 'claude');
    failed.a.paste(1, 'claude', `code#${new URL(v!.url!).searchParams.get('state')}`); await failed.a.finished(1, 'claude');
    assert.ok(!JSON.stringify(failed.a.view(1, 'claude')).includes('recorded-access'));
    assert.ok(!logged.join(' ').includes('recorded-access')); assert.ok(!logged.join(' ').includes('recorded-refresh'));
  } finally { console.error = original; }
});

test('sign-out during rotation wins and cancellation during a delayed exchange saves nothing', async () => {
  const store = memoryStore(); await store.modify(id, async () => token());
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((r) => { release = r; }), sent = new Promise<void>((r) => { entered = r; });
  const f = (async () => { entered(); await gate; return new Response(JSON.stringify(fixture.rotation)); }) as typeof fetch;
  const a = new Accounts({ store: () => store, claudePlan: { fetch: f, now: () => fixture.now } });
  const rt = await a.runtime(1), refresh = rt.getAuth(id); await sent;
  const logout = a.logout(1, 'claude'); release(); await logout; await refresh;
  assert.equal(await store.read(id), undefined);
  let finish!: () => void, exchanged!: () => void;
  const delayed = new Promise<void>((r) => { finish = r; }), started = new Promise<void>((r) => { exchanged = r; });
  const b = new Accounts({ store: () => store, claudePlan: { fetch: (async () => { exchanged(); await delayed; return new Response(JSON.stringify(fixture.exchange)); }) as typeof fetch } });
  const v = await b.login(1, 'claude'); b.paste(1, 'claude', `code#${new URL(v!.url!).searchParams.get('state')}`); await started;
  b.cancel(1, 'claude'); finish(); await b.finished(1, 'claude'); assert.equal(await store.read(id), undefined);
});

test('a resolver arriving after refresh starts joins the same flight', async () => {
  const store = memoryStore(); await store.modify(id, async () => token());
  let entered!: () => void, release!: () => void, calls = 0;
  const sent = new Promise<void>((r) => { entered = r; }), gate = new Promise<void>((r) => { release = r; });
  const a = new Accounts({ store: () => store, claudePlan: { now: () => fixture.now, fetch: (async () => { calls++; entered(); await gate; return new Response(JSON.stringify(fixture.rotation)); }) as typeof fetch } });
  const rt = await a.runtime(1), first = rt.getAuth(id); await sent;
  const second = rt.getAuth(id); release();
  const both = await Promise.all([first, second]); assert.equal(calls, 1); assert.ok(both.every((r) => r?.auth.apiKey === 'rotated-access'));
});

test('the plan is named from the Claude profile, read once per sign-in; unknown, never failing, when it does not say', async () => {
  const s = standIn(); await s.store.modify(id, async () => token(fixture.now + 3600_000));
  s.set({ account: { email: 'umer@example.com' }, organization: { organization_type: 'claude_max' } });
  assert.deepEqual(await s.a.plan(1, 'claude'), { plan: 'max', email: 'umer@example.com', work: false });
  assert.equal(s.calls[0].url, 'https://api.anthropic.com/api/oauth/profile');
  assert.equal(new Headers(s.calls[0].init.headers).get('authorization'), 'Bearer recorded-access');
  await s.a.plan(1, 'claude'); assert.equal(s.calls.length, 1, 'read once per sign-in');
  await s.a.logout(1, 'claude'); assert.equal(await s.a.plan(1, 'claude'), null);

  const t = standIn(); await t.store.modify(id, async () => token(fixture.now + 3600_000)); t.set({ error: 'recorded-access' }, 500);
  assert.deepEqual(await t.a.plan(1, 'claude'), { plan: '', email: '', work: false });
  t.set({ account: { has_claude_pro: true } });
  assert.deepEqual(await t.a.plan(1, 'claude'), { plan: 'pro', email: '', work: false }, 'a failed read is tried again');
  const u = standIn(); await u.store.modify(id, async () => token(fixture.now + 3600_000)); u.set({ organization: { organization_type: 'claude_team' } });
  assert.equal((await u.a.plan(1, 'claude'))?.work, true);

  // Another writer of the same store signs in someone else: the label follows the credential, not the member.
  u.set({ account: { email: 'other@example.com' }, organization: { organization_type: 'claude_pro' } });
  await u.store.modify(id, async () => ({ ...token(fixture.now + 3600_000), refresh: 'another-refresh' }));
  assert.deepEqual(await u.a.plan(1, 'claude'), { plan: 'pro', email: 'other@example.com', work: false });

  // Naming the plan never refreshes the sign-in, so it can never spend or lose it.
  const v = standIn(); await v.store.modify(id, async () => token(Date.now() + 60_000)); v.set({ organization: { organization_type: 'claude_max' } });
  assert.deepEqual(await v.a.plan(1, 'claude'), { plan: '', email: '', work: false });
  assert.equal(v.calls.length, 0); assert.equal((await v.store.read(id))?.type, 'oauth');

  assert.equal(planLabel('Claude', 'max'), 'Claude Max');
  assert.equal(planLabel('ChatGPT', 'plus'), 'ChatGPT Plus');
  assert.equal(planLabel('ChatGPT', 'prolite'), 'ChatGPT Pro Lite');
  assert.equal(planLabel('Claude', ''), 'Claude');
});
