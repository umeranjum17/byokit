import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chooseAccount, resolveSelection, roomOf, roomWords, PROVIDERS, say, type AccountLike, type AccountPick, type Defaults, type Room, type RunSelection } from '../src/portable.ts';

type Case = {
  name: string; accounts: AccountLike[]; rooms: Record<string, Room>; defaults: Defaults; selection: RunSelection;
  models?: Record<string, { id: string; available: boolean }[]>;
  expected: { ok: boolean; id?: string; why?: string; how?: string; model?: string; code?: string };
  considered?: Record<string, Record<string, unknown>>; reason?: string; reasonContains?: string; kitOnly?: boolean;
};
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/auto-pick-typescript.json', import.meta.url), 'utf8')) as { now: number; cases: Case[] };
// Rows marked `kitOnly` exercise the kit-only `bound` list and are run by @byokit/openclaw's pick.test.ts.
for (const c of fixture.cases.filter((row) => !row.kitOnly)) test(`Auto conformance: ${c.name}`, () => {
  const calls: { id: string; demand: readonly string[] }[] = [];
  const rooms = (a: AccountLike, demand: readonly string[]) => { calls.push({ id: a.id, demand }); return c.rooms[a.id] ?? { left: 'unknown' }; };
  const models = (a: AccountLike) => c.models?.[a.id] ?? [{ id: `${a.provider}/m`, available: true }];
  const picked = resolveSelection(c.accounts, c.defaults, c.selection, rooms, fixture.now, models);
  const actual = picked.ok ? { ok: true, id: picked.account.id, why: picked.why, how: picked.how, model: picked.model } : { ok: false, code: picked.code };
  assert.deepEqual(actual, c.expected);
  assert.deepEqual(picked.considered.map((r) => r.id), c.accounts.map((a) => a.id), 'one row per account in list order');
  assert.deepEqual(calls.map((r) => r.id), c.accounts.map((a) => a.id), 'one room measurement per account, shared by ranking and explanations');
  const demand = [...new Set([...(c.selection.model ? [c.selection.model] : []), ...(c.selection.needs ?? [])])];
  assert.ok(calls.every((r) => JSON.stringify(r.demand) === JSON.stringify(demand)), 'deduplicated demand passed to room');
  for (const [id, expected] of Object.entries(c.considered ?? {})) {
    const row = picked.considered.find((r) => r.id === id)!;
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(row[key as keyof typeof row] ?? null, value, `${id}.${key}`);
  }
  if (c.reason) assert.equal(picked.reason, c.reason);
  if (c.reasonContains) assert.ok(picked.reason.includes(c.reasonContains));
  if (picked.ok) assert.equal(picked.considered.find((r) => r.id === picked.account.id)!.reason, picked.why);
  if (c.selection.account === 'auto' && !c.selection.model && !c.selection.needs && !c.defaults.account && c.accounts.every((a) => a.provider === c.accounts[0].provider)) {
    const auto = chooseAccount(c.accounts, (a) => c.rooms[a.id] ?? { left: 'unknown' }, fixture.now);
    assert.deepEqual(auto && { id: auto.account.id, why: auto.why }, picked.ok ? { id: picked.account.id, why: picked.why } : undefined);
  }
});

test('roomOf takes the tightest finite window and converts only reset seconds to milliseconds', () => {
  const room = roomOf([{ usedPercent: 20, kind: 'session', resetsAt: 2000 }, { usedPercent: 70, kind: 'weekly', resetsAt: 3000 }], 1000000);
  assert.deepEqual(room, { left: 30, span: 'week', resetsAt: 3000000, at: 1000000 });
  assert.equal(roomWords(room), '30% left this week');
  assert.deepEqual(roomOf([{ usedPercent: 70, kind: 'weekly', resetsAt: 3000000 }], 1000000, 'milliseconds'), room, 'usage 0.2.0+ resets are already milliseconds');
  assert.deepEqual(roomOf([], 1000000), { left: 'unknown', at: 1000000 });
  assert.equal(roomWords(roomOf([])), 'Room left unknown');
  assert.deepEqual(roomOf([{ usedPercent: NaN, kind: 'session' }]), { left: 'unknown' });
  assert.deepEqual(roomOf([{ usedPercent: 110, kind: 'monthly', resetsAt: Infinity }]), { left: 0, span: 'month' });
  assert.deepEqual(roomOf([{ usedPercent: -20, kind: 'custom' }]), { left: 100, span: 'tightest' });
  assert.equal(roomWords({ left: 72, span: 'session' }), '72% left this session');
  assert.equal(roomWords({ left: 72, span: 'month' }), '72% left this month');
});

test('explanations use safe codes and deterministic comparisons, with no account metadata or callback extras', () => {
  const accounts = [
    { id: 'a', provider: 'p', name: 'name-canary', email: 'email-canary', access: 'access-canary', state: 'ready', billing: 'subscription' },
    { id: 'b', provider: 'p', name: 'other-canary', state: 'ready', billing: 'subscription' },
  ] as const;
  const rooms = () => ({ left: 70, span: 'week', resetsAt: 2000000, at: 999000, secret: 'room-canary' }) as const;
  const result = resolveSelection(accounts, {}, { account: 'auto' }, rooms, 1000000);
  assert.equal(result.ok && result.why, 'list_order');
  assert.deepEqual(result.considered.map((r) => [r.reason, r.confidence, r.age]), [['list_order', 'known', 1000], ['list_order', 'known', 1000]]);
  assert.doesNotMatch(JSON.stringify(result.considered), /canary|secret|email|access/);
  assert.deepEqual(result, resolveSelection(accounts, {}, { account: 'auto' }, rooms, 1000000));
  assert.deepEqual(Object.keys(result.considered[0]).sort(), ['age', 'confidence', 'id', 'left', 'reason', 'resetsAt', 'span', 'tier']);
});

test('a pick is made once, and changing a later reading does not change the returned account', () => {
  const accounts: AccountLike[] = ['a', 'b'].map((id) => ({ id, provider: 'p', name: id, state: 'ready', billing: 'subscription' }));
  let roomA = 80;
  const room = (a: AccountLike): Room => ({ left: a.id === 'a' ? roomA : 60, span: 'week' });
  const chosen = resolveSelection(accounts, {}, { account: 'auto' }, room, 1000000);
  roomA = 0;
  assert.equal(chosen.ok && chosen.account.id, 'a');
  assert.equal(resolveSelection(accounts, {}, { account: 'auto' }, room, 1000000).ok, true);
  assert.equal(chooseAccount(accounts, room, 1000000)?.account.id, 'b');
});

test('a supplied model list with no available model fails instead of returning an unusable model', () => {
  const accounts: AccountLike[] = [{ id: 'a', provider: 'p', name: 'A', state: 'ready', billing: 'subscription' }];
  const pick = resolveSelection(accounts, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 0, () => []);
  assert.equal(pick.ok, false);
  assert.equal(!pick.ok && pick.code, 'not_included');
});

test('multi-account terms are descriptive data, never a selection gate', () => {
  for (const p of Object.values(PROVIDERS)) {
    assert.ok(p.multiAccount.terms && p.multiAccount.why && p.multiAccount.source.startsWith('https://'));
  }
  assert.equal(say('auto.terms'), "Auto may use either of a provider's accounts.");
});

// Adoption is an engine responsibility. These rows test the selector's stable-reference side of that boundary.
const identity = JSON.parse(readFileSync(new URL('../../../fixtures/conformance/identity-reauth-typescript.json', import.meta.url), 'utf8')) as {
  cases: { name: string; after: { id: string; who?: string; email: string }[]; selected: string }[];
  removalRace: { member: string; otherMember: string; provider: string; credentialProvider: string };
  extension: { type: 'api_key'; key: string; vendorExtension: { identity: string; nested: (string | number)[] } };
};
for (const c of identity.cases) test(`identity conformance (host-validated records): ${c.name}`, () => {
  const accounts = c.after.map((a) => ({ ...a, provider: 'p', name: 'Same display name', state: 'ready', billing: 'subscription' } as const));
  const pick: AccountPick<typeof accounts[number]> = resolveSelection(accounts, {}, { account: c.selected }, () => ({ left: 'unknown' }), 0);
  assert.equal(pick.ok && pick.account.id, c.selected, 'only the explicit id determines ownership; no email dedup in the picker');
  assert.deepEqual(pick.considered.map((r) => r.id), accounts.map((a) => a.id));
  assert.doesNotMatch(JSON.stringify(pick.considered), /example\.test|identity-a|who|email|display/);
});

test('canonical store preserves engine extension fields and removal wins a delayed write without affecting another member', async () => {
  const { Accounts, memoryStore, recordStore } = await import('../src/portable.ts');
  let saved: { [id: string]: typeof identity.extension } = {};
  const roundtrip = () => recordStore(async () => structuredClone(saved), async (data) => { saved = JSON.parse(JSON.stringify(data)); });
  await roundtrip().modify('p', async () => identity.extension);
  assert.deepEqual(await roundtrip().read('p'), identity.extension, 'reconstructed canonical store keeps extension fields');

  const race = identity.removalRace;
  const stores = new Map<string, ReturnType<typeof memoryStore>>();
  const store = (member: string) => {
    if (!stores.has(member)) stores.set(member, memoryStore());
    return stores.get(member)!;
  };
  const kit = new Accounts({ store });
  const one = await kit.runtime(race.member);
  const two = await kit.runtime(race.otherMember);
  await one.credentialStore.modify(race.credentialProvider, async () => identity.extension);
  await two.credentialStore.modify(race.credentialProvider, async () => identity.extension);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((r) => { entered = r; });
  const gate = new Promise<void>((r) => { release = r; });
  const delayed = one.credentialStore.modify(race.credentialProvider, async (current) => {
    entered(); await gate; return { ...current!, ...identity.extension, key: 'synthetic-replacement' };
  });
  await started;
  const removed = kit.logout(race.member, race.provider);
  release();
  try {
    await Promise.all([delayed, removed]);
    assert.equal(await store(race.member).read(race.credentialProvider), undefined);
    assert.deepEqual(await store(race.otherMember).read(race.credentialProvider), identity.extension);
  } finally { release(); kit.stop(); }
});
