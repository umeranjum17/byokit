// H5 acceptance (docs/runtime-kits.md 11.2, behavior 6.4) for src/close.ts: each close guard refuses
// widening and maps not-found; the exact closes still go through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';

async function withKit(run: (kit: HerdrKit, fake: FakeHerdr) => Promise<void>, name: string): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir(name) });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try { await kit.start(); await run(kit, fake); }
  finally { await kit.stop(); await fake.stop(); }
}

test('close guards refuse widening and close exact', async () => {
  await withKit(async (kit) => {
    // A fresh workspace holds exactly one tab with exactly one pane: the widening cases.
    const made = (await kit.call('workspace.create', { cwd: '/tmp/h5-other' })) as { workspace?: { workspace_id?: string } };
    const w2 = made.workspace?.workspace_id;
    assert.equal(typeof w2, 'string');
    await assert.rejects(kit.closePane(`${w2}:p1`),
      (e: { code?: string }) => e.code === 'pane-close-would-widen', 'closing the last pane would close the tab');
    await assert.rejects(kit.closeTab(`${w2}:t1`),
      (e: { code?: string }) => e.code === 'tab-close-would-widen', 'closing the only tab would close the workspace');
    // worktree.create links a checkout into w1's group: the root now widens on close.
    await kit.startAgent({ kind: 'pi', cwd: '/tmp/h5', place: { workspace: 'new' }, worktree: { branch: 'h5' } });
    await assert.rejects(kit.closeWorkspace('w1'),
      (e: { code?: string }) => e.code === 'workspace-close-would-widen',
      'closing a worktree group parent would close the group');
    // The exact closes still go through.
    await kit.call('pane.split', { target_pane_id: `${w2}:p1`, direction: 'right' });
    await kit.closePane(`${w2}:p1`);
    await kit.call('tab.create', { workspace_id: w2, cwd: '/tmp/h5-other' });
    await kit.closeTab(`${w2}:t1`);
    await kit.closeWorkspace(w2!);
  }, 'h5-close');
});

test('a worktree-group root refusal names the group; a confirmed close sends close_group', async () => {
  await withKit(async (kit, fake) => {
    // worktree.create links a checkout into w1's group: the root refusal names the group.
    await kit.startAgent({ kind: 'pi', cwd: '/tmp/p7', place: { workspace: 'new' }, worktree: { branch: 'p7' } });
    const linked = fake.world.workspaces.find((w) => w.workspace_id !== 'w1')!.workspace_id;
    let refusal: Record<string, unknown> | undefined;
    try { await kit.closeWorkspace('w1'); } catch (e) {
      const { code, scope, id, label, size } = e as Record<string, unknown>;
      refusal = { code, scope, id, label, size };
    }
    assert.deepEqual(refusal, { code: 'workspace-close-would-widen', scope: 'worktreeGroup',
      id: 'w1', label: 'fake-herdr', size: 2 },
      'the refusal carries the repo name and member count, no tree read needed');
    // The server refuses a plain close on the group root; only close_group closes it.
    await assert.rejects(kit.call('workspace.close', { workspace_id: 'w1' }),
      (e: { code?: string }) => e.code === 'workspace_group_close_required');
    assert.ok(fake.world.workspaces.some((w) => w.workspace_id === 'w1'), 'nothing closed on refusal');
    // A stale confirmation refuses: the id is not the refused root.
    await assert.rejects(kit.closeWorkspace('w1', { confirmed: { scope: 'worktreeGroup', id: linked } }),
      (e: { code?: string }) => e.code === 'confirmed-scope-mismatch');
    assert.ok(fake.world.workspaces.some((w) => w.workspace_id === 'w1'), 'nothing closed on a stale confirm');
    // The confirmed close sends one grouped close: the whole group goes atomically.
    await kit.closeWorkspace('w1', { confirmed: { scope: 'worktreeGroup', id: 'w1' } });
    assert.equal(fake.world.workspaces.some((w) => w.workspace_id === 'w1'), false, 'the root is gone');
    assert.equal(fake.world.workspaces.some((w) => w.workspace_id === linked), false,
      'the linked member went with the one grouped close');
  }, 'h5-close-group');
});

test('closePlan answers the close sentence from live reads and fails like a socket read', async () => {
  await withKit(async (kit, fake) => {
    // worktree.create links a checkout into w1's group: w1 is the root of a two-member group.
    await kit.rename({ workspace: 'w1', label: 'Umer' });
    const linked = await kit.startAgent({ kind: 'pi', cwd: '/tmp/plan', place: { workspace: 'new' }, worktree: { branch: 'plan' } });
    assert.deepEqual(await kit.closePlan('w1:p1'),
      { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1', workspaceLabel: 'Umer', group: { label: 'fake-herdr', size: 2 } },
      'the root names its group as the would-widen refusal does: repo name plus member count');
    const member = await kit.closePlan(linked.paneId);
    assert.equal(member.group, undefined, 'a linked checkout closes alone: no group to name');
    // A pane that has gone answers pane-unavailable.
    await assert.rejects(kit.closePlan('w9:p9'), (e: { code?: string }) => e.code === 'pane-unavailable');
    // Herdr down: the kit's tree still answers, the live read rejects as any socket read does.
    await fake.stop();
    assert.ok(kit.snapshot().workspaces.some((w) => w.id === 'w1'), 'the in-memory tree never fails closed');
    await assert.rejects(kit.closePlan('w1:p1'),
      (e: Error & { code?: string }) => e.message === 'herdr: socket closed' && e.code === undefined,
      'an outage stays the retryable socket failure, never pane-unavailable');
  }, 'h5-close-plan');
});

test('a gone target maps to <kind>-unavailable', async () => {
  await withKit(async (kit) => {
    await assert.rejects(kit.closePane('w9:p9'), (e: { code?: string }) => e.code === 'pane-unavailable');
    await assert.rejects(kit.closeTab('w9:t9'), (e: { code?: string }) => e.code === 'tab-unavailable');
    await assert.rejects(kit.closeWorkspace('w9'), (e: { code?: string }) => e.code === 'workspace-unavailable');
  }, 'h5-close-gone');
});

test('a confirmed sole-pane close closes exactly its tab; a stale confirmation refuses', async () => {
  await withKit(async (kit, fake) => {
    // Refusal names the wider tab; echoing it back closes exactly that tab — and the exact
    // path's own workspace guard still applies, so the rollback ladder composes.
    const made = (await kit.call('workspace.create', { cwd: '/tmp/h5-confirm' })) as { workspace?: { workspace_id?: string } };
    const w2 = made.workspace?.workspace_id;
    assert.equal(typeof w2, 'string');
    await kit.call('tab.create', { workspace_id: w2, cwd: '/tmp/h5-confirm' });   // w2:t2 keeps the workspace alive
    await assert.rejects(kit.closePane(`${w2}:p1`),
      (e: { code?: string }) => e.code === 'pane-close-would-widen');
    await kit.closePane(`${w2}:p1`, { confirmed: { scope: 'tab', id: `${w2}:t1` } });
    assert.equal(fake.world.tabs.some((t) => t.tab_id === `${w2}:t1`), false, 'the confirmed tab is gone');
    assert.equal(fake.world.panes.some((p) => p.pane_id === `${w2}:p1`), false, 'the sole pane went with it');
    assert.equal(fake.world.tabs.some((t) => t.tab_id === `${w2}:t2`), true, 'the sibling tab survives');

    // Stale confirmation: after a split the pane is no longer the confirmed tab's sole pane.
    await kit.call('pane.split', { target_pane_id: `${w2}:p2`, direction: 'right' });
    await assert.rejects(kit.closePane(`${w2}:p2`, { confirmed: { scope: 'tab', id: `${w2}:t2` } }),
      (e: { code?: string }) => e.code === 'confirmed-scope-mismatch', 'a split pane must not take its sibling');
    assert.equal(fake.world.panes.some((p) => p.pane_id === `${w2}:p2`), true, 'nothing closed on a stale confirm');
    // A pane that moved (its tab is not the confirmed one) refuses the same way.
    await assert.rejects(kit.closePane(`${w2}:p2`, { confirmed: { scope: 'tab', id: 'w9:t9' } }),
      (e: { code?: string }) => e.code === 'confirmed-scope-mismatch');
    // A gone pane still maps to pane-unavailable, confirmed or not.
    await assert.rejects(kit.closePane('w9:p9', { confirmed: { scope: 'tab', id: 'w9:t9' } }),
      (e: { code?: string }) => e.code === 'pane-unavailable');

    // The confirmed close never widens past the confirmed scope: a sole tab of its own workspace
    // refuses as tab-close-would-widen naming that workspace; the plain exact close finishes.
    const fresh = (await kit.call('workspace.create', { cwd: '/tmp/h5-confirm2' })) as { workspace?: { workspace_id?: string } };
    const w3 = fresh.workspace?.workspace_id;
    await assert.rejects(kit.closePane(`${w3}:p1`, { confirmed: { scope: 'tab', id: `${w3}:t1` } }),
      (e: { code?: string; scope?: string; id?: string }) =>
        e.code === 'tab-close-would-widen' && e.scope === 'workspace' && e.id === w3);
    await kit.closeWorkspace(w3!);
  }, 'h5-close-confirm');
});
