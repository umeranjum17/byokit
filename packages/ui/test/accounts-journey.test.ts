// The account rows and name suggestions a person sees, proven two ways: over a real two-account ChatGPT `list()`
// from the built `@byokit/accounts` (the stand-in OpenAI, a throwaway encrypted file store), and over a table
// crossing every sign-in state, every room span and the low threshold. Every import is a published entry, and the
// `accounts` entry bundles for react-native with nothing from Node in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'esbuild';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Accounts, fileStore, portable, resolveSelection } from '@byokit/accounts';
import { mockOpenAI } from '@byokit/accounts/testing';
import { cliAccounts } from '@byokit/accounts/cli';
import { accountsSource, cliSource, useAccounts, useModelPicker, type AccountHooksSource, type ModelPickerSource, type UseAccounts, type UseModelPicker } from '@byokit/ui';
import { accountRows, bestMoveTarget, modelPicker, moveWords, nameSuggestions, rowsOf, type Account, type AccountRow, type ModelInfo, type Pick, type Room, type RunSelection, type SignInState } from '@byokit/ui/accounts';
import { windowsView } from '@byokit/usage/view';
import type { Reading } from '@byokit/usage';
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

    // Both usage windows as the built @byokit/usage/view reads them: Work's from two minutes ago, Personal's two days old.
    const now = Date.now();
    const H = 3_600_000;
    const readings: Record<string, Reading> = {
      [work]: { provider: 'codex', at: now - 120_000, windows: [
        { provider: 'codex', kind: 'session', usedPercent: 10, resetsAt: now + 3 * H },
        { provider: 'codex', kind: 'weekly', usedPercent: 28, resetsAt: now + 96 * H }] },
      [personal]: { provider: 'codex', at: now - 48 * H, windows: [
        { provider: 'codex', kind: 'session', usedPercent: 85, resetsAt: now - 40 * H },
        { provider: 'codex', kind: 'weekly', usedPercent: 70, resetsAt: now + 24 * H }] },
    };
    const rooms: Record<string, Room> = { [work]: { left: 72, span: 'week' }, [personal]: { left: 15, span: 'session', resetsAt: now - 40 * H } };
    const source = { accounts: () => accounts.list(1), room: (a: Account) => rooms[a.id] ?? { left: 'unknown' },
      windows: (a: Account) => readings[a.id] && windowsView(readings[a.id], now) };
    const rows = await rowsOf(source, now);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r] as const));

    assert.deepEqual(byId[work], { id: work, title: 'ChatGPT · Work', detail: 'Plus · 72% left this week', state: 'ready', billing: 'subscription', low: false,
      windows: [
        { kind: 'weekly', text: 'Week: 72% left', resetText: 'resets in 4d', resetsAt: now + 96 * H, usedPercent: 28 },
        { kind: 'session', text: 'Session: 90% left', resetText: 'resets in 3h', resetsAt: now + 3 * H, usedPercent: 10 }],
      asOf: { at: now - 120_000, ageMs: 120_000, text: 'Read 2 minutes ago', stale: false } });
    assert.equal(byId[personal].title, 'ChatGPT', 'the account that keeps the provider name is not repeated');
    assert.equal(byId[personal].detail, 'Plus · Reset since this reading');
    // Two days old: marked stale and never low; its session reset since the reading, so that window and the room line
    // say so instead of an old percent and a countdown, while the week keeps its numbers.
    assert.deepEqual(byId[personal].windows!.map((w) => [w.text, w.resetText, w.usedPercent]),
      [['Session: reset since this reading', '', undefined], ['Week: 30% left', 'resets in 1d', 70]]);
    assert.deepEqual([byId[personal].asOf!.text, byId[personal].asOf!.stale, byId[personal].low], ['Read 2 days ago (stale)', true, false]);
    assert.equal(JSON.stringify(rows).includes('@'), false, 'an email never reaches a row');

    // An openclaw-sourced room carries no reading time: its resets show, and no age is made up.
    const undated = accountRows(await accounts.list(1), (a) => rooms[a.id], now,
      (a) => windowsView({ provider: 'codex', windows: readings[a.id].windows }, now)).find((r) => r.id === work)!;
    assert.deepEqual(undated.windows!.map((w) => w.resetText), ['resets in 4d', 'resets in 3h']);
    assert.equal(undated.asOf, undefined);

    // A room source that fails for one account leaves only that row unknown, without breaking the list.
    const partial = await rowsOf({ accounts: () => accounts.list(1), room: (a: Account) => { if (a.id === work) throw new Error('readings are down'); return rooms[a.id]; } }, Date.now());
    assert.equal(partial.find((r) => r.id === work)!.detail, 'Room left unknown');
    assert.equal(partial.find((r) => r.id === personal)!.detail, 'Plus · Reset since this reading');
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

// ---- The run picker and the Move target (WP10-S2) ----------------------------------------------------------
// The picker and `bestMoveTarget` are proven against the shared parity table the accounts and openclaw choosers
// already run: the built `@byokit/ui/accounts` and the built `@byokit/accounts` `resolveSelection` see the same
// rows, and every row of the table that Auto can act on must agree.

type FixtureAccount = { id: string; provider: string; name: string; state: SignInState; billing: Account['billing']; until?: number };
type FixtureCase = {
  name: string; accounts: FixtureAccount[]; rooms: Record<string, Room>; defaults: { account?: string; model?: string; auto?: boolean };
  selection: RunSelection; models?: Record<string, { id: string; available: boolean }[]>;
  expected: { ok: boolean; id?: string; why?: string; how?: string; model?: string; code?: string };
  considered?: Record<string, { out?: string; until?: number }>; kitOnly?: boolean;
};
const FIXTURE = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/auto-pick-typescript.json', import.meta.url), 'utf8')) as { now: number; cases: FixtureCase[] };

const toAccounts = (c: FixtureCase): Account[] =>
  c.accounts.map((a) => ({ id: a.id, provider: a.provider, name: a.name, state: a.state, billing: a.billing, ...(a.until !== undefined ? { until: a.until } : {}) }));
const toModels = (c: FixtureCase): Record<string, ModelInfo[]> => Object.fromEntries(c.accounts.map((a) => [a.id,
  (c.models?.[a.id] ?? [{ id: `${a.provider}/m`, available: true }]).map((m) => ({ id: m.id, name: m.id, available: m.available }))]));
const roomsOf = (c: FixtureCase) => (a: Account): Room => c.rooms[a.id] ?? { left: 'unknown' };
const modelsOf = (models: Record<string, ModelInfo[]>) => (a: Account): readonly ModelInfo[] => models[a.id] ?? [];

test('the picker names Auto and its reason, lists each account’s models, and marks the selection', () => {
  for (const c of FIXTURE.cases) {
    if (c.kitOnly || c.selection.account !== 'auto') continue;
    const accounts = toAccounts(c);
    const models = toModels(c);
    const pick = resolveSelection(accounts, c.defaults, c.selection, roomsOf(c), FIXTURE.now, modelsOf(models));
    const view = modelPicker(accounts, models, c.selection, pick, FIXTURE.now);
    assert.equal(view.rows[0].key, 'auto', c.name);
    assert.equal(view.rows[0].title, 'Auto — most room left', c.name);
    assert.equal(view.rows[0].detail, pick.reason, `${c.name}: the Auto row carries Pick.reason`);
    assert.equal(view.rows[0].selected, true, `${c.name}: Auto is the marked selection`);
    assert.equal(view.ok, pick.ok, `${c.name}: ok matches the pick`);
    if (pick.ok) {
      assert.equal(view.account, pick.account.id, c.name);
      assert.equal(view.model, pick.model, c.name);
      const row = view.rows.find((r) => r.key === pick.account.id)!;
      assert.deepEqual(row.models.filter((m) => m.selected).map((m) => m.id), [pick.model], `${c.name}: the run's model is marked`);
    } else {
      assert.equal(view.rows[0].disabled, true, c.name);
      assert.equal(view.rows[0].disabledReason, pick.code, `${c.name}: a typed reason`);
    }
    // An unavailable row carries Auto's own why and until, taken from the same explanation the chooser produced.
    for (const [id, expected] of Object.entries(c.considered ?? {})) {
      const row = view.rows.find((r) => r.key === id)!;
      assert.equal(row.out ?? null, expected.out ?? null, `${c.name}: ${id} why`);
      if (expected.until !== undefined) assert.equal(row.until, expected.until, `${c.name}: ${id} until`);
    }
    // One row per account, each with that account's own model rows.
    for (const a of accounts) {
      const row = view.rows.find((r) => r.key === a.id)!;
      assert.deepEqual(row.models.map((m) => m.id), (models[a.id] ?? []).map((m) => m.id), `${c.name}: ${a.id} models`);
    }
  }
});

test('a signed-out explicit pick says Sign in first and never falls back; all signed out disables Auto', () => {
  const models: Record<string, ModelInfo[]> = { a: [], b: [{ id: 'gpt-6-sol', name: 'Sol', available: true }] };
  const accounts: Account[] = [
    { id: 'a', provider: 'chatgpt', name: 'Personal', state: 'signed_out', billing: 'subscription' },
    { id: 'b', provider: 'chatgpt', name: 'Work', state: 'ready', billing: 'subscription' },
  ];
  const auto = resolveSelection(accounts, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 1000, modelsOf(models));
  assert.equal(auto.ok, true, 'Auto itself can name the ready account');
  const view = modelPicker(accounts, models, { account: 'a' }, auto, 1000);
  assert.equal(view.rows.find((r) => r.key === 'a')!.selected, true, 'the explicit pick is marked');
  assert.equal(view.rows.find((r) => r.key === 'a')!.detail, 'Sign in first', 'it says to sign in first');
  assert.equal(view.rows.find((r) => r.key === 'b')!.selected, false, 'it never falls back to Work');
  assert.equal(view.rows[0].selected, false, 'Auto is not the marked selection');
  assert.equal(view.ok, false, 'a signed-out pick is never usable');
  assert.equal(view.account, undefined);

  // Every account signed out: Auto is disabled, with the pick's own typed reason.
  const signedOut = accounts.map((a) => ({ ...a, state: 'signed_out' as const }));
  const none = resolveSelection(signedOut, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 1000, modelsOf(models));
  const disabled = modelPicker(signedOut, models, { account: 'auto' }, none, 1000);
  assert.equal(disabled.rows[0].disabled, true);
  assert.equal(disabled.rows[0].disabledReason, 'none');
  assert.equal(disabled.rows[0].selected, true);
});

test('a resting account row and its models carry why and until; a ready pick marks its model', () => {
  const until = 5_000_000;
  const resting: Account[] = [{ id: 'work', provider: 'chatgpt', name: 'Work', state: 'resting', billing: 'subscription', until }];
  const restingModels: Record<string, ModelInfo[]> = { work: [
    { id: 'sol', name: 'Sol', available: false, why: 'resting', until },
    { id: 'luna', name: 'Luna', available: false, why: 'resting', until },
  ] };
  const auto = resolveSelection(resting, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 1000, modelsOf(restingModels));
  const view = modelPicker(resting, restingModels, { account: 'work' }, auto, 1000);
  const row = view.rows.find((r) => r.key === 'work')!;
  assert.equal(row.out, 'resting');
  assert.equal(row.until, until);
  assert.deepEqual(row.models.map((m) => [m.id, m.available, m.why, m.until]),
    [['sol', false, 'resting', until], ['luna', false, 'resting', until]]);
  assert.equal(view.ok, false, 'a resting pick is not usable yet');

  // A ready pick marks exactly the run's model, not the first one.
  const ready: Account[] = [{ id: 'p', provider: 'chatgpt', name: 'Personal', state: 'ready', billing: 'subscription' }];
  const readyModels: Record<string, ModelInfo[]> = { p: [{ id: 'sol', name: 'Sol', available: true }, { id: 'luna', name: 'Luna', available: true }] };
  const autoReady = resolveSelection(ready, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 1000, modelsOf(readyModels));
  const picked = modelPicker(ready, readyModels, { account: 'p', model: 'luna' }, autoReady, 1000);
  assert.deepEqual(picked.rows.find((r) => r.key === 'p')!.models.filter((m) => m.selected).map((m) => m.id), ['luna']);
  assert.equal(picked.model, 'luna');
});

test('bestMoveTarget names Auto’s own winner, and stays undefined with nowhere to move', () => {
  for (const c of FIXTURE.cases) {
    if (c.kitOnly) continue;
    const accounts = toAccounts(c);
    const pick = resolveSelection(accounts, {}, { account: 'auto' }, roomsOf(c), FIXTURE.now, modelsOf(toModels(c)));
    if (!pick.ok) continue;
    const other = accounts.find((a) => a.id !== pick.account.id);
    if (!other) continue; // one account: nothing to move to
    const r = c.rooms[pick.account.id];
    if (r && r.left !== 'unknown' && r.left <= 0 && !(typeof r.resetsAt === 'number' && r.resetsAt <= FIXTURE.now)) continue; // no room
    assert.equal(bestMoveTarget(accounts, c.rooms, other.id, FIXTURE.now), pick.account.id, `${c.name}: agrees with Auto`);
  }

  const sub = (over: Partial<Account> = {}): Account => ({ id: 'a', provider: 'p', name: 'A', state: 'ready', billing: 'subscription', ...over });
  assert.equal(bestMoveTarget([sub()], {}, 'a'), undefined, 'one account');
  assert.equal(bestMoveTarget([sub(), sub({ id: 'b', state: 'signed_out' })], {}, 'a'), undefined, 'only signed-out peers');
  assert.equal(bestMoveTarget([sub(), sub({ id: 'b' })], { a: { left: 0, span: 'week' }, b: { left: 0, span: 'week' } }, 'a', 1000), undefined, 'no room left');
  assert.equal(bestMoveTarget([sub({ billing: 'api' }), sub({ id: 'b', billing: 'api' })], {}, ''), undefined, 'API keys only');

  assert.equal(moveWords('Work'), 'Move to Work');
  assert.equal(moveWords('Work', false), "Couldn't move to Work");
});

// ---- Live rows and the picker as React hooks (WP10-S3) -------------------------------------------------------
// `useAccounts`/`useModelPicker` from the built `@byokit/ui`, rendered with real React over a real two-account
// ChatGPT `list()` and a real `cliAccounts()` kit (fake native binary, task-private state dir): live refresh,
// select kept across refreshes, a failing room leaving only its row unknown, a mid-refresh removal dropping it.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const uiRequire = createRequire(import.meta.url);

let live: { acc: UseAccounts; pick: UseModelPicker } | undefined;
function Consumer(o: { accSource: AccountHooksSource; pickSource: ModelPickerSource }) {
  const acc = useAccounts(o.accSource);
  const pick = useModelPicker(o.pickSource);
  live = { acc, pick };
  return createElement('pre', null, JSON.stringify({
    rows: acc.rows.map((r) => [r.id, r.title, r.detail] as const),
    ready: acc.ready,
    selection: pick.selection,
    ok: pick.picker?.ok ?? null,
    account: pick.picker?.account ?? null,
    model: pick.picker?.model ?? null,
    selected: pick.picker?.rows.filter((r) => r.selected).map((r) => r.key) ?? null,
    autoDetail: pick.picker?.rows[0]?.detail ?? null,
  }));
}
const shown = (root: ReactTestRenderer): any => JSON.parse((root.root.findByType('pre').children as string[]).join(''));
function OnlyCli(o: { source: AccountHooksSource }) {
  const acc = useAccounts(o.source);
  return createElement('pre', null, JSON.stringify({ rows: acc.rows.map((r) => [r.id, r.title, r.detail] as const), ready: acc.ready }));
}
async function settled(root: ReactTestRenderer, pred: (s: any) => boolean, label: string): Promise<any> {
  for (let n = 0; n < 200; n++) {
    let s: any;
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); s = shown(root); });
    if (pred(s)) return s;
  }
  throw new Error(`never settled: ${label}: ${JSON.stringify(shown(root))}`);
}
// A fake native CLI: any argv exits 0, and `auth status` reports the fixture sign-in (never a real grant).
function fakeClaude(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}\nconsole.log(JSON.stringify({loggedIn:true,email:'alice.work@example.test',subscriptionType:'pro'}));\n`, { mode: 0o755 });
  return bin;
}

test('hooks stay live over real Accounts and cliAccounts, through refresh, pick, a failed room and mid-refresh removal', async () => {
  assert.ok(uiRequire.resolve('@byokit/ui').includes('packages/ui/dist'), 'the hooks come from the built entry');
  const openai = await mockOpenAI();
  const dir = scratchDir('account-hooks');
  const accounts = new Accounts<any, number>(
    { authBase: openai.base, apiBase: openai.base, app: 'byokit ui hooks', store: () => fileStore(join(dir, 'member-1.json'), sealing) },
    portable,
  );
  try {
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

    const rooms: Record<string, Room> = { [work]: { left: 72, span: 'week' }, [personal]: { left: 30, span: 'week' } };
    const room = (a: Account): Room => rooms[a.id] ?? { left: 'unknown' };
    const source = accountsSource<number>(accounts, 1, room);
    let root: ReactTestRenderer | undefined;
    await act(async () => { root = create(createElement(Consumer, { accSource: source, pickSource: source })); });
    const first = await settled(root!, (s) => s.ready && s.ok === true, 'first refresh');
    assert.deepEqual(first.rows.find((r: string[]) => r[0] === work), [work, 'ChatGPT · Work', 'Plus · 72% left this week']);
    assert.deepEqual(first.rows.find((r: string[]) => r[0] === personal), [personal, 'ChatGPT', 'Plus · 30% left this week']);
    const auto = await accounts.pick(1, { account: 'auto' }, room);
    assert.deepEqual([first.selection, first.account, first.selected, first.autoDetail],
      [{ account: 'auto' }, work, ['auto'], auto.ok ? auto.reason : null], 'Auto names the roomier account');

    // The picker's select() marks the explicit account at once and keeps it across a refresh.
    const models = await accounts.models(1, personal);
    await act(async () => { live!.pick.select({ account: personal }); });
    assert.deepEqual(shown(root!).selection, { account: personal });
    assert.deepEqual([shown(root!).selected, shown(root!).account, shown(root!).model],
      [[personal], personal, models[0].id], 'the explicit pick is marked with its first model');
    await act(async () => { await live!.pick.refresh(); });
    assert.deepEqual([shown(root!).selection, shown(root!).selected, shown(root!).account],
      [{ account: personal }, [personal], personal], 'a refresh keeps the caller selection');

    // A room source that fails for one account leaves only that row unknown, without breaking the list.
    const failing = accountsSource<number>(accounts, 1, (a) => { if (a.id === work) throw new Error('readings are down'); return room(a); });
    await act(async () => { root!.unmount(); root = create(createElement(Consumer, { accSource: failing, pickSource: failing })); });
    const failedRoom = await settled(root!, (s) => s.ready, 'failed-room refresh');
    assert.equal(failedRoom.rows.find((r: string[]) => r[0] === work)![2], 'Room left unknown');
    assert.deepEqual(failedRoom.rows.find((r: string[]) => r[0] === personal), [personal, 'ChatGPT', 'Plus · 30% left this week']);

    // A remove landing while a refresh is in flight still drops the row, on screen and in the back end.
    const slow = accountsSource<number>(accounts, 1, async (a) => {
      if (a.id === work) await new Promise((r) => setTimeout(r, 50));
      return room(a);
    });
    await act(async () => { root!.unmount(); root = create(createElement(Consumer, { accSource: slow, pickSource: slow })); });
    await settled(root!, (s) => s.ready, 'slow refresh');
    const flight = live!.acc.refresh();
    await act(async () => { await live!.acc.remove(work); await flight; });
    assert.equal(shown(root!).rows.some((r: string[]) => r[0] === work), false, 'the removed row is gone');
    assert.deepEqual(shown(root!).rows.find((r: string[]) => r[0] === personal), [personal, 'ChatGPT', 'Plus · 30% left this week']);
    assert.deepEqual((await accounts.list(1)).map((a) => a.id), [personal], 'the back end removed it too');
    await act(async () => { root!.unmount(); });

    // The cli adapter fits a real managed login with one line, and its rows read plainly.
    const kit = cliAccounts({ stateDir: join(dir, 'plans'), bins: { claude: fakeClaude(join(dir, 'bins')) }, env: { HOME: join(dir, 'home'), PATH: '/unused' } });
    const { account, signIn } = await kit.add('claude');
    assert.equal(spawnSync('/bin/sh', ['-c', signIn.shell], { encoding: 'utf8' }).status, 0);
    assert.equal((await kit.status(account.id)).state, 'ready');
    await kit.rename(account.id, 'Work');
    let cliRoot: ReactTestRenderer | undefined;
    const cliSeen = cliSource(kit, () => ({ left: 72, span: 'week' }));
    await act(async () => { cliRoot = create(createElement(OnlyCli, { source: cliSeen })); });
    const cliRows = await settled(cliRoot!, (s) => s.ready, 'cli refresh');
    assert.deepEqual(cliRows.rows, [[account.id, 'Claude · Work', 'Pro · 72% left this week']]);
    await act(async () => { cliRoot!.unmount(); });
  } finally {
    accounts.stop();
    await openai.close();
  }
});
