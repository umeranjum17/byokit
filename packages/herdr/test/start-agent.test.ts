// K7 acceptance (docs/runtime-kits.md 6.4): `startAgent` retries `agent_pane_busy` and
// `agent_pane_unavailable` inside a bounded 5 s budget, rolls the pane it created back with
// `pane.close` when `agent.start` fails, sends `focus: false` with the env on `worktree.create`,
// and takes an optional `worktree.branch` — all against the kit fake, never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import type { HerdrSnapshot, HerdrTransport } from '../src/types.ts';

const panesOf = (snapshot: HerdrSnapshot): string[] =>
  snapshot.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.id)));

const agentOf = (snapshot: HerdrSnapshot, paneId: string) => {
  for (const w of snapshot.workspaces) for (const t of w.tabs) for (const p of t.panes) {
    if (p.id === paneId) return p.agent;
  }
  return undefined;
};

async function until(count: () => number, want: number, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (count() === want) return;
    if (Date.now() >= deadline) assert.fail(`not reached within ${ms}ms: ${what} (have ${count()})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function withKit(run: (kit: HerdrKit, fake: FakeHerdr) => Promise<void>, name: string): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir(name) });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try { await kit.start(); await run(kit, fake); }
  finally { await kit.stop(); await fake.stop(); }
}

test('K7: busy-then-ok resolves and the agent starts', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k7-busy-ok'),
    agentStartFaults: [{ code: 'agent_pane_busy' }, { code: 'agent_pane_unavailable' }] });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try {
    await kit.start();
    const ref = await kit.startAgent({ kind: 'pi', cwd: '/tmp/k7', place: { workspace: 'new' } });
    assert.match(ref.paneId, /^w\d+:p\d+$/);
    assert.equal(typeof ref.name, 'string');
    const deadline = Date.now() + 3000;
    for (;;) {
      if (agentOf(kit.snapshot(), ref.paneId)?.status === 'idle') break;
      if (Date.now() >= deadline) assert.fail('the retried start never joined the snapshot');
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(fake.agentStartFaults.length, 0, 'both queued faults were consumed by retries');
  } finally {
    await kit.stop();
    await fake.stop();
  }
});

test('K7: a permanent busy failure rejects after the 5 s budget and leaves no extra pane', async () => {
  await withKit(async (kit, fake) => {
    const before = panesOf(kit.snapshot()).sort();
    fake.agentStartFaults.push(...Array.from({ length: 100 }, () => ({ code: 'agent_pane_busy' })));
    const started = Date.now();
    await assert.rejects(kit.startAgent({ kind: 'pi', cwd: '/tmp/k7', place: { workspace: 'new' } }),
      (e: { code?: string }) => e.code === 'agent_pane_busy');
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 4500, `the retry budget runs ~5 s before giving up (took ${elapsed}ms)`);
    assert.ok(elapsed < 20000, `the retry is bounded, never endless (took ${elapsed}ms)`);
    await until(() => panesOf(kit.snapshot()).length, before.length, 3000, 'the rolled-back pane is gone');
    assert.deepEqual(panesOf(kit.snapshot()).sort(), before, 'no extra pane survives the failed start');
  }, 'herdr-k7-busy-forever');
});

test('K7: a failed start rolls back a created split pane but never a caller-owned pane', async () => {
  await withKit(async (kit, fake) => {
    // A split the kit made: the start fails once (not retryable) and the fresh pane goes away.
    fake.agentStartFaults.push({ code: 'agent_failed', message: 'boom' });
    const before = panesOf(kit.snapshot()).sort();
    await assert.rejects(
      kit.startAgent({ kind: 'pi', cwd: '/tmp/k7', place: { split: 'w1:p1', direction: 'right' } }),
      /boom/);
    await until(() => panesOf(kit.snapshot()).length, before.length, 3000, 'the split pane is closed');
    assert.deepEqual(panesOf(kit.snapshot()).sort(), before);
    // A pane the caller owns: the same failure rejects but the pane stays put.
    fake.agentStartFaults.push({ code: 'agent_failed', message: 'boom' });
    await assert.rejects(kit.startAgent({ kind: 'pi', cwd: '/tmp/k7', place: { pane: 'w1:p1' } }), /boom/);
    assert.ok(panesOf(kit.snapshot()).includes('w1:p1'), 'the caller-owned pane is never rolled back');
    assert.equal(agentOf(kit.snapshot(), 'w1:p1'), undefined, 'no agent started on the failed pane');
  }, 'herdr-k7-rollback');
});

test('K7: the worktree pane receives the env, and the branch is optional', async () => {
  await withKit(async (kit) => {
    const ref = await kit.startAgent({ kind: 'pi', cwd: '/tmp/k7-wt', place: { workspace: 'new' },
      worktree: { branch: 'k7' }, env: { K7_ENV: 'yes' } });
    const pane = (await kit.call('pane.get', { pane_id: ref.paneId })) as
      { pane?: { cwd?: string; env?: Record<string, string>; workspace_id?: string } };
    assert.deepEqual(pane.pane?.env, { K7_ENV: 'yes' }, 'the worktree pane carries the start env');
    const ws = (await kit.call('workspace.get', { workspace_id: pane.pane?.workspace_id ?? '' })) as
      { workspace?: { worktree?: { checkout_path?: string; is_linked_worktree?: boolean } } };
    assert.equal(ws.workspace?.worktree?.is_linked_worktree, true);
    assert.equal(pane.pane?.cwd, ws.workspace?.worktree?.checkout_path);
    // No branch: the start still resolves into a linked checkout.
    const plain = await kit.startAgent({ kind: 'pi', cwd: '/tmp/k7-wt', place: { workspace: 'new' },
      worktree: {} });
    const plainPane = (await kit.call('pane.get', { pane_id: plain.paneId })) as
      { pane?: { workspace_id?: string } };
    const plainWs = (await kit.call('workspace.get', { workspace_id: plainPane.pane?.workspace_id ?? '' })) as
      { workspace?: { worktree?: { is_linked_worktree?: boolean } } };
    assert.equal(plainWs.workspace?.worktree?.is_linked_worktree, true, 'a branchless worktree still links');
  }, 'herdr-k7-worktree-env');
});

test('K7: worktree.create carries focus:false, the env and only a given branch/base', async () => {
  type Call = { method: string; params: Record<string, unknown>; timeoutMs?: number };
  const calls: Call[] = [];
  const transport: HerdrTransport = {
    call: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') {
        return { snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'x' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
          panes: [{ pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' }],
          agents: [],
        } };
      }
      // A server that leaves the new workspace empty: no root_pane, so the kit opens the first
      // tab in the checkout — the fallback must carry the env without stealing focus too.
      if (method === 'worktree.create') {
        return { workspace: { workspace_id: 'w7' }, worktree: { checkout_path: '/wt' } };
      }
      if (method === 'tab.create') return { tab: {}, root_pane: { pane_id: 'w7:p1' } };
      return { agent: {} };
    },
    subscribe: () => () => {},
    close: () => {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/not/used', transport });
  try {
    await kit.start();
    await kit.startAgent({ kind: 'pi', cwd: '/repo', place: { workspace: 'new' },
      worktree: { branch: 'k7', base: 'main' }, env: { K: 'v' } });
    assert.deepEqual(calls.find((c) => c.method === 'worktree.create')?.params,
      { cwd: '/repo', focus: false, env: { K: 'v' }, branch: 'k7', base: 'main' });
    assert.deepEqual(calls.find((c) => c.method === 'tab.create')?.params,
      { workspace_id: 'w7', cwd: '/wt', focus: false, env: { K: 'v' } });
    calls.length = 0;
    await kit.startAgent({ kind: 'pi', cwd: '/repo', place: { workspace: 'new' }, worktree: {} });
    const bare = calls.find((c) => c.method === 'worktree.create')?.params ?? {};
    assert.equal(bare.focus, false);
    assert.ok(!('branch' in bare), 'an absent branch is omitted, not sent null');
    assert.ok(!('base' in bare), 'an absent base is omitted, not sent null');
  } finally {
    await kit.stop();
  }
});
