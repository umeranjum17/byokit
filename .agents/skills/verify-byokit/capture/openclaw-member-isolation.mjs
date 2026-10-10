// Member auth isolation (5.15, D9) through the built public `@byokit/openclaw` on the real pinned engine: synthetic
// retained sign-ins, the loopback model stub, never an account or a real provider.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
import { startModelStub, useModelStub } from '@byokit/openclaw/testing';

const root = process.argv[2];
const expectFixed = process.argv.includes('--expect-isolation');
// Without --expect-isolation every reading is printed and nothing asserted: the before on a pre-O14 build.
const check = expectFixed ? (fn) => fn() : () => {};
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'state-'));
const stateDir = join(dir, 'state');
const engineDir = join(root, 'engine');
const config = join(stateDir, 'openclaw', 'openclaw.json');
const stub = await startModelStub();
const kitFor = () => new OpenClawKit({ stateDir, engineDir });
const seed = async (kit, member) => {
  const legacy = join(dir, 'people', member, 'auth.json');
  mkdirSync(join(legacy, '..'), { recursive: true });
  writeFileSync(legacy, JSON.stringify({ 'openai-codex': { type: 'oauth', provider: 'openai-codex',
    access: `a-${member}`, refresh: `r-${member}`, expires: Date.now() + 30 * 86_400_000 } }));
  const staged = await kit.migrateRetainedLogin(member, { path: legacy });
  console.log(`seed ${member}:`, staged);
  check(() => assert.equal(staged, 'staged'));
};
const stored = (agent) => {
  const db = new DatabaseSync(join(stateDir, 'openclaw', 'state', 'agents', agent, 'agent', 'openclaw-agent.sqlite'), { readOnly: true });
  try { return db.prepare('SELECT store_json FROM auth_profile_store').get().store_json; } finally { db.close(); }
};
let kit = kitFor();
try {
  await kit.start();
  await kit.ensureMember('m1');
  await kit.ensureMember('m2');
  await kit.call('agents.create', { name: 'a--b', workspace: join(stateDir, 'openclaw', 'workspaces', 'a--b') });
  await kit.stop();
  await seed(kit, 'm1');
  // The pre-O14 state: the pin pinned the inherited owner to the first member when the second was created.
  const saved = JSON.parse(readFileSync(config, 'utf8'));
  saved.agents.defaults.authInheritance = { agentId: 'm1' };
  writeFileSync(config, JSON.stringify(saved, null, 2));

  kit = kitFor();
  await kit.start();
  await useModelStub(kit, stub);
  const inheritance = JSON.parse(readFileSync(config, 'utf8')).agents.defaults.authInheritance;
  console.log('authInheritance after boot:', JSON.stringify(inheritance));
  // The stub's config-level key (`byokit-stub`) is every agent's; a sign-in is a profile.
  const m1Before = await kit.providers('m1'), m2Before = await kit.providers('m2');
  console.log('providers m1:', JSON.stringify(m1Before), 'providers m2:', JSON.stringify(m2Before));
  const before = stub.calls.length;
  const pick = await kit.run({ member: 'm2', sessionKey: 'agent:m2:verify:pick', message: 'hello', model: 'openai/gpt-5.4' });
  console.log('explicit openai pick for m2:', JSON.stringify(pick), 'stub requests:', stub.calls.length - before);
  check(() => {
    assert.equal(inheritance.agentId, 'byokit-base');
    assert.ok(m1Before.includes('openai') && !m2Before.includes('openai'));
    assert.deepEqual(pick, { ok: false, kind: 'signed-out', message: 'openai is not signed in for m2' });
    assert.equal(stub.calls.length, before);
  });

  const legacy = await kit.run({ member: 'a--b', sessionKey: 'agent:a--b:verify:run', message: 'hello' });
  console.log('existing a--b member run:', JSON.stringify({ ok: legacy.ok }), 'stub requests:', stub.calls.length - before);
  check(() => assert.ok(legacy.ok));
  for (const id of ['c--d', 'byokit-base', 'main']) {
    const refused = await kit.ensureMember(id).then(() => 'created', (error) => error.message);
    console.log(`ensureMember(${id}):`, refused);
    check(() => assert.match(refused, /invalid member id/));
  }

  await kit.stop();
  await seed(kit, 'm2');
  kit = kitFor();
  await kit.start();
  console.log('providers m2 after its own sign-in:', JSON.stringify(await kit.providers('m2')));
  const m1Store = stored('m1');
  await kit.signOut('m2', 'openai');
  const m2After = await kit.providers('m2'), m1After = await kit.providers('m1'), kept = stored('m1') === m1Store;
  console.log('after signOut(m2, openai): providers m2', JSON.stringify(m2After), 'providers m1', JSON.stringify(m1After),
    'm1 store unchanged', kept);
  check(() => {
    assert.ok(!m2After.includes('openai'));
    assert.ok(kept);
    assert.ok(m1After.includes('openai'));
  });
  console.log(expectFixed ? 'MEMBER-ISOLATION OK' : 'BASELINE CAPTURED');
} finally {
  await kit.stop().catch(() => {});
  await stub.close();
  rmSync(dir, { recursive: true, force: true });
}
