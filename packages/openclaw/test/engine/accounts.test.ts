// O14a on the real pinned engine (5.15 Isolation, D9): a member runs only on its own sign-ins, sign-out removes only
// the agent's own profiles, and D9's member rule applies to new members only. Synthetic sign-ins, the loopback model
// stub, never an account or the network. Runs only in the engine job (npm run test:engine).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { startModelStub, useModelStub, type ModelStub } from '../../src/testing/model-stub.ts';

let stub: ModelStub;
before(async () => { stub = await startModelStub(); });
after(async () => { await stub?.close(); });

/** A synthetic retained ChatGPT sign-in for one member, staged through the kit's own migration (5.7). */
const seed = async (kit: OpenClawKit, dir: string, member: string) => {
  const legacy = join(dir, 'people', member, 'auth.json');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ 'openai-codex': { type: 'oauth', provider: 'openai-codex',
    access: `a-${member}`, refresh: `r-${member}`, expires: Date.now() + 30 * 86_400_000 } }));
  assert.equal(await kit.migrateRetainedLogin(member, { path: legacy }), 'staged');
};

/** The member agent's own stored profiles, read from its per-agent store. */
const stored = (stateDir: string, agent: string): string => {
  const db = new DatabaseSync(join(stateDir, 'openclaw', 'state', 'agents', agent, 'agent', 'openclaw-agent.sqlite'), { readOnly: true });
  try { return (db.prepare('SELECT store_json FROM auth_profile_store').get() as { store_json: string }).store_json; }
  finally { db.close(); }
};

/** Hold the agent's auth-profile store under a write lock until `release()`, as a refresh during a run would. */
const holdStoreLock = (stateDir: string, agent: string) => {
  const db = new DatabaseSync(join(stateDir, 'openclaw', 'state', 'agents', agent, 'agent', 'openclaw-agent.sqlite'));
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('BEGIN IMMEDIATE;');
  return () => { db.exec('ROLLBACK;'); db.close(); };
};

test('a pre-O14 two-member state: m2 never runs on m1\'s sign-in, and m2\'s sign-out leaves m1 intact', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-accounts');
  const stateDir = join(dir, 'state');
  const config = join(stateDir, 'openclaw', 'openclaw.json');
  let kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir() });
  try {
    // Two members; then m1 signs in. Before O14 the pin pinned the inherited owner to the first agent when the fleet
    // grew past one, so the saved config names m1; until the shared store moves into state-db, every other agent's turns
    // read its sign-ins through.
    await kit.start();
    await kit.ensureMember('m1');
    await kit.ensureMember('m2');
    // A member created before D9 under the older rule (`--` and all) is an existing agent the kit did not create.
    const legacyWorkspace = join(stateDir, 'openclaw', 'workspaces', 'a--b');
    await kit.call('agents.create', { name: 'a--b', workspace: legacyWorkspace });
    await kit.stop();
    await seed(kit, dir, 'm1');
    const saved = JSON.parse(readFileSync(config, 'utf8'));
    saved.agents.defaults.authInheritance = { agentId: 'm1' };
    writeFileSync(config, JSON.stringify(saved, null, 2));

    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir() });
    await kit.start();
    await useModelStub(kit, stub);
    assert.ok((await kit.providers('m1')).includes('openai'), 'm1 keeps its own sign-in');
    // The stub's config-level key (`byokit-stub`) is every agent's; a sign-in is a profile.
    assert.ok(!(await kit.providers('m2')).includes('openai'), 'm2 reads signed_out: it never signed in');
    assert.equal(await kit.signedIn('m2', 'openai'), false);
    assert.deepEqual(JSON.parse(readFileSync(config, 'utf8')).agents.defaults.authInheritance, { agentId: 'byokit-base' },
      'the kit forces the empty base on every boot');

    // An explicit pick of m1's provider for m2 ends before any model request.
    const before = stub.calls.length;
    const end = await kit.run({ member: 'm2', sessionKey: 'agent:m2:o14:pick', message: 'hello', model: 'openai/gpt-5.4' });
    assert.deepEqual(end, { ok: false, kind: 'signed-out', message: 'openai is not signed in for m2' });
    assert.equal(stub.calls.length, before, 'no stub request');

    // D9 for new members only: the existing `a--b` still runs, a new one is refused, and the base is never a member.
    assert.equal((await kit.ensureMember('a--b')).agentId, 'a--b');
    const legacy = await kit.run({ member: 'a--b', sessionKey: 'agent:a--b:o14:run', message: 'hello' });
    assert.ok(legacy.ok, JSON.stringify(legacy));
    assert.equal(stub.calls.length, before + 1);
    for (const refused of ['c--d', 'a'.repeat(25), 'main', 'openclaw', 'crestodian', 'byokit-base', 'byokit-x'])
      await assert.rejects(kit.ensureMember(refused), /invalid member id/, refused);
    assert.ok(!(await kit.call('agents.list', {}) as { agents: { id: string }[] }).agents.some(a => a.id === 'byokit-base'));

    // m2 signs in on its own, then signs out: only m2's profile goes; m1's store is byte for byte what it was.
    await kit.stop();
    await seed(kit, dir, 'm2');
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir() });
    await kit.start();
    assert.ok((await kit.providers('m2')).includes('openai'), 'm2 signed in to its own agent');
    const m1Store = stored(stateDir, 'm1');
    assert.match(m1Store, /a-m1/);
    await kit.signOut('m2', 'openai');
    assert.ok(!(await kit.providers('m2')).includes('openai'), 'm2 is signed out');
    assert.doesNotMatch(stored(stateDir, 'm2'), /a-m2/);
    assert.equal(stored(stateDir, 'm1'), m1Store, 'm1\'s profile store is untouched');
    assert.ok((await kit.providers('m1')).includes('openai'), 'm1 is still signed in');
    // Nothing of its own left: a second sign-out sends no request, so it can never reach another store.
    await kit.signOut('m2', 'openai');
    assert.equal(stored(stateDir, 'm1'), m1Store);
  } finally { await kit.stop(); }
});

// O14d on the real pinned engine: `byokit.accounts` (list/seal/ready/adopt/clear) over an agent's own profile
// store. Synthetic sign-ins through the kit's own migration (the longest field set the pin keeps), the loopback
// model stub, never an account, a provider sign-in or the network.
const CANARY = 'sk-CANARY-0f3a9c2b7d4e5168';
/** A synthetic retained login carrying every field the pin's store keeps for an OAuth credential. */
const longProfile = (account: string, access: string) => ({
  type: 'oauth', provider: 'openai-codex', access, refresh: `${access}-refresh`, expires: Date.now() + 30 * 86_400_000,
  accountId: account, email: `${account}@example.invalid`, displayName: 'A Long Display Name', clientId: 'client-1',
  enterpriseUrl: 'https://ghe.example.invalid', projectId: 'proj-1', chatgptPlanType: 'plus', subscriptionType: 'max',
  rateLimitTier: 'default_max_20x', idToken: 'id-token-1', copyToAgents: true,
});
const identity = (provider: string, accountId: string): string =>
  createHash('sha256').update(`${provider}\n${accountId}`).digest('hex').slice(0, 16);
const profilesOf = (stateDir: string, agent: string): Record<string, Record<string, unknown>> =>
  (JSON.parse(stored(stateDir, agent)) as { profiles: Record<string, Record<string, unknown>> }).profiles;

test('byokit.accounts lists, seals, adopts and clears an agent\'s own profile store', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-gateway');
  const stateDir = join(dir, 'state');
  const configPath = join(stateDir, 'openclaw', 'openclaw.json');
  const a = 'm--aaaaaa', b = 'm--bbbbbb';
  let kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir() });
  const stage = async (member: string, legacy: Record<string, unknown>) => {
    const legacyPath = join(dir, 'people', member, 'auth.json');
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify(legacy));
    assert.equal(await kit.migrateRetainedLogin(member, { path: legacyPath }), 'staged', member);
  };
  const responses: unknown[] = [];
  const accounts = async (params: Record<string, unknown>) => {
    const reply = await kit.callDynamic('byokit.accounts', params) as Record<string, unknown>;
    responses.push(reply);
    return reply;
  };
  const providers = async (agent: string) =>
    ((await accounts({ action: 'list', agentId: agent })).profiles as { provider: string; profileId: string; type: string }[])
      .map((p) => [p.provider, p.profileId, p.type]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
  try {
    await kit.start();
    await kit.ensureMember('m');
    const workspace = join(stateDir, 'openclaw', 'workspaces', 'm');
    await kit.call('agents.create', { name: a, workspace });
    await kit.call('agents.create', { name: b, workspace });
    await kit.stop();
    await stage(a, { 'openai-codex': longProfile('acct-a', CANARY),
      anthropic: { type: 'oauth', provider: 'anthropic', access: 'anthropic-a', refresh: 'anthropic-a', expires: Date.now() + 86_400_000 } });
    await stage(b, { 'openai-codex': longProfile('acct-b', `${CANARY}-b`) });

    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir() });
    await kit.start();
    await useModelStub(kit, stub);
    // The pin canonicalizes a legacy `openai-codex` login to an `openai` profile; a second one in the same run is
    // disambiguated (`openai:chatgpt-default`). Read each store's own id rather than assume its name.
    const stores = { [a]: profilesOf(stateDir, a), [b]: profilesOf(stateDir, b) };
    const openaiId = (profiles: Record<string, Record<string, unknown>>) =>
      Object.keys(profiles).find((id) => profiles[id].provider === 'openai');
    const aId = openaiId(stores[a]), bId = openaiId(stores[b]);
    assert.ok(aId && bId, 'the pin imported an openai profile for each agent');
    assert.deepEqual(Object.values(stores[a]).map((p) => p.provider).sort(), ['anthropic', 'openai'], 'only A holds two');
    assert.deepEqual(Object.values(stores[b]).map((p) => p.provider), ['openai'], 'B holds its own only');

    const { hash } = await kit.call('config.get', {}) as { hash: string };
    const model = (id: string, profileId: string) => ({ [id]: { model: { primary: `byokit-stub/test@${profileId}` } } });
    await kit.call('config.patch', { baseHash: hash, raw: JSON.stringify({ agents: { entries: { ...model(a, aId!), ...model(b, bId!) } } }) });

    const whoA = identity('openai', 'acct-a'), whoB = identity('openai', 'acct-b');
    // list: the agent's own profiles only, each with provider/profileId/type/status and the identity hash.
    assert.deepEqual(await providers(a), [['anthropic', 'anthropic:default', 'oauth'], ['openai', aId!, 'oauth']]);
    const listOpenai = (await accounts({ action: 'list', agentId: a })).profiles as { provider: string; who?: string }[];
    assert.equal(listOpenai.find((p) => p.provider === 'openai')?.who, whoA, 'who is sha256(provider\\naccountId)');
    assert.equal(listOpenai.find((p) => p.provider === 'anthropic')?.who, undefined, 'no account id, no who');
    assert.deepEqual(await providers(b), [['openai', bId!, 'oauth']], 'each agent lists only its own profile');
    assert.ok(((await accounts({ action: 'list', agentId: b })).profiles as { who?: string }[]).some((p) => p.who === whoB));

    // seal openai: keeps only it and drops the other provider on an account agent; who comes back.
    assert.deepEqual(await accounts({ action: 'seal', agentId: a, provider: 'openai' }), { ok: true, who: whoA });
    assert.deepEqual(await providers(a), [['openai', aId!, 'oauth']]);
    // A different provider names a profile that is gone: a failure that changes nothing.
    assert.deepEqual(await accounts({ action: 'seal', agentId: a, provider: 'anthropic' }), { ok: false });
    assert.deepEqual(await providers(a), [['openai', aId!, 'oauth']]);
    const readyA = await accounts({ action: 'ready', agentId: a, provider: 'openai' });
    assert.equal(readyA.ok, true);
    assert.equal(readyA.type, 'oauth');
    assert.equal(readyA.who, whoA);
    assert.equal(typeof readyA.expiresAt, 'number');

    // adopt with a who that is not from's own: nothing changes.
    const aStore = stored(stateDir, a), bStore = stored(stateDir, b);
    assert.deepEqual(await accounts({ action: 'adopt', from: a, to: b, provider: 'openai', who: whoB }), { ok: false });
    assert.equal(stored(stateDir, a), aStore);
    assert.equal(stored(stateDir, b), bStore);

    // adopt from an agent into itself is refused before any write: the record would otherwise be copied and deleted
    // from the same store, answering success over a deleted profile and a model pinned to a profile no store holds.
    assert.deepEqual(await accounts({ action: 'adopt', from: a, to: a, provider: 'openai', who: whoA }), { ok: false });
    assert.equal(stored(stateDir, a), aStore);
    const modelOfB = (): unknown => JSON.parse(readFileSync(configPath, 'utf8')).agents.entries[b].model;
    const bModel = modelOfB();

    // Target lock contention, mid-operation: config is rewritten first, so a to-store write that cannot take the
    // engine's own lock must roll the model back and leave neither store touched.
    const releaseTo = holdStoreLock(stateDir, b);
    try { assert.deepEqual(await accounts({ action: 'adopt', from: a, to: b, provider: 'openai', who: whoA }), { ok: false }); }
    finally { releaseTo(); }
    assert.equal(stored(stateDir, a), aStore, 'from is unchanged when to cannot be written');
    assert.equal(stored(stateDir, b), bStore, 'to is unchanged when its lock is held');
    assert.deepEqual(modelOfB(), bModel, 'to\'s model is rolled back when the to-store write fails');

    // Source lock contention: the from read cannot take the lock, so nothing is written anywhere.
    const releaseFrom = holdStoreLock(stateDir, a);
    try { assert.deepEqual(await accounts({ action: 'adopt', from: a, to: b, provider: 'openai', who: whoA }), { ok: false }); }
    finally { releaseFrom(); }
    assert.equal(stored(stateDir, a), aStore, 'from is unchanged when its lock is held');
    assert.equal(stored(stateDir, b), bStore, 'to is unchanged when from cannot be read');
    assert.deepEqual(modelOfB(), bModel, 'to\'s model is untouched when from cannot be read');

    // adopt with the matching who: the whole record moves into b unchanged (every field the pin stored, the longest
    // set included), a is cleared, and b's model points at the moved profile.
    const record = profilesOf(stateDir, a)[aId!];
    assert.equal(record.accountId, 'acct-a');
    assert.deepEqual(await accounts({ action: 'adopt', from: a, to: b, provider: 'openai', who: whoA }), { ok: true });
    assert.deepEqual(profilesOf(stateDir, b)[aId!], record, 'the profile record is moved verbatim');
    assert.deepEqual(profilesOf(stateDir, a), {}, 'from is cleared');
    const bEntry = JSON.parse(readFileSync(configPath, 'utf8')).agents.entries[b].model;
    assert.ok((typeof bEntry === 'string' ? bEntry : bEntry.primary).endsWith(`@${aId}`));
    assert.equal((await accounts({ action: 'ready', agentId: b, provider: 'openai' })).who, whoA);

    // clear: every profile goes, and ready fails with no profile.
    assert.deepEqual(await accounts({ action: 'clear', agentId: b }), { ok: true });
    assert.deepEqual((await accounts({ action: 'list', agentId: b })).profiles, []);
    assert.deepEqual(await accounts({ action: 'ready', agentId: b, provider: 'openai' }), { ok: false });
    assert.deepEqual(profilesOf(stateDir, b), {});

    // No response ever carried a credential: the synthetic canary is absent from every answer.
    assert.ok(!JSON.stringify(responses).includes(CANARY), 'no secret in any byokit.accounts answer');
  } finally { await kit.stop(); }
});
