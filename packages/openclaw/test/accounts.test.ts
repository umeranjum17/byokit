// The S5 account spine (docs/runtime-kits.md 5.15, O14 step S5): a fake-gateway journey through the built
// kit that signs in, lists, renames, calls setDefaults, restarts and lists again. Pass: expected rows, index
// mode 0600, clean canary scan.
// The S9 Auto input (O14i): models and room over the same journey, with the fake's cold usage cache (no usage
// on the first read). Pass: expected models and room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { OpenClawKit } from '../src/kit.ts';
import { createLocks } from '../src/locks.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';

const indexOf = (stateDir: string, member: string): string => join(stateDir, 'openclaw', 'accounts', `${member}.json`);

test('locks: shared overlaps, exclusive waits, live reports the hold', async () => {
  const locks = createLocks();
  assert.equal(locks.live('a1'), false);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const held = locks.shared('a1', async () => {
    assert.equal(locks.live('a1'), true);
    order.push('shared-in');
    await gate;
    order.push('shared-out');
    return 1;
  });
  const blocked = locks.exclusive(['a1'], async () => {
    order.push('exclusive');
    assert.equal(locks.live('a1'), true);
    return 2;
  });
  assert.equal(locks.live('a1'), true);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(order, ['shared-in']);
  release();
  assert.deepEqual([await held, await blocked], [1, 2]);
  assert.deepEqual(order, ['shared-in', 'shared-out', 'exclusive']);
  assert.equal(locks.live('a1'), false);
});

test('account index: sign in, list, rename, defaults, restart, list again', async () => {
  const stateDir = scratchDir('o14e-accounts');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    const handle = kit.signIn('m1', { authChoice: 'openai' }, () => {});
    assert.deepEqual(await handle.done, { state: 'done', via: 'browser' });

    // A pre-O14 sign-in with no index entry is synthesized on first list.
    const listed = await kit.accounts('m1');
    assert.deepEqual(listed, [{ id: 'openai', provider: 'openai', route: 'openai', name: 'ChatGPT Login 1',
      label: 'ChatGPT Login', billing: 'subscription', state: 'ready', addedAt: 0 }]);

    // An unindexed `<member>--<hex6>` agent is never listed.
    await kit.call('agents.create', { name: 'm1--abc123', workspace: join(stateDir, 'openclaw', 'workspaces', 'm1') });
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id), ['openai']);

    const renamed = await kit.renameAccount('m1', 'openai', 'Work');
    assert.equal(renamed.name, 'Work');
    assert.equal((await kit.accounts('m1'))[0]?.name, 'Work');

    assert.deepEqual(await kit.defaults('m1'), {});
    await kit.setDefaults('m1', { account: 'openai' });
    assert.deepEqual(await kit.defaults('m1'), { account: 'openai' });
    // A default naming a removed account is dropped on read.
    await kit.setDefaults('m1', { account: 'openai.dead01' });
    assert.deepEqual(await kit.defaults('m1'), {});
    await kit.setDefaults('m1', { account: 'openai' });
    await kit.stop();

    // Restart: the rename and the default survive, and the entry is still the synthesized one.
    const again = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
    try {
      await again.start();
      assert.deepEqual(await again.accounts('m1'), [{ id: 'openai', provider: 'openai', route: 'openai',
        name: 'Work', label: 'ChatGPT Login', billing: 'subscription', state: 'ready', addedAt: 0 }]);
      assert.deepEqual(await again.defaults('m1'), { account: 'openai' });
    } finally { await again.stop(); }

    // The index is mode 0600 and holds no email, token or engine line.
    const file = indexOf(stateDir, 'm1');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, 'utf8');
    const stored = JSON.parse(text) as { v: number; accounts: Record<string, Record<string, unknown>>; defaults: object };
    assert.equal(stored.v, 1);
    assert.deepEqual(Object.keys(stored.accounts), ['openai']);
    assert.ok(!('email' in stored.accounts.openai!));
    for (const canary of ['fake-access', 'fake-refresh', 'openai:default', '@', 'accountId', 'email', 'token', 'access', 'refresh'])
      assert.ok(!text.includes(canary), `index leaks ${canary}`);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('models and room: provider/model mapping, cold usage cache, skips, unknown cases', async () => {
  const stateDir = scratchDir('o14i-models-room');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, callbackPort: 0 });
  try {
    await kit.start();
    const handle = kit.signIn('m1', { authChoice: 'openai' }, () => {});
    assert.deepEqual(await handle.done, { state: 'done', via: 'browser' });
    assert.deepEqual((await kit.accounts('m1')).map((a) => a.id), ['openai']);

    // `models.list` rows of the account's provider map to `provider/model`; another provider is filtered out.
    const resetAt = 1_797_000_100_000;
    fake.handle('models.list', () => ({ models: [
      { id: 'gpt-5.1', name: 'GPT 5.1', provider: 'openai', available: true },
      { id: 'openai/gpt-5.1-mini', name: 'Mini', provider: 'openai', available: false, unavailableReason: 'missing-auth' },
      { id: 'oops', name: 'Oops', provider: 'openai', available: false, unavailableReason: 'auth-failed' },
      { id: 'paused', name: 'Paused', provider: 'openai', available: false, unavailableReason: 'cooldown', unavailableUntil: resetAt },
      { id: 'waiting', name: 'Waiting', provider: 'openai', available: false, unavailableReason: 'cooldown' },
      { id: 'claude-x', name: 'X', provider: 'anthropic', available: true },
    ] }));
    assert.deepEqual(await kit.models('m1', 'openai'), [
      { id: 'openai/gpt-5.1', name: 'GPT 5.1', available: true },
      { id: 'openai/gpt-5.1-mini', name: 'Mini', available: false, why: 'signed_out' },
      { id: 'openai/oops', name: 'Oops', available: false, why: 'signed_out' },
      { id: 'openai/paused', name: 'Paused', available: false, why: 'resting', until: resetAt },
      { id: 'openai/waiting', name: 'Waiting', available: false, why: 'resting' },
    ]);

    // Cold usage cache: the first `models.authStatus` read carries no usage, so room is unknown.
    fake.setUsage('m1', 'openai', [
      { label: 'weekly' },
      { label: 'session', usedPercent: 80, resetAt },
      { label: 'monthly', usedPercent: 30, resetAt: resetAt + 1_000_000 },
    ]);
    assert.deepEqual(await kit.room('m1', 'openai'), { left: 'unknown' });

    // Warm: the tightest applying window (session, 80% used) gives the room. The window without a numeric
    // `usedPercent` is skipped, never read as unused; the room never carries `at`.
    const room = await kit.room('m1', 'openai');
    assert.deepEqual(room, { left: 20, span: 'session', resetsAt: resetAt });
    assert.ok(!('at' in room), 'room carries at');
    // A demand answers the same: the pin's rows carry no model scope, so every window applies.
    assert.deepEqual(await kit.room('m1', 'openai', ['openai/gpt-5.1']), room);

    // The kit adds no cache: changed windows read live.
    fake.setUsage('m1', 'openai', [{ label: 'session', usedPercent: 10, resetAt }]);
    assert.deepEqual(await kit.room('m1', 'openai'), { left: 90, span: 'session', resetsAt: resetAt });

    // An API-key account's room is always unknown, with no read.
    const file = indexOf(stateDir, 'm1');
    const stored = JSON.parse(readFileSync(file, 'utf8')) as { v: number; accounts: Record<string, unknown>; defaults: object };
    stored.accounts.anthropic = { agent: 'm1', name: 'Key', route: 'apiKey', addedAt: 1 };
    writeFileSync(file, JSON.stringify(stored, null, 2) + '\n');
    chmodSync(file, 0o600);
    const keyRow = (await kit.accounts('m1')).find((a) => a.id === 'anthropic');
    assert.equal(keyRow?.billing, 'api');
    assert.deepEqual(await kit.room('m1', 'anthropic'), { left: 'unknown' });

    await assert.rejects(kit.models('m1', 'nope'), /unknown account: nope/);
    await assert.rejects(kit.room('m1', 'nope'), /unknown account: nope/);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
