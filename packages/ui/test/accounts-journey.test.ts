// The account rows and name suggestions a person sees, proven two ways: over a real two-account ChatGPT `list()`
// from the built `@byokit/accounts` (the stand-in OpenAI, a throwaway encrypted file store), and over a table
// crossing every sign-in state, every room span and the low threshold. Every import is a published entry, and the
// `accounts` entry bundles for react-native with nothing from Node in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Accounts, fileStore, portable } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { accountRows, nameSuggestions, rowsOf, type Account, type AccountRow, type Room } from '@byokit/ui/accounts';
import { scratchDir } from '../../test-support.ts';

// The test's own authenticated seal: an app's OS keychain seal stands in as AES-256-GCM. The key never leaves the run.
const key = randomBytes(32);
const sealing = {
  encryptString(text: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  },
  decryptString(data: Buffer) {
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  },
};

const account = (over: Partial<Account> = {}): Account =>
  ({ id: 'a', provider: 'chatgpt', name: 'ChatGPT', label: 'ChatGPT', state: 'ready', billing: 'subscription', ...over });
const one = (over: Partial<Account> = {}, room: Room = { left: 50, span: 'week' }, now = 1000): AccountRow =>
  accountRows([account(over)], () => room, now)[0];

test('a person with two ChatGPT accounts sees one plain row each, the room left, and no email', async () => {
  const openai = await mockOpenAI();
  const dir = scratchDir('accounts-journey');
  const accounts = new Accounts<any, number>(
    { authBase: openai.base, apiBase: openai.base, app: 'byokit ui journey', store: () => fileStore(join(dir, 'member-1.json'), sealing) },
    portable,
  );
  try {
    // The first ChatGPT sign-in keeps the provider's own name; a second identity is the person's Work account.
    Object.assign(openai.state, { accountId: 'umer-personal', email: 'umer@example.com', plan: 'plus' });
    const personalSignIn = await accounts.add(1, 'chatgpt', { via: 'code' });
    openai.approve(personalSignIn.signIn!.code!);
    await accounts.finished(1, personalSignIn.id);
    const personal = accounts.view(1, personalSignIn.id)!.id!;

    Object.assign(openai.state, { accountId: 'umer-work', email: 'umer@work.example', plan: 'plus' });
    const workSignIn = await accounts.add(1, 'chatgpt', { via: 'code' });
    openai.approve(workSignIn.signIn!.code!);
    await accounts.finished(1, workSignIn.id);
    const work = accounts.view(1, workSignIn.id)!.id!;
    await accounts.rename(1, work, 'Work');
    assert.notEqual(work, personal);

    const rooms: Record<string, Room> = { [work]: { left: 72, span: 'week' }, [personal]: { left: 30, span: 'week' } };
    const source = { accounts: () => accounts.list(1), room: (a: Account) => rooms[a.id] ?? { left: 'unknown' } };
    const rows = await rowsOf(source, Date.now());
    const byId = Object.fromEntries(rows.map((r) => [r.id, r] as const));

    assert.deepEqual(byId[work], { id: work, title: 'ChatGPT · Work', detail: 'Plus · 72% left this week', state: 'ready', billing: 'subscription', low: false });
    assert.equal(byId[personal].title, 'ChatGPT', 'the account that keeps the provider name is not repeated');
    assert.equal(byId[personal].detail, 'Plus · 30% left this week');
    assert.equal(JSON.stringify(rows).includes('@'), false, 'an email never reaches a row');

    // A room source that fails for one account leaves only that row unknown, without breaking the list.
    const partial = await rowsOf({ accounts: () => accounts.list(1), room: (a: Account) => { if (a.id === work) throw new Error('readings are down'); return rooms[a.id]; } }, Date.now());
    assert.equal(partial.find((r) => r.id === work)!.detail, 'Room left unknown');
    assert.equal(partial.find((r) => r.id === personal)!.detail, 'Plus · 30% left this week');
  } finally {
    accounts.stop();
    await openai.close();
  }
});

test('every sign-in state and room span reads honestly', () => {
  assert.deepEqual([one().detail, one().low], ['50% left this week', false]);
  assert.equal(one({ plan: 'plus' }).detail, 'Plus · 50% left this week', 'a plan is capitalised ahead of the room');
  for (const [span, word] of [['session', 'this session'], ['week', 'this week'], ['month', 'this month'], ['tightest', 'for now']] as const) {
    assert.equal(one({}, { left: 50, span }).detail, `50% left ${word}`, span);
  }
  assert.deepEqual([one({}, { left: 'unknown' }).detail, one({}, { left: 'unknown' }).low], ['Room left unknown', false]);

  assert.deepEqual([one({ state: 'signing' }).detail, one({ state: 'signing' }).action], ['Checking…', undefined]);
  const resting = one({ state: 'resting', until: 9_000_000 }, { left: 0, span: 'week' });
  assert.deepEqual([resting.detail, resting.action, resting.until, resting.low], ['Cooling down', 'wait', 9_000_000, false], 'waiting carries the refill time');
  assert.deepEqual([one({ state: 'signed_out' }).detail, one({ state: 'signed_out' }).action], ['Not signed in', 'sign_in']);
  assert.deepEqual([one({ state: 'needs_again' }).detail, one({ state: 'needs_again' }).action], ['Sign in again', 'sign_in']);
  assert.deepEqual([one({ state: 'not_included' }).detail, one({ state: 'not_included' }).action], ['Not in your plan', undefined], 'a plan exclusion is not a sign-in problem');

  // A resting account whose refill time has passed reads ready again, exactly as Auto treats it.
  assert.equal(one({ state: 'resting', until: 500 }, { left: 60, span: 'week' }, 1000).state, 'ready');
});

test('low is set at exactly 20 and not at 21, and an unknown room is never low', () => {
  assert.deepEqual([one({}, { left: 20, span: 'week' }).low, one({}, { left: 21, span: 'week' }).low], [true, false]);
  assert.deepEqual([one({}, { left: 0, span: 'week' }).low, one({}, { left: 100, span: 'week' }).low], [true, false]);
  assert.equal(one({}, { left: 'unknown' }).low, false);
  assert.equal(accountRows([account()], () => { throw new Error('no reading'); }, 1000)[0].low, false, 'a failing reading is unknown');
});

test('nameSuggestions dedupes case-insensitively, falls back to the provider, and never offers an email', () => {
  assert.deepEqual(nameSuggestions('umer@example.com', []), ['Umer', 'Umer 2', 'Umer 3']);
  assert.deepEqual(nameSuggestions('umer@example.com', ['Umer']), ['Umer 2', 'Umer 3', 'Umer 4']);
  assert.deepEqual(nameSuggestions('umer@example.com', ['uMeR']), ['Umer 2', 'Umer 3', 'Umer 4'], 'taken is compared case-insensitively');
  assert.deepEqual(nameSuggestions('umer.work-x@example.com', ['Umer']), ['Umer 2', 'Umer 3', 'Umer 4'], 'the first local part token is the name');
  assert.deepEqual(nameSuggestions(undefined, [], 'ChatGPT'), ['ChatGPT', 'ChatGPT 2', 'ChatGPT 3'], 'no email falls back to the provider name');
  assert.deepEqual(nameSuggestions(undefined, ['ChatGPT'], 'ChatGPT'), ['ChatGPT 2', 'ChatGPT 3', 'ChatGPT 4']);
  for (const s of nameSuggestions('umer@example.com', [])) assert.equal(s.includes('@'), false);
  // The suggestion an app offers is what the title shows, so an email never becomes a title.
  assert.equal(accountRows([account({ name: nameSuggestions('umer@example.com', [])[0] })], () => ({ left: 50, span: 'week' }), 1000)[0].title, 'ChatGPT · Umer');
  assert.equal(one({ name: 'umer@example.com' }).title, 'ChatGPT', 'an account name that is an email never becomes a title');
});

test('no credential on an account reaches a row', () => {
  const canary = 'sk-canary-1f2e';
  const secret = { ...account({ plan: 'plus' }), token: canary, key: canary, access: canary, refresh: canary, credential: canary } as unknown as Account;
  const rows = accountRows([secret], () => ({ left: 50, span: 'week' }), 1000);
  assert.ok(!JSON.stringify(rows).includes(canary));
});

test('the accounts entry bundles for react-native with nothing from Node or React in it', async () => {
  const bundle = await build({
    entryPoints: [new URL('../src/accounts.ts', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'esm', conditions: ['react-native'], external: ['react'], write: false, logLevel: 'silent', metafile: true,
  });
  const inputs = Object.keys(bundle.metafile!.inputs);
  assert.deepEqual(inputs.filter((f) => /(^|\/)node:/.test(f)), [], 'no Node module');
  const imports = Object.values(bundle.metafile!.outputs).flatMap((o) => o.imports.map((i) => i.path));
  assert.deepEqual(imports, [], 'nothing left to import, React included');
});
