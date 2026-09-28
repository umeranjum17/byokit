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

test('a gone target maps to <kind>-unavailable', async () => {
  await withKit(async (kit) => {
    await assert.rejects(kit.closePane('w9:p9'), (e: { code?: string }) => e.code === 'pane-unavailable');
    await assert.rejects(kit.closeTab('w9:t9'), (e: { code?: string }) => e.code === 'tab-unavailable');
    await assert.rejects(kit.closeWorkspace('w9'), (e: { code?: string }) => e.code === 'workspace-unavailable');
  }, 'h5-close-gone');
});
