// The phone and browser side (portable.ts): no Node import anywhere in it, the shared fixtures, and "Sign in with
// ChatGPT" end to end by device code against a stand-in OpenAI over real HTTP: refresh, sign-out racing a refresh,
// and the phone's secure storage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Accounts, credentialOf, devicePoll, deviceStart, memoryStore, secureStore, type SecureStoreLike } from '../src/portable.ts';
import { mockOpenAI } from '../src/testing/index.ts';

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/conformance/${name}`, import.meta.url), 'utf8'));
const openai = await mockOpenAI();
after(() => openai.close());
const kit = (store?: ReturnType<typeof memoryStore>) => new Accounts<any, number>({ app: 'Ownvoice', store: () => store ?? memoryStore(), authBase: openai.base });
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 25))) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
}

test('portable.ts reaches no Node module and no Pi code, so Metro, Vite and a browser can load it', () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const [, kind, from] of src.matchAll(/^(?:import|export)\s+(type\s+)?[^'"]*?from\s+'([^']+)'/gm) as any) {
      if (from.startsWith('./')) { if (!from.endsWith('.json')) walk(from.slice(2)); continue; }
      assert.ok(kind, `${file} imports ${from} at run time`);
    }
  };
  walk('portable.ts');
  assert.deepEqual([...seen].sort(), ['accounts.ts', 'catalogue.ts', 'engine.ts', 'limits.ts', 'portable.ts', 'stores.ts', 'words.ts']);
});

test('the shared fixtures: device-code start and poll, token responses', () => {
  const dc = fixture('device-code.json');
  for (const c of dc.start) {
    if (c.error) assert.throws(() => deviceStart(c.status, c.body), c.body);
    else assert.deepEqual(deviceStart(c.status, c.body), c.result);
  }
  for (const c of dc.poll) {
    const p = devicePoll(c.status, c.body);
    assert.equal(p.status, c.result, c.body);
    if (p.status === 'complete') assert.deepEqual([p.authorizationCode, p.codeVerifier], [c.authorizationCode, c.codeVerifier]);
  }
  const tr = fixture('token-responses.json');
  for (const c of tr.cases) {
    if (c.error) assert.throws(() => credentialOf(c.response, tr.now));
    else assert.deepEqual(credentialOf(c.response, tr.now), c.credential);
  }
});

test('sign in with ChatGPT by device code: the code and page to show, approved there, kept, plan read', async () => {
  const a = kit();
  assert.deepEqual(a.providers.map((p) => p.key), ['chatgpt'], 'only what a phone or browser can sign in to');
  const v = (await a.login(1, 'chatgpt'))!;
  assert.deepEqual([v.state, v.via, v.url], ['waiting', 'code', `${openai.base}/codex/device`]);
  assert.match(v.code!, /^MOCK-/);
  assert.ok(v.expiresAt! > Date.now());
  assert.equal((await a.status(1, 'chatgpt')).words, 'Signing in to ChatGPT…');
  // The person types the code on the provider's page.
  const typed = await fetch(`${openai.base}/codex/device`, { method: 'POST', body: new URLSearchParams({ user_code: v.code! }) });
  assert.match(await typed.text(), /Signed in/);
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt')!.state, 'done');
  assert.equal((await a.status(1, 'chatgpt')).words, 'ChatGPT is connected.');
  assert.deepEqual(await a.plan(1), { plan: 'plus', email: 'sara@example.com', work: false });
  assert.equal(await a.signedIn(2, 'chatgpt'), false, 'one person, one store');
});

test("a poll that can't get through (a backgrounded phone) waits for the next instead of failing", async () => {
  const a = kit();
  openai.state.dropPolls = 2;
  const v = (await a.login(1, 'chatgpt'))!;
  await until('both polls dropped', () => openai.state.dropPolls === 0);
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt')!.state, 'done');
});

test('declined on the page, cancelled here, or refused at the exchange: one plain sentence, nothing kept', async () => {
  const a = kit();
  let v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!, true);
  await a.finished(1, 'chatgpt');
  assert.deepEqual([a.view(1, 'chatgpt')!.why, a.view(1, 'chatgpt')!.error], ['declined', 'The sign-in was declined on the ChatGPT page. Tap Sign in with ChatGPT to try again.']);
  v = (await a.login(1, 'chatgpt'))!;
  a.cancel(1, 'chatgpt');
  await a.finished(1, 'chatgpt');
  assert.equal(a.view(1, 'chatgpt'), null);
  openai.approve(v.code!);
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(await a.signedIn(1, 'chatgpt'), false, 'approving a cancelled code signs nobody in');
});

test('refresh: ahead of expiry, rotating, one at a time; a refusal signs out once; recheck keeps a sign-in that refreshes', async () => {
  const store = memoryStore();
  const a = kit(store);
  const expired: number[] = [];
  a.onExpired = (m) => expired.push(m);
  openai.state.expiresIn = 1800; // half an hour: inside keepFresh's hour
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  const first = (await store.read('openai-codex')) as any;
  openai.state.expiresIn = 864_000;
  await Promise.all([a.keepFresh([1]), a.keepFresh([1])]);
  const second = (await store.read('openai-codex')) as any;
  assert.notEqual(second.refresh, first.refresh, 'refreshed');
  assert.equal(openai.state.requests.filter((r) => r.body.includes('grant_type=refresh_token')).length, 1, 'once, not twice');
  assert.equal(await a.recheck(1, 'chatgpt'), true, 'a sign-in that still refreshes is kept');
  assert.equal(await a.signedIn(1, 'chatgpt'), true);
  openai.state.expiresIn = 1800;
  assert.equal(await a.recheck(1, 'chatgpt'), true);
  openai.state.refuse = true;
  await a.keepFresh([1]);
  await a.keepFresh([1]);
  assert.deepEqual(expired, [1], 'said once');
  assert.equal((await a.status(1, 'chatgpt')).state, 'needs_again');
  Object.assign(openai.state, { refuse: false, expiresIn: 864_000 });
});

test('signing out while a refresh is under way: the sign-out wins, nothing comes back', async () => {
  const store = memoryStore();
  const a = kit(store);
  openai.state.expiresIn = 60; // already inside the five-minute window
  const earlier = new Set(openai.state.live);
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  const rt = await a.runtime(1);
  const refreshing = rt.getAuth('openai-codex');
  await a.logout(1, 'chatgpt');
  await refreshing.catch(() => {});
  assert.equal(await store.read('openai-codex'), undefined);
  assert.deepEqual([...openai.state.live].filter((t) => !earlier.has(t)), [], 'the token a refresh rotated to was the one ended at OpenAI');
  assert.equal(await rt.getAuth('openai-codex'), undefined, 'no refresh after sign-out');
  assert.equal(await a.signedIn(1, 'chatgpt'), false);
  openai.state.expiresIn = 864_000;
});

test('secureStore: chunked under the size expo-secure-store allows, and a crash mid-write keeps the old sign-ins', async () => {
  const kept = new Map<string, string>();
  let failAfter = Infinity;
  const secure: SecureStoreLike = {
    getItemAsync: async (k) => kept.get(k) ?? null,
    setItemAsync: async (k, v) => { assert.match(k, /^[\w.-]+$/); assert.ok(v.length <= 2048); if (failAfter-- <= 0) throw new Error('crash'); kept.set(k, v); },
    deleteItemAsync: async (k) => { kept.delete(k); },
  };
  const a = kit(secureStore(secure, 'byokit.1'));
  const v = (await a.login(1, 'chatgpt'))!;
  openai.approve(v.code!);
  await a.finished(1, 'chatgpt');
  assert.equal(await a.signedIn(1, 'chatgpt'), true);
  const s = secureStore(secure, 'byokit.1');
  const before = await s.read('openai-codex');
  assert.ok(JSON.stringify(before).length > 1800, 'a real sign-in spans pieces');
  failAfter = 1;
  await assert.rejects(s.modify('openai-codex', async () => ({ type: 'oauth', access: 'x'.repeat(4000), refresh: 'r', expires: 1 })));
  assert.deepEqual(await secureStore(secure, 'byokit.1').read('openai-codex'), before);
  failAfter = Infinity;
  await s.delete('openai-codex');
  assert.deepEqual([...kept.keys()], ['byokit.1'], 'old pieces cleaned up');
});
