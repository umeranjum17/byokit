// K3 acceptance (raw event tap): `kit.onEvent` delivers every event from the kit's own
// batch and status sockets — status changes, pane.moved with previous_pane_id, workspace.* —
// exactly once and without opening an extra socket (fake.subscriptionCount proves it), plus the
// status-watch ready signal. Against the kit fake; never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import type { HerdrEvent } from '../src/types.ts';

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() >= deadline) assert.fail(`not reached within ${ms}ms: ${what}`);
    await settle(10);
  }
}

test('K3: setStatus reaches onEvent exactly once with no extra socket', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-event-tap') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    const before = fake.subscriptionCount();
    assert.ok(before >= 2, `the kit holds its batch + status sockets (saw ${before})`);

    const seen: HerdrEvent[] = [];
    const stopTap = kit.onEvent((e) => seen.push(e));
    assert.equal(fake.subscriptionCount(), before, 'onEvent opens no socket of its own');

    fake.setStatus('w1:p2', 'working');
    await until(() => seen.length >= 1, 2000, 'the status event on the tap');
    await settle(150);   // a doubled tap would deliver a second frame in this window
    // The tap carries the wire spelling intact; the fake emits the live underscore
    // spelling like the real server (schema/SOURCE.md).
    const statusFrames = seen.filter((e) => e.type === 'pane_agent_status_changed');
    assert.equal(statusFrames.length, 1, 'exactly one status frame for one setStatus');
    assert.equal((statusFrames[0] as Record<string, unknown>).pane_id, 'w1:p2');
    assert.equal((statusFrames[0] as Record<string, unknown>).agent_status, 'working');
    assert.equal(fake.subscriptionCount(), before, 'the status frame rode the kit status socket');

    stopTap();
    fake.setStatus('w1:p2', 'idle');
    await until(() => kit.snapshot().workspaces[0]?.tabs[0]?.panes[1]?.agent?.status === 'idle', 2000, 'the tree settles back to idle');
    await settle(100);
    assert.equal(seen.length, 1, 'unsubscribe stops the tap');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K3: the tap carries pane.moved.previous_pane_id and workspace.* payloads on arrival', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-event-tap-payloads') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    const seen: HerdrEvent[] = [];
    const stopTap = kit.onEvent((e) => seen.push(e));
    try {
      // Fires on arrival: the tap sees the refresh-triggering frame even before the
      // re-bootstrap snapshot lands — a post-refresh tap would delay or coalesce it.
      // Emit spellings stay dots (the fake accepts both); the tap sees the live
      // underscore wire spelling like the real server.
      fake.emit({ type: 'pane.moved', previous_pane_id: 'w1:p2', pane_id: 'w1:p9' });
      fake.emit({ type: 'workspace.created', workspace_id: 'w9', label: 'nine' });
      await until(() => seen.filter((e) => e.type === 'pane_moved').length >= 1 &&
        seen.filter((e) => e.type === 'workspace_created').length >= 1, 2000, 'both batch frames on the tap');
      const moved = seen.find((e) => e.type === 'pane_moved') as Record<string, unknown>;
      assert.equal(moved.previous_pane_id, 'w1:p2', 'the moved payload keeps its previous pane id');
      const created = seen.find((e) => e.type === 'workspace_created') as Record<string, unknown>;
      assert.equal(created.workspace_id, 'w9', 'the workspace payload arrives intact');
    } finally {
      stopTap();
    }
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K3: statusWatchReady resolves once the per-pane watch is listening', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-event-tap-ready') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    // After the ready signal the very next status change is already observable: no lost race.
    fake.setStatus('w1:p2', 'working');
    await until(() => kit.snapshot().workspaces[0]?.tabs[0]?.panes[1]?.agent?.status === 'working', 2000,
      'the status watch live after its ready signal');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});
