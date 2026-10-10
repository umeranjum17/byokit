// O14a on the real pinned engine (5.15 Isolation, D9): a member runs only on its own sign-ins, sign-out removes only
// the agent's own profiles, and D9's member rule applies to new members only. Synthetic sign-ins, the loopback model
// stub, never an account or the network. Runs only in the engine job (npm run test:engine).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
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
