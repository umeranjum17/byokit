// Awaited refresh and the tree mirror's dropped re-bootstrap (muxr asks A1/A2) plus the per-pane
// status watch a `pane.updated`-introduced agent needs (A3) — all against the kit fake, never a
// real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import type { HerdrEvent, HerdrSnapshot } from '../src/types.ts';

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail('condition not reached in time');
    await settle(10);
  }
}

function paneIds(snapshot: HerdrSnapshot): string[] {
  return snapshot.workspaces.flatMap((w) => w.tabs).flatMap((t) => t.panes).map((p) => p.id);
}

function paneOf(snapshot: HerdrSnapshot, paneId: string) {
  for (const w of snapshot.workspaces) for (const t of w.tabs) {
    const pane = t.panes.find((p) => p.id === paneId);
    if (pane !== undefined) return pane;
  }
  return undefined;
}

test('refresh() resolves with a tree that already carries a tab created just before it', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-refresh-tab') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    const before = kit.snapshot().workspaces[0].tabs.length;
    await kit.call('tab.create', { workspace_id: 'w1', label: 'second' });
    await kit.refresh();
    const tabs = kit.snapshot().workspaces[0].tabs;
    assert.equal(tabs.length, before + 1);
    assert.ok(tabs.some((t) => t.label === 'second'), 'the fresh tree carries the new tab');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a pane created while a bootstrap is in flight lands on the queued follow-up bootstrap', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-refresh-queued') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    assert.equal(fake.snapshotCount(), 1, 'start bootstrapped once');
    // Hold every subscribe ack so the next bootstrap parks before it lands, leaving it in flight.
    const release = fake.holdAck();
    fake.emit({ type: 'tab.renamed', tab_id: 'w1:t1', workspace_id: 'w1', label: 'main2' });
    await until(() => fake.snapshotCount() >= 2, 2000);
    // The pane is created after the in-flight bootstrap read its tree; its `pane.created` is a
    // structural event that must queue one follow-up bootstrap instead of being dropped.
    const created = await kit.call('pane.split', { target_pane_id: 'w1:p1', direction: 'down' }) as { pane: { pane_id: string } };
    const newPane = created.pane.pane_id;
    assert.equal(paneIds(kit.snapshot()).includes(newPane), false, 'the in-flight tree predates the pane');
    release();
    await until(() => paneIds(kit.snapshot()).includes(newPane));
    assert.ok(fake.snapshotCount() >= 3, 'the queued follow-up re-read the tree');
    assert.ok(paneIds(kit.snapshot()).includes(newPane), 'the new pane is in the tree with no later structural event');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('refresh() waiters that arrive mid-bootstrap resolve on the bootstrap that started after their call', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-refresh-waiters') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    const release = fake.holdAck();
    fake.emit({ type: 'tab.renamed', tab_id: 'w1:t1', workspace_id: 'w1', label: 'main2' });
    await until(() => fake.snapshotCount() >= 2, 2000);
    // Both callers land while the first re-bootstrap parks.
    const first = kit.refresh();
    const second = kit.refresh();
    let resolved = false;
    void first.then(() => { resolved = true; });
    await settle(50);
    assert.equal(resolved, false, 'a waiter during a bootstrap does not resolve early');
    release();
    await Promise.all([first, second]);
    assert.ok(fake.snapshotCount() >= 3, 'the waiters resolved after a later bootstrap read the tree');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('refresh() rejects with the bootstrap error when the tree read fails', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-refresh-fail') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    fake.failNextSnapshot('snapshot_failed', 'the snapshot read failed');
    await assert.rejects(kit.refresh(), (error: Error & { code?: string }) => {
      assert.equal(error.code, 'snapshot_failed');
      return true;
    });
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a pane.updated that introduces an agent opens a per-pane status watch', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-refresh-watch') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    assert.equal(fake.watching('w1:p1'), false, 'the plain shell has no watch after bootstrap');
    // A title tick on a plain shell carries no agent fields: it must not open a watch.
    fake.emit({ type: 'pane.updated', pane: {
      pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'zsh',
      terminal_title_stripped: 'zsh · title', focused: false, revision: 1, terminal_id: 'term-w1:p1',
    } });
    await settle(80);
    assert.equal(fake.watching('w1:p1'), false, 'a title-only update opens no watch');
    // The same pane gains a real agent: the kit opens its watch without waiting for a structural event.
    fake.emit({ type: 'pane.updated', pane: {
      pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'pi', agent: 'pi',
      agent_status: 'idle', focused: false, revision: 2, terminal_id: 'term-w1:p1',
    } });
    await until(() => fake.watching('w1:p1') === true);
    await kit.statusWatchReady();
    const before = paneOf(kit.snapshot(), 'w1:p1');
    assert.equal(before?.agent?.status, 'idle', 'the merged agent landed in the tree');
    // The newly opened watch delivers the agent's next status onto the tree.
    fake.emit({ type: 'pane_agent_status_changed', pane_id: 'w1:p1', agent_status: 'working', revision: 9 } as HerdrEvent);
    await until(() => paneOf(kit.snapshot(), 'w1:p1')?.agent?.status === 'working');
    const after = paneOf(kit.snapshot(), 'w1:p1');
    assert.equal(after?.agent?.status, 'working', 'the status change reached the tree');
    assert.equal(after?.agent?.revision, 9);
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});
