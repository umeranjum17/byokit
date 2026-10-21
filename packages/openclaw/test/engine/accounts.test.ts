// O14a on the real pinned engine (5.15 Isolation, D9): a member runs only on its own sign-ins, sign-out removes only
// the agent's own profiles, and D9's member rule applies to new members only. Synthetic sign-ins, the loopback model
// stub, never an account or the network. Runs only in the engine job (npm run test:engine).
import { test, before, after, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';
import { hostKeySeal } from '../../../secrets/src/index.ts';
import { fakeOpenCodeConsole, scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { startModelStub, useModelStub, type ModelStub } from '../../src/testing/model-stub.ts';
import type { RunEvent, SignInView } from '../../src/types.ts';

// Go key adds list the key's workspaces in the kit's own process; the stand-in keys are no login, so the console
// answers 401 here (a test names other rows through `orgs.answer`). The engine never lists.
const orgs = fakeOpenCodeConsole();

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

// O14f on the real pinned engine: addAccount for a member that already holds ChatGPT creates `<member>--<hex6>` in the
// member's workspace. The pin's create-time IDENTITY.md rewrite is undone byte for byte, the fleet is explicit, the
// engine's own authorize URL is surfaced with `prompt=login`, and a cancelled sign-in removes the agent, its directory
// and its entry. Never an account or the network: the person never signs in, the sign-in is cancelled.
test('addAccount: a second ChatGPT account agent leaves IDENTITY.md byte-identical', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-add');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  let kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    await kit.stop();
    await seed(kit, dir, 'm1');
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
    await kit.start();
    const identityPath = join(root, 'workspaces', 'm1', 'IDENTITY.md');
    const before = readFileSync(identityPath);
    const roster = async () => (await kit.call('agents.list', {})).agents.map((a) => a.id);

    const views: SignInView[] = [];
    const added = await kit.addAccount('m1', { authChoice: 'openai', via: 'browser' }, (v) => views.push(v));
    assert.match(added.id, /^openai\.[0-9a-f]{6}$/);
    const agent = `m1--${added.id.slice('openai.'.length)}`;
    assert.ok((await roster()).includes(agent), 'the account agent is on the roster');
    assert.deepEqual(readFileSync(identityPath), before, 'IDENTITY.md is byte-identical after agents.create');
    assert.equal(JSON.parse(readFileSync(join(root, 'openclaw.json'), 'utf8')).agents.ownership, 'explicit');
    assert.equal(JSON.parse(readFileSync(join(root, 'accounts', 'm1.json'), 'utf8')).accounts[added.id].agent, agent);

    for (let waited = 0; !views.some((v) => v.url) && waited < 60_000; waited += 200) await delay(200);
    const url = new URL(views.find((v) => v.url)?.url ?? 'about:blank');
    assert.equal(`${url.origin}${url.pathname}`, 'https://auth.openai.com/oauth/authorize', JSON.stringify(views));
    assert.equal(url.searchParams.get('prompt'), 'login', 'the engine\'s unsigned URL asks for the login screen');

    added.cancel();
    assert.equal((await added.done).view.why, 'declined');
    assert.ok(!(await roster()).includes(agent), 'the cancelled agent is deleted');
    assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'and its directory');
    assert.ok(!(added.id in JSON.parse(readFileSync(join(root, 'accounts', 'm1.json'), 'utf8')).accounts), 'and its entry');
    assert.deepEqual(readFileSync(identityPath), before, 'IDENTITY.md is still the member\'s');
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member keeps its own sign-in');
  } finally { await kit.stop(); }
});

// O14j on the real pinned engine: `run({ account })` on an unbound key runs on the account agent's own sealed sign-in.
// Two account agents each hold their own stub key and each run bills only its own; with the member agent signed in to
// the same provider, a signed-out account agent ends signed-out before any model request. Stub keys and the loopback
// model stub only, never an account or the network.
test('run({ account }): each account agent bills its own key; a signed-out one ends signed-out', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14j-run');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  // The openai provider points at the stub with no config key: every request carries the calling profile's own key.
  const config = { plugins: { allow: ['openai'] }, models: { providers: { openai: { baseUrl: stub.url, api: 'openai-completions',
    models: [{ id: 'gpt-5.6-sol', name: 'Test', api: 'openai-completions', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } } };
  let kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    await kit.stop();
    await seed(kit, dir, 'm1');
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config });
    await kit.start();
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member agent is signed in to openai');

    // Two account agents in the member's workspace, each activated with its own stub key and sealed to it.
    const keys = { aaaaaa: 'stub-key-account-a', bbbbbb: 'stub-key-account-b' };
    const accounts: Record<string, unknown> = {};
    for (const [hex, apiKey] of Object.entries(keys)) {
      const agent = `m1--${hex}`;
      await kit.call('agents.create', { name: agent, workspace: join(root, 'workspaces', 'm1') });
      const activated = await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: agent, authChoice: 'openai-api-key', apiKey },
        { timeoutMs: 180_000 }) as { ok: boolean };
      assert.equal(activated.ok, true, agent);
      // A config write may restart a cold gateway; poll the agent's own sealed view, never an arbitrary delay.
      let ready = false;
      for (const deadline = Date.now() + 60_000; !ready && Date.now() < deadline;) {
        try {
          const sealed = await kit.callDynamic('byokit.accounts', { action: 'seal', agentId: agent, provider: 'openai' }) as { ok: boolean };
          ready = sealed.ok && (await kit.callDynamic('byokit.accounts', { action: 'ready', agentId: agent, provider: 'openai' }) as { ok: boolean }).ok;
        } catch { /* restarting */ }
        if (!ready) await delay(250);
      }
      assert.ok(ready, `${agent} holds its sealed key`);
      accounts[`openai.${hex}`] = { agent, name: `Key ${hex}`, route: 'openai-api-key', addedAt: Number.parseInt(hex, 16) };
    }
    const index = join(root, 'accounts', 'm1.json');
    mkdirSync(join(index, '..'), { recursive: true });
    writeFileSync(index, JSON.stringify({ v: 1, accounts, defaults: {} }));
    chmodSync(index, 0o600);
    // The activations' config writes can restart the gateway later, mid-run: start fresh so none is pending.
    await kit.stop();
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config });
    await kit.start();
    assert.deepEqual((await kit.accounts('m1')).map((a) => [a.id, a.billing, a.state]),
      [['openai', 'subscription', 'ready'], ['openai.aaaaaa', 'api', 'ready'], ['openai.bbbbbb', 'api', 'ready']]);

    for (const [hex, apiKey] of Object.entries(keys)) {
      const from = stub.calls.length;
      const events: RunEvent[] = [];
      const end = await kit.run({ member: 'm1', sessionKey: `agent:m1:o14j:${hex}`, message: 'hello account',
        account: `openai.${hex}`, model: 'openai/gpt-5.6-sol' }, (e) => events.push(e));
      assert.ok(end.ok && end.account === `openai.${hex}` && end.model === 'openai/gpt-5.6-sol', JSON.stringify(end));
      const first = events[0];
      assert.ok(first?.type === 'account' && first.sessionKey === `agent:m1--${hex}:o14j:${hex}` && first.how === 'chosen',
        JSON.stringify(first));
      const billed = stub.calls.slice(from).map((c) => c.authorization);
      assert.ok(billed.length > 0 && billed.every((k) => k === `Bearer ${apiKey}`), `openai.${hex} billed: ${billed.join()}`);
    }

    // B's sign-in goes; the member agent is still signed in to openai, and B's run ends before any model request.
    assert.deepEqual(await kit.callDynamic('byokit.accounts', { action: 'clear', agentId: 'm1--bbbbbb' }), { ok: true });
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member agent is still signed in');
    const before = stub.calls.length;
    const events: RunEvent[] = [];
    const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o14j:out', message: 'hello', account: 'openai.bbbbbb',
      model: 'openai/gpt-5.6-sol' }, (e) => events.push(e));
    assert.deepEqual(end, { ok: false, kind: 'signed-out', message: 'Key bbbbbb is not signed in' });
    assert.deepEqual(events.map((e) => e.type), ['account']);
    assert.ok(events[0]?.type === 'account' && events[0].account === 'openai.bbbbbb');
    assert.equal(stub.calls.length, before, 'no stub request');
    const text = JSON.stringify([readFileSync(index, 'utf8'), await kit.accounts('m1')]);
    for (const apiKey of Object.values(keys)) assert.ok(!text.includes(apiKey), 'no key in the index or the rows');
  } finally { await kit.stop(); }
});

test('addAccount: an OpenCode Go plan key is set up through activation and the first run answers on it, streamed with usage', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-go-plan-key');
  const stateDir = join(dir, 'state');
  const key = 'byokit-go-stand-in-key-5571';
  // The plugin's own catalog provider, untouched; only this kit's engine sees opencode.ai answered by the loopback
  // stub (activation's live test and the run), the way signin.test answers auth.openai.com.
  const preload = join(dir, 'go-fake.mjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(preload, `
import { mock } from 'node:test';
const fetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://opencode.ai') {
    const base = new URL(${JSON.stringify(stub.url)});
    url.protocol = base.protocol; url.host = base.host;
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return fetch(input, options);
});
`, { mode: 0o600 });
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [file, argv, options] = args;
    if (file === process.execPath && Array.isArray(argv) && argv[1] === 'gateway')
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  const kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
  try {
    await kit.start();
    const go = (from: number, bearer: string) => stub.calls.slice(from).filter((c) => c.authorization === `Bearer ${bearer}`);
    const start = stub.calls.length;
    const views: SignInView[] = [];
    const added = await kit.addAccount('m1', { authChoice: 'opencode-go' }, (v) => views.push(v));
    added.paste(key);
    assert.deepEqual(await added.done, { view: { state: 'done', via: 'browser' }, id: 'opencode-go' });
    assert.deepEqual((await kit.accounts('m1')).map((a) => [a.id, a.billing, a.state]), [['opencode-go', 'subscription', 'ready']]);
    // OpenCode Go routes only a request carrying `x-opencode-session` (400 without it, since 2026-09-06): the
    // activation's live test sends one too.
    const probe = go(start, key);
    assert.ok(probe.length && probe.every((c) => c.session), `activation probe: ${JSON.stringify(probe.map((c) => c.session))}`);

    // Straight after done, with no model named: the gateway already restarted onto the new sign-in, and the
    // models map the kit writes is not an allowlist that would send the member back to openai.
    const turn = async (sessionKey: string, spec: { member: string; auth?: 'apiKey' }, bearer: string) => {
      const before = stub.calls.length;
      const texts: string[] = [];
      const end = await kit.run({ ...spec, sessionKey, message: 'hello go' }, (e) => { if (e.type === 'text') texts.push(e.text); });
      assert.ok(end.ok, JSON.stringify(end));
      assert.ok(texts.length && end.usage?.total, 'streamed with usage');
      const calls = stub.calls.slice(before);
      assert.ok(calls.length && calls.every((c) => c.authorization === `Bearer ${bearer}` && c.body.model === 'deepseek-v4-pro' && c.session),
        JSON.stringify(calls.map((c) => [c.authorization === `Bearer ${bearer}`, c.body.model, !!c.session])));
      return new Set(calls.map((c) => c.session));
    };
    const first = await turn('agent:m1:o14:go', { member: 'm1' }, key);
    const again = await turn('agent:m1:o14:go', { member: 'm1' }, key);
    const other = await turn('agent:m1:o14:go-2', { member: 'm1' }, key);
    assert.equal(first.size, 1, 'one session header per conversation');
    assert.deepEqual([...again], [...first], 'stable across turns of one conversation');
    assert.ok(![...other].some((s) => first.has(s)), 'another conversation, another session');
    assert.ok(!JSON.stringify(views).includes(key), 'the key is never shown');

    // The key path too: addKey sets the same plan key up on the member's key agent, and `auth: 'apiKey'` runs on it.
    const key2 = 'byokit-go-stand-in-key-6682';
    assert.deepEqual(await kit.addKey('m2', { authChoice: 'opencode-go', apiKey: key2 }), { status: 'ok' });
    await turn('agent:m2:o14:go-key', { member: 'm2', auth: 'apiKey' }, key2);
  } finally { await kit.stop(); mock.restoreAll(); syncBuiltinESMExports(); }
});

// O14l on the real pinned engine: `move` forks a conversation from one account agent to another with
// `sessions.create { fork: true }` and deletes the source. The next run on the app key continues on the target with the
// full transcript: the stub sees the earlier user turn and the tool call and result, billed on the target's own key.
// Stub keys and the loopback model stub only, never an account or the network.
test('move: the transcript (user and tool rows) carries to the target agent and the source session is gone', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14l-move');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  const config = { plugins: { allow: ['openai'] }, models: { providers: { openai: { baseUrl: stub.url, api: 'openai-completions',
    models: [{ id: 'gpt-5.6-sol', name: 'Test', api: 'openai-completions', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } } };
  const tools = [{ name: 'report', description: 'record progress', parameters: { type: 'object' } }];
  const host = { gate: async () => ({ allow: true as const }),
    call: async (_run: unknown, _tool: string, input: Record<string, unknown>) => `Progress: ${String(input.text)}` };
  let kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config, tools, host });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    const keys = { aaaaaa: 'stub-key-move-a', bbbbbb: 'stub-key-move-b' };
    const accounts: Record<string, unknown> = {};
    for (const [hex, apiKey] of Object.entries(keys)) {
      const agent = `m1--${hex}`;
      await kit.call('agents.create', { name: agent, workspace: join(root, 'workspaces', 'm1') });
      const activated = await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: agent, authChoice: 'openai-api-key', apiKey },
        { timeoutMs: 180_000 }) as { ok: boolean };
      assert.equal(activated.ok, true, agent);
      let ready = false;
      for (const deadline = Date.now() + 60_000; !ready && Date.now() < deadline;) {
        try {
          const sealed = await kit.callDynamic('byokit.accounts', { action: 'seal', agentId: agent, provider: 'openai' }) as { ok: boolean };
          ready = sealed.ok && (await kit.callDynamic('byokit.accounts', { action: 'ready', agentId: agent, provider: 'openai' }) as { ok: boolean }).ok;
        } catch { /* restarting */ }
        if (!ready) await delay(250);
      }
      assert.ok(ready, `${agent} holds its sealed key`);
      accounts[`openai.${hex}`] = { agent, name: `Key ${hex}`, route: 'openai-api-key', addedAt: Number.parseInt(hex, 16) };
    }
    const index = join(root, 'accounts', 'm1.json');
    mkdirSync(join(index, '..'), { recursive: true });
    writeFileSync(index, JSON.stringify({ v: 1, accounts, defaults: {} }));
    chmodSync(index, 0o600);
    await kit.stop();
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), config, tools, host });
    await kit.start();

    // A conversation on A with a tool call, then moved to B.
    const ref = { member: 'm1', sessionKey: 'agent:m1:o14l:chat' };
    const first = await kit.run({ ...ref, message: '[tool report {"text":"Working"}]', account: 'openai.aaaaaa', model: 'openai/gpt-5.6-sol' });
    assert.ok(first.ok && first.account === 'openai.aaaaaa', JSON.stringify(first));
    assert.deepEqual(await kit.move(ref, 'openai.bbbbbb'), { ok: true, session: 'agent:m1--bbbbbb:o14l:chat' });
    const gone = await kit.call('sessions.resolve', { key: 'agent:m1--aaaaaa:o14l:chat', agentId: 'm1--aaaaaa', allowMissing: true });
    assert.deepEqual(gone, { ok: false }, 'the source session is gone');
    const moved = await kit.call('chat.history', { sessionKey: 'agent:m1--bbbbbb:o14l:chat' }) as { messages: { role?: string }[] };
    assert.ok(JSON.stringify(moved.messages).includes('[tool report {\\"text\\":\\"Working\\"}]'), 'the user row is in the target');

    // The next run on the app key continues on B (an API-billed conversation names its account, Runs step 2): the
    // model sees the user turn, the tool call and its result.
    const from = stub.calls.length;
    const next = await kit.run({ ...ref, message: 'and then', account: 'openai.bbbbbb' });
    assert.ok(next.ok && next.account === 'openai.bbbbbb', JSON.stringify(next));
    const sent = stub.calls.slice(from);
    assert.ok(sent.length > 0 && sent.every((c) => c.authorization === `Bearer ${keys.bbbbbb}`), 'billed on the target\'s own key');
    const messages = sent[0]!.body.messages ?? [];
    const text = (m: { content?: unknown }) => JSON.stringify(m.content ?? '');
    assert.ok(messages.some((m) => m.role === 'user' && text(m).includes('[tool report')), JSON.stringify(messages));
    assert.ok(messages.some((m) => m.role === 'tool' && text(m).includes('Progress: Working')), JSON.stringify(messages));
  } finally { await kit.stop(); }
});

// O14h on the real pinned engine: `removeAccount` on an account agent clears it, deletes the agent with
// `deleteFiles: false`, removes its state dir itself, drops the entry and leaves the member ready. A file the
// engine lands after removal is swept on the next prepare. Synthetic sign-ins through the kit's own migration,
// the loopback model stub, never an account or the network.
test('removeAccount: no file of the removed agent remains', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-remove');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  const hex = 'eeeeee';
  const agent = `m1--${hex}`;
  const id = `openai.${hex}`;
  let kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    await kit.stop();
    await seed(kit, dir, 'm1');
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
    await kit.start();
    await useModelStub(kit, stub);
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member is signed in');
    await kit.call('agents.create', { name: agent, workspace: join(root, 'workspaces', 'm1') });
    await kit.stop();
    const legacyPath = join(dir, 'people', agent, 'auth.json');
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ 'openai-codex': { type: 'oauth', provider: 'openai-codex',
      access: `a-${agent}`, refresh: `r-${agent}`, expires: Date.now() + 30 * 86_400_000, accountId: `acct-${hex}` } }));
    assert.equal(await kit.migrateRetainedLogin(agent, { path: legacyPath }), 'staged');
    kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
    await kit.start();
    const store = profilesOf(stateDir, agent);
    const profileId = Object.keys(store).find((key) => store[key].provider === 'openai');
    assert.ok(profileId, 'the account agent holds a sealed openai profile');
    const { hash } = await kit.call('config.get', {}) as { hash: string };
    await kit.call('config.patch', { baseHash: hash,
      raw: JSON.stringify({ agents: { entries: { [agent]: { model: { primary: `byokit-stub/test@${profileId}` } } } } }) });
    assert.deepEqual(await kit.callDynamic('byokit.accounts', { action: 'seal', agentId: agent, provider: 'openai' }) as object,
      { ok: true, who: identity('openai', `acct-${hex}`) });
    const index = join(root, 'accounts', 'm1.json');
    mkdirSync(join(index, '..'), { recursive: true });
    writeFileSync(index, JSON.stringify({ v: 1, accounts: {
      openai: { agent: 'm1', name: 'ChatGPT', route: 'openai', addedAt: 0 },
      [id]: { agent, name: 'Spare', route: 'openai', addedAt: 1 } }, defaults: {} }));
    chmodSync(index, 0o600);
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id).sort(), ['openai', id].sort());

    await kit.removeAccount('m1', id);
    assert.ok(!(await kit.call('agents.list', {}) as { agents: { id: string }[] }).agents.some((a) => a.id === agent),
      'the agent is gone');
    assert.ok(!(id in JSON.parse(readFileSync(index, 'utf8')).accounts), 'and its entry');
    assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'and its state dir');
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member agent stays ready');
    assert.equal((await kit.accounts('m1')).map((a) => a.id).join(), 'openai');

    // A file landed after removal is swept on the next prepare, leaving no file of the removed agent under <root>.
    const late = join(root, 'state', 'agents', agent, 'agent', 'late.json');
    mkdirSync(join(late, '..'), { recursive: true });
    writeFileSync(late, '{}');
    await kit.prepare();
    assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'the late file is swept on prepare');
  } finally { await kit.stop(); }
});

/** Decrypt every sealed credential payload under <root> (the snapshot plus each sealed object) and report
 *  whether any decoded content includes `marker`. */
const sealedHolds = (root: string, seal: ReturnType<typeof hostKeySeal>, marker: string): boolean => {
  const texts: string[] = [];
  const file = join(root, 'auth-store.sealed');
  if (existsSync(file)) {
    const saved = JSON.parse(seal.decryptString(readFileSync(file))) as { files?: [string, string][] };
    for (const [, data] of saved.files ?? []) texts.push(Buffer.from(data, 'base64').toString('utf8'));
  }
  const objects = join(root, 'auth-store.objects');
  if (existsSync(objects)) {
    for (const entry of readdirSync(objects)) {
      const payload = JSON.parse(seal.decryptString(readFileSync(join(objects, entry)))) as { data?: string };
      if (typeof payload.data === 'string') texts.push(Buffer.from(payload.data, 'base64').toString('utf8'));
    }
  }
  return texts.some((text) => text.includes(marker));
};

/** Whether any regular file under <root> holds `marker` as plaintext (sealed blobs cannot, so this covers
 *  the live tree beyond the removed agent's own dir). */
const plaintextUnder = (root: string, marker: string): boolean => {
  const walk = (dir: string): boolean => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (walk(path)) return true; continue; }
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      try { if (readFileSync(path).toString('utf8').includes(marker)) return true; } catch { /* a racing write */ }
    }
    return false;
  };
  return walk(root);
};

// O14h on the real pinned engine with a sealed credential store: `removeAccount` while the engine runs re-seals
// the live store at once, so `auth-store.sealed` and `auth-store.objects/` stop holding the removed profile
// immediately instead of keeping it until stop. Synthetic sign-ins through the kit's own migration, the loopback
// model stub, never an account or the network.
test('removeAccount with a seal: the sealed store is resealed at once, no file holds the removed profile', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-remove-sealed');
  const stateDir = join(dir, 'state');
  const root = join(stateDir, 'openclaw');
  const hex = 'ffffff';
  const agent = `m1--${hex}`;
  const id = `openai.${hex}`;
  const seal = hostKeySeal({ key: new Uint8Array(32).fill(7) });
  const kits = () => new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0, authSeal: seal });
  let kit = kits();
  try {
    await kit.start();
    await kit.ensureMember('m1');
    await kit.stop();
    await seed(kit, dir, 'm1');
    kit = kits();
    await kit.start();
    await useModelStub(kit, stub);
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member is signed in');
    await kit.call('agents.create', { name: agent, workspace: join(root, 'workspaces', 'm1') });
    await kit.stop();
    const legacyPath = join(dir, 'people', agent, 'auth.json');
    mkdirSync(join(legacyPath, '..'), { recursive: true });
    writeFileSync(legacyPath, JSON.stringify({ 'openai-codex': { type: 'oauth', provider: 'openai-codex',
      access: `a-${agent}`, refresh: `r-${agent}`, expires: Date.now() + 30 * 86_400_000, accountId: `acct-${hex}` } }));
    assert.equal(await kit.migrateRetainedLogin(agent, { path: legacyPath }), 'staged');
    kit = kits();
    await kit.start();
    const store = profilesOf(stateDir, agent);
    const profileId = Object.keys(store).find((key) => store[key].provider === 'openai');
    assert.ok(profileId, 'the account agent holds a sealed openai profile');
    const { hash } = await kit.call('config.get', {}) as { hash: string };
    await kit.call('config.patch', { baseHash: hash,
      raw: JSON.stringify({ agents: { entries: { [agent]: { model: { primary: `byokit-stub/test@${profileId}` } } } } }) });
    assert.deepEqual(await kit.callDynamic('byokit.accounts', { action: 'seal', agentId: agent, provider: 'openai' }) as object,
      { ok: true, who: identity('openai', `acct-${hex}`) });
    const index = join(root, 'accounts', 'm1.json');
    mkdirSync(join(index, '..'), { recursive: true });
    writeFileSync(index, JSON.stringify({ v: 1, accounts: {
      openai: { agent: 'm1', name: 'ChatGPT', route: 'openai', addedAt: 0 },
      [id]: { agent, name: 'Spare', route: 'openai', addedAt: 1 } }, defaults: {} }));
    chmodSync(index, 0o600);

    // Retain the native store bytes as a refresh already in flight when removal starts.
    const dbPath = join(root, 'state', 'agents', agent, 'agent', 'openclaw-agent.sqlite');
    const db = new DatabaseSync(dbPath);
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
    const lateStore = readFileSync(dbPath);
    const lateProfile = JSON.stringify({ profiles: profilesOf(stateDir, agent) });
    const removedPath = `state/agents/${agent}`;
    const belongsToRemoved = (path: string) => path === removedPath || path.startsWith(`${removedPath}/`);
    const snapshotFile = join(root, 'auth-store.sealed');
    const oldSnapshot = JSON.parse(seal.decryptString(readFileSync(snapshotFile))) as { dirs: string[]; files: [string, string][] };
    const objectsDir = join(root, 'auth-store.objects');
    const oldObjects = readdirSync(objectsDir).map((name) => [name, readFileSync(join(objectsDir, name))] as const)
      .filter(([, bytes]) => belongsToRemoved(JSON.parse(seal.decryptString(bytes)).path));
    await kit.removeAccount('m1', id);
    assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'its state dir is gone');
    assert.ok(existsSync(join(root, 'auth-store.sealed')), 'the sealed store exists while running');
    // The removed profile is identified by its account id: the profile id itself stays behind legitimately in the
    // agent's former model pin in openclaw.json, so it cannot serve as the marker.
    assert.ok(!sealedHolds(root, seal, `acct-${hex}`), 'the sealed store no longer holds the removed account id');
    assert.ok(!plaintextUnder(root, `acct-${hex}`), 'no live file under root holds it either');
    await kit.prepare();
    assert.ok(!sealedHolds(root, seal, `acct-${hex}`), 'still gone after prepare');
    assert.ok(!plaintextUnder(root, `acct-${hex}`), 'still gone after prepare');
    assert.ok((await kit.providers('m1')).includes('openai'), 'the member agent stays ready');

    // The in-flight refresh lands after the removal's reseal. Cover both the credential blob and native object.
    mkdirSync(join(dbPath, '..'), { recursive: true });
    writeFileSync(dbPath, lateStore);
    writeFileSync(join(dbPath, '..', 'auth-profiles.json'), lateProfile);
    assert.ok(plaintextUnder(root, `acct-${hex}`), 'the late refresh really landed');
    await kit.stop();
    assert.ok(!sealedHolds(root, seal, `acct-${hex}`), 'stop never seals a removed account refresh');
    // Replay only removed-agent residue from an older kit. Keep the current shared SQLite/WAL set consistent.
    const saved = JSON.parse(seal.decryptString(readFileSync(snapshotFile))) as { dirs: string[]; files: [string, string][] };
    saved.dirs.push(...oldSnapshot.dirs.filter(belongsToRemoved));
    saved.files.push(...oldSnapshot.files.filter(([path]) => belongsToRemoved(path)));
    writeFileSync(snapshotFile, seal.encryptString(JSON.stringify(saved)));
    for (const [name, bytes] of oldObjects) writeFileSync(join(objectsDir, name), bytes);
    assert.ok(sealedHolds(root, seal, `acct-${hex}`), 'the old sealed store really contains the removed account');
    kit = kits();
    await kit.prepare();
    assert.ok(!sealedHolds(root, seal, `acct-${hex}`), 'no sealed file holds it after the next prepare');
    assert.ok(!plaintextUnder(root, `acct-${hex}`), 'no plaintext file holds it after the next prepare');
    await kit.start();
    assert.ok(!existsSync(join(root, 'state', 'agents', agent)), 'restart cannot restore the removed agent');
    assert.ok((await kit.providers('m1')).includes('openai'), 'restart keeps the member sign-in');
  } finally { await kit.stop(); }
});

// The workspace rule on the real pinned engine: the Go gateway refuses a multi-workspace login until its
// workspace is named; `addKey` lists the key's workspaces when the app names none, and the workspace rides the
// activation probe and the first chat.
test('addKey: a Go plan key with its workspace is probed and chats with x-opencode-org-id; without it the gateway refuses', { timeout: 900_000 }, async () => {
  const dir = scratchDir('o14-go-workspace-header');
  const stateDir = join(dir, 'state');
  // A Go gateway that refuses every Go-route request unless it names org_WORKING2, on the loopback only.
  const goStub = await startModelStub([], { goWorkspace: 'org_WORKING2' });
  const key = 'byokit-go-stand-in-key-7781';
  const preload = join(dir, 'go-workspace-fake.mjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(preload, `
import { mock } from 'node:test';
const fetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://opencode.ai') {
    const base = new URL(${JSON.stringify(goStub.url)});
    url.protocol = base.protocol; url.host = base.host;
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return fetch(input, options);
});
`, { mode: 0o600 });
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [file, argv, options] = args;
    if (file === process.execPath && Array.isArray(argv) && argv[1] === 'gateway')
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  const kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0 });
  try {
    await kit.start();
    const go = (from: number, bearer: string) => goStub.calls.slice(from).filter((c) => c.authorization === `Bearer ${bearer}` && c.path.startsWith('/zen/go/'));
    // A login acting for several workspaces comes back for the pick, before the engine sees the key.
    const several = [{ id: 'org_WORKING2', name: 'Umer' }, { id: 'org_OTHER', name: 'Umer at work' }];
    orgs.answer(async () => Response.json(several));
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key }),
      { status: 'needs_workspace', workspaces: several });
    assert.equal(go(0, key).length, 0, 'nothing reached the gateway');
    // Without the workspace (a key the console refuses lists none) the probe is refused and nothing is kept.
    orgs.answer(async () => new Response('', { status: 401 }));
    const refused = await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key });
    assert.ok(refused.status !== 'ok', JSON.stringify(refused));
    const refusedCalls = go(0, key);
    assert.ok(refusedCalls.length, 'the probe reached the gateway');
    assert.ok(refusedCalls.every((c) => c.org === undefined), JSON.stringify(refusedCalls.map((c) => c.org)));
    assert.deepEqual(await kit.callDynamic('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
    // A key with one workspace is accepted with it unasked, and the first chat runs on it, header on every call.
    orgs.answer(async () => Response.json([{ id: 'org_WORKING2', name: 'Umer' }]));
    const start = goStub.calls.length;
    const accepted = await kit.addKey('m2', { authChoice: 'opencode-go', apiKey: key });
    assert.deepEqual(accepted, { status: 'ok' });
    const probe = go(start, key);
    assert.ok(probe.length && probe.every((c) => c.org === 'org_WORKING2' && c.session), `probe: ${JSON.stringify(probe.map((c) => [c.org, !!c.session]))}`);
    const before = goStub.calls.length;
    const texts: string[] = [];
    const end = await kit.run({ member: 'm2', auth: 'apiKey', sessionKey: 'agent:m2:o14:go-ws', message: 'hello go' }, (e) => { if (e.type === 'text') texts.push(e.text); });
    assert.ok(end.ok, JSON.stringify(end));
    assert.ok(texts.length && end.usage?.total, 'streamed with usage');
    const calls = go(before, key);
    assert.ok(calls.length && calls.every((c) => c.org === 'org_WORKING2' && c.body.model === 'deepseek-v4-pro' && c.session),
      JSON.stringify(calls.map((c) => [c.org, c.body.model, !!c.session])));
    assert.ok(!JSON.stringify([end, texts]).includes(key), 'the key is never shown');
  } finally { orgs.answer(async () => new Response('', { status: 401 })); await kit.stop(); await goStub.close(); mock.restoreAll(); syncBuiltinESMExports(); }
});

// The pinned engine planned an OpenRouter key's live test on `openrouter/auto` while staging the route the provider
// normalizes it to, and refused every OpenRouter key as unavailable before sending it (the kit read not_included).
test('addKey: an OpenRouter key under Crewhouse\'s browser choice is activated, and a run on the chosen model answers on it', { timeout: 900_000 }, async () => {
  const dir = scratchDir('openrouter-key');
  const stateDir = join(dir, 'state');
  const key = 'byokit-openrouter-stand-in-key-4417';
  // An account at zero credits: OpenRouter answers its key 402, which is billing, never a plan refusal.
  const broke = 'byokit-openrouter-no-credits-key-5528';
  const credits = createServer((_req, res) => res.writeHead(402, { 'content-type': 'application/json' })
    .end(JSON.stringify({ error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits' } })));
  await new Promise<void>((resolve) => credits.listen(0, '127.0.0.1', resolve));
  const creditsUrl = `http://127.0.0.1:${(credits.address() as AddressInfo).port}`;
  // The provider's live list (the maker's ids, the maker's slash, a Google preview pair).
  const live = [
    { id: 'openrouter/auto', name: 'OpenRouter Auto', context_length: 200000, pricing: { prompt: '0', completion: '0' },
      supported_parameters: [], architecture: { modality: 'text->text', input_modalities: ['text'] } },
    { id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', context_length: 163840,
      pricing: { prompt: '0.0000001', completion: '0.0000004' }, supported_parameters: ['reasoning'],
      architecture: { modality: 'text->text', input_modalities: ['text'] } },
    { id: 'minimax/minimax-m3.1-flash', name: 'MiniMax: MiniMax M3.1 Flash', context_length: 196608,
      pricing: { prompt: '0.0000004', completion: '0.0000016' }, supported_parameters: ['reasoning'],
      architecture: { modality: 'text->text', input_modalities: ['text'] } },
    { id: 'minimax/minimax-m3.1-flash:free', name: 'MiniMax: MiniMax M3.1 Flash (free)', context_length: 196608,
      pricing: { prompt: '0', completion: '0' }, supported_parameters: ['reasoning'],
      architecture: { modality: 'text->text', input_modalities: ['text'] } },
    { id: 'google/gemini-3.1-flash-lite', name: 'Google: Gemini 3.1 Flash Lite', context_length: 1048576,
      pricing: { prompt: '0.00000025', completion: '0.0000015' }, supported_parameters: ['reasoning'],
      architecture: { modality: 'text->text', input_modalities: ['text'] } },
    { id: 'google/gemini-3.1-flash-lite-preview', name: 'Google: Gemini 3.1 Flash Lite Preview', context_length: 1048576,
      pricing: { prompt: '0.00000025', completion: '0.0000015' }, supported_parameters: ['reasoning'],
      architecture: { modality: 'text->text', input_modalities: ['text'] } },
  ];
  const catalog = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: live })));
  await new Promise<void>((resolve) => catalog.listen(0, '127.0.0.1', resolve));
  const catalogUrl = `http://127.0.0.1:${(catalog.address() as AddressInfo).port}`;
  const preload = join(dir, 'openrouter-fake.mjs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(preload, `
import { mock } from 'node:test';
const fetch = globalThis.fetch;
mock.method(globalThis, 'fetch', (input, options) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin === 'https://openrouter.ai') {
    const bearer = new Headers(input instanceof Request ? input.headers : options?.headers).get('authorization');
    const base = new URL(url.pathname.startsWith('/api/v1/models') ? ${JSON.stringify(catalogUrl)}
      : bearer === ${JSON.stringify(`Bearer ${broke}`)} ? ${JSON.stringify(creditsUrl)} : ${JSON.stringify(stub.url)});
    url.protocol = base.protocol; url.host = base.host;
    input = input instanceof Request ? new Request(url, input) : url;
  }
  return fetch(input, options);
});
`, { mode: 0o600 });
  const spawn = childProcess.spawn;
  mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [file, argv, options] = args;
    if (file === process.execPath && Array.isArray(argv) && argv[1] === 'gateway')
      return spawn(file, ['--import', pathToFileURL(preload).href, ...argv], options);
    return spawn(...args);
  });
  syncBuiltinESMExports();
  const kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), callbackPort: 0, offered: ['openrouter'] });
  try {
    await kit.start();
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openrouter-oauth', apiKey: broke }), { status: 'invalid', reason: 'billing' });
    assert.deepEqual(await kit.callDynamic('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
    const keyed = (from: number) => stub.calls.slice(from).filter((c) => c.authorization === `Bearer ${key}`);
    const start = stub.calls.length;
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openrouter-oauth', apiKey: key }), { status: 'ok' });
    assert.ok(keyed(start).length, 'the live test reached OpenRouter with the key');
    const before = stub.calls.length;
    const end = await kit.run({ member: 'm1', auth: 'apiKey', sessionKey: 'agent:m1:openrouter', model: 'openrouter/deepseek/deepseek-v4.1-flash-1017', message: 'hello openrouter' });
    assert.ok(end.ok, JSON.stringify(end));
    const calls = keyed(before);
    assert.ok(calls.length && calls.every((c) => c.body.model === 'deepseek/deepseek-v4.1-flash-1017'), JSON.stringify(calls.map((c) => c.body.model)));
    assert.ok(!JSON.stringify(end).includes(key), 'the key is never shown');
    // The member picks a model and the app signs in with it: the add registers the provider's live list, so the
    // chosen model id sits beside `openrouter/auto` and the member keeps every model the vendor lists to pick from
    // (the engine's catalog stops at a registered list).
    const flashModel = 'openrouter/minimax/minimax-m3.1-flash';
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'openrouter-api-key', apiKey: key, model: flashModel }), { status: 'ok' });
    const { config } = await kit.call('config.get', {}) as { config: { models?: { providers?: Record<string,
      { models?: { id: string }[] }> } } };
    const registered = config.models?.providers?.openrouter?.models?.map((m) => m.id) ?? [];
    assert.ok(registered.includes('openrouter/auto') && registered.includes('deepseek/deepseek-v4.1-flash-1017')
      && registered.includes('minimax/minimax-m3.1-flash') && registered.includes('minimax/minimax-m3.1-flash:free'),
    `the whole live list is registered: ${JSON.stringify(registered)}`);
    assert.ok(!registered.includes('google/gemini-3.1-flash-lite-preview'), 'the preview pair is one row');
    // The key lane lists them: the member can pick the MiniMax model and its free variant.
    const lane = (await kit.models('m1', 'openrouter.key')).map((m) => m.id);
    assert.ok(lane.includes('openrouter/minimax/minimax-m3.1-flash')
      && lane.includes('openrouter/minimax/minimax-m3.1-flash:free') && lane.includes('openrouter/auto'),
    `the lane lists the live models: ${JSON.stringify(lane)}`);
    // A run on the MiniMax model the member picked answers on it.
    const beforeFlash = stub.calls.length;
    const flash = await kit.run({ member: 'm1', auth: 'apiKey', sessionKey: 'agent:m1:minimax',
      model: flashModel, message: 'hello minimax' });
    assert.ok(flash.ok, JSON.stringify(flash));
    assert.ok(keyed(beforeFlash).length && keyed(beforeFlash).every((c) => c.body.model === 'minimax/minimax-m3.1-flash'),
      JSON.stringify(keyed(beforeFlash).map((c) => c.body.model)));
  } finally { await kit.stop(); credits.close(); catalog.close(); mock.restoreAll(); syncBuiltinESMExports(); }
});
