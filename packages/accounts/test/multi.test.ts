import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveSelection, type AccountLike, type AccountPick } from '../src/portable.ts';

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

test('a supplied model list with no available model fails instead of returning an unusable model', () => {
  const accounts: AccountLike[] = [{ id: 'a', provider: 'p', name: 'A', state: 'ready', billing: 'subscription' }];
  const pick = resolveSelection(accounts, {}, { account: 'auto' }, () => ({ left: 'unknown' }), 0, () => []);
  assert.equal(pick.ok, false);
  assert.equal(!pick.ok && pick.code, 'not_included');
});

// Adoption is an engine responsibility: the picker keys on the explicit id only, the store keeps extension fields and a removal beats a delayed write.
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
