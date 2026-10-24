// K3, credentialPolicy 'in-place' (docs/runtime-kits.md 5.15): a fake-gateway journey through the built kit. Two ChatGPT
// sign-ins land on their own final stores; a repeated principal answers duplicate; a re-sign-in as another principal
// marks the account needs_again / identity_mismatch; overlapping sign-ins answer busy; cancel and restart leave A as it
// was. The gateway wrapper records every request, so "no credential moved or copied" is asserted on the engine's store
// (profiles per agent) and on the absence of any `adopt`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { SignInView } from '../src/types.ts';

const POLICY = { authChoice: 'openai', via: 'browser', credentialPolicy: 'in-place' } as const;

test('in-place add: distinct stores, duplicate, wrong principal on re-auth, busy, cancel and restart; nothing moved', async () => {
  const stateDir = scratchDir('k3-in-place');
  const fake = fakeGateway();
  const actions: string[] = [];
  const recording: typeof fake.factory = (ctx) => {
    const transport = fake.factory(ctx);
    return { ...transport, request: (method, params, o) => {
      if (method === 'byokit.accounts') actions.push(String((params as { action?: string }).action));
      return transport.request(method, params, o);
    } };
  };
  const make = () => new OpenClawKit({ stateDir, transport: recording, spawnEngine: false, callbackPort: 0 });
  let kit = make();
  const index = () => JSON.parse(readFileSync(join(stateDir, 'openclaw', 'accounts', 'm1.json'), 'utf8')) as
    { accounts: Record<string, { agent: string; who?: string; unavailable?: string }> };
  const store = async (id: string) => (await kit.callDynamic('byokit.accounts', { action: 'list', agentId: index().accounts[id]!.agent })) as
    { ok: boolean; profiles: { provider: string; profileId: string; who?: string; status: string }[] };
  const add = async (fields: { again?: string } = {}) => {
    const seen: SignInView[] = [];
    const handle = await kit.addAccount('m1', { ...POLICY, ...fields }, (v) => seen.push(v));
    return { handle, done: handle.done, seen };
  };
  const roster = async () => (await kit.call('agents.list', {})).agents.map((a) => a.id).sort();
  const rows = async () => (await kit.accounts('m1')).map((a) => [a.id, a.state]);
  try {
    await kit.start();

    // Two sign-ins, two final stores: neither lands on the member agent, each holds its own principal only.
    fake.signInAs({ accountId: 'k3-acct-a' });
    const a = await (await add()).done;
    assert.deepEqual(a.view, { state: 'done', via: 'browser' });
    assert.match(a.id, /^openai\.[0-9a-f]{6}$/);
    fake.signInAs({ accountId: 'k3-acct-b' });
    const b = await (await add()).done;
    assert.equal(b.view.state, 'done');
    assert.notEqual(b.id, a.id);
    assert.deepEqual(await rows(), [[a.id, 'ready'], [b.id, 'ready']]);
    assert.ok(!('openai' in index().accounts), 'the member agent holds no sign-in');
    const aStore = await store(a.id);
    const bStore = await store(b.id);
    assert.equal(aStore.profiles.length, 1);
    assert.equal(bStore.profiles.length, 1);
    assert.notEqual(aStore.profiles[0]!.who, bStore.profiles[0]!.who);
    const before = JSON.stringify(index().accounts);

    // Duplicate principal: structured result, the earlier account untouched, the provisional store gone.
    const agentsBefore = await roster();
    fake.signInAs({ accountId: 'k3-acct-a', expires: Date.now() + 90 * 86_400_000 });
    const dup = await (await add()).done;
    assert.equal(dup.view.state, 'failed');
    assert.equal(dup.view.why, 'duplicate');
    assert.equal(dup.view.existing, a.id);
    assert.deepEqual(await store(a.id), aStore, 'A is unchanged by the failed add');
    assert.deepEqual(await store(b.id), bStore);
    assert.equal(JSON.stringify(index().accounts), before, 'no entry added, renamed or rebound');
    assert.deepEqual(await roster(), agentsBefore, 'the provisional agent is gone');
    assert.deepEqual(await rows(), [[a.id, 'ready'], [b.id, 'ready']]);

    // No principal (a key-like sign-in) is never proven the same: it adds, twice.
    fake.signInAs({ accountId: undefined });
    const n1 = await (await add()).done;
    const n2 = await (await add()).done;
    assert.deepEqual([n1.view.state, n2.view.state, n1.id !== n2.id], ['done', 'done', true]);
    for (const id of [n1.id, n2.id]) { await kit.removeAccount('m1', id); }

    // Two overlapping sign-ins: the second answers busy at once, the first completes as itself.
    fake.signInAs({ accountId: 'k3-acct-c' });
    const first = await add();
    const second = await add();
    assert.equal((await second.done).view.why, 'busy');
    assert.equal(second.seen.at(-1)?.why, 'busy');
    const c = await first.done;
    assert.equal(c.view.state, 'done');
    assert.equal(index().accounts[c.id]!.who !== undefined, true);
    await kit.removeAccount('m1', c.id);

    // Cancel before commit leaves nothing; cancel after commit changes nothing.
    fake.signInAs({ accountId: 'k3-acct-d' });
    const early = await add();
    early.handle.cancel();
    const cancelled = await early.done;
    assert.equal(cancelled.view.why, 'declined');
    assert.equal(JSON.stringify(index().accounts), before);
    assert.deepEqual(await roster(), agentsBefore);
    const late = await add();
    const committed = await late.done;
    assert.equal(committed.view.state, 'done');
    late.handle.cancel();
    assert.ok((await rows()).some(([id, state]) => id === committed.id && state === 'ready'), 'the committed account stays');
    await kit.removeAccount('m1', committed.id);
    assert.equal(JSON.stringify(index().accounts), before);

    // Wrong principal on re-auth: A is unavailable under the recorded principal, B untouched, config references kept.
    fake.signInAs({ accountId: 'k3-acct-x' });
    const wrong = await (await add({ again: a.id })).done;
    assert.equal(wrong.id, a.id);
    assert.equal(wrong.view.state, 'failed');
    assert.equal(wrong.view.why, 'identity_mismatch');
    assert.equal(index().accounts[a.id]!.who, JSON.parse(before)[a.id].who, 'the recorded principal stays');
    assert.equal(index().accounts[a.id]!.agent, JSON.parse(before)[a.id].agent, 'the config reference stays');
    assert.deepEqual(await rows(), [[a.id, 'needs_again'], [b.id, 'ready']]);
    assert.equal((await kit.accounts('m1')).find((r) => r.id === a.id)!.unavailable, 'identity_mismatch');
    assert.deepEqual(await store(b.id), bStore);

    // Restart: the mark survives, and the unavailable account is not runnable.
    await kit.stop();
    kit = make();
    await kit.start();
    assert.deepEqual(await rows(), [[a.id, 'needs_again'], [b.id, 'ready']]);

    // Signing in as the recorded principal clears it, on the same store and id.
    fake.signInAs({ accountId: 'k3-acct-a' });
    const right = await (await add({ again: a.id })).done;
    assert.deepEqual([right.view.state, right.id], ['done', a.id]);
    assert.deepEqual(await rows(), [[a.id, 'ready'], [b.id, 'ready']]);
    assert.equal(index().accounts[a.id]!.unavailable, undefined);
    assert.equal(index().accounts[a.id]!.agent, JSON.parse(before)[a.id].agent);

    // accountContext: the row and its engine agent, nothing that names a credential; unknown ids are refused.
    const context = await kit.accountContext('m1', b.id);
    assert.deepEqual(Object.keys(context).sort(), ['account', 'agentId']);
    assert.equal(context.agentId, index().accounts[b.id]!.agent);
    assert.equal(context.account.origin, 'managed');
    assert.deepEqual(context.account.capabilities, ['rename', 'remove', 'reauth']);
    await assert.rejects(kit.accountContext('m1', 'openai.000000'), /unknown account/);
    assert.ok(!JSON.stringify(context).match(/auth-profiles|accountId|k3-acct/), 'no credential path or identity');

    // The policy never asked the engine to move a sign-in.
    assert.ok(!actions.includes('adopt'), 'no adopt request');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
