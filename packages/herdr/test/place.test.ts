// Agentless placement (docs/runtime-kits.md 6.4): `kit.place` resolves the same ladder
// `startAgent` uses — shell/application tab, shell split, new or labelled workspace — and starts
// no agent, answering the placed pane/tab/workspace ref. All against the kit fake, never a real
// Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { socketTransport } from '../src/socket.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import type { HerdrSnapshot } from '../src/types.ts';

const panesOf = (snapshot: HerdrSnapshot): string[] =>
  snapshot.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes.map((p) => p.id)));

async function withKit(run: (kit: HerdrKit, fake: FakeHerdr) => Promise<void>, name: string): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir(name) });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try { await kit.start(); await run(kit, fake); }
  finally { await kit.stop(); await fake.stop(); }
}

test('place opens a shell tab and starts no agent', async () => {
  await withKit(async (kit, fake) => {
    const before = panesOf(kit.snapshot());
    const ref = await kit.place({ cwd: '/tmp/place', place: { tab: 'new', workspaceId: 'w1', label: 'shells' } });
    assert.equal(ref.workspaceId, 'w1');
    const pane = fake.world.panes.find((p) => p.pane_id === ref.paneId);
    assert.equal(pane?.tab_id, ref.tabId, 'the ref names the pane\'s own tab');
    assert.equal(fake.world.tabs.find((t) => t.tab_id === ref.tabId)?.label, 'shells');
    assert.equal(fake.world.agents.some((a) => a.pane_id === ref.paneId), false, 'no agent on the placed pane');
    // An application tab is the same placement carrying the app's own shape (env, cwd).
    const app = await kit.place({ cwd: '/opt/app', env: { APP_ENV: 'yes' },
      place: { tab: 'new', workspaceId: 'w1' } });
    const appPane = fake.world.panes.find((p) => p.pane_id === app.paneId);
    assert.deepEqual(appPane?.env, { APP_ENV: 'yes' }, 'the placement env rides tab.create');
    assert.equal(fake.world.agents.some((a) => a.pane_id === app.paneId), false);
    await until(() => panesOf(kit.snapshot()).length, before.length + 2, 3000, 'both tabs land in the tree');
  }, 'herdr-place-tab');
});

test('place splits a shell pane and starts no agent', async () => {
  await withKit(async (kit, fake) => {
    const before = fake.world.panes.length;
    const ref = await kit.place({ place: { split: 'w1:p1', direction: 'down' } });
    const pane = fake.world.panes.find((p) => p.pane_id === ref.paneId);
    assert.ok(pane, 'the split pane exists');
    assert.equal(pane?.tab_id, ref.tabId);
    assert.equal(pane?.workspace_id, ref.workspaceId);
    assert.equal(ref.tabId, 'w1:t1');
    assert.equal(fake.world.agents.some((a) => a.pane_id === ref.paneId), false, 'no agent on the split');
    assert.equal(fake.world.panes.length, before + 1);
  }, 'herdr-place-split');
});

test('place resolves a labelled workspace like the label start does', async () => {
  await withKit(async (kit, fake) => {
    // No match: the workspace is created, no agent anywhere in it.
    const created = await kit.place({ cwd: '/tmp/place', place: { workspace: 'fresh-label' } });
    const workspace = fake.world.workspaces.find((w) => w.workspace_id === created.workspaceId);
    assert.equal(workspace?.label, 'fresh-label');
    assert.equal(fake.world.agents.some((a) => a.pane_id === created.paneId), false);
    // One match: the tab lands in the existing workspace, nothing new created.
    const workspaces = fake.world.workspaces.length;
    const reused = await kit.place({ cwd: '/tmp/place', place: { workspace: 'fresh-label' } });
    assert.equal(reused.workspaceId, created.workspaceId);
    assert.equal(fake.world.workspaces.length, workspaces, 'the label place reuses its workspace');
    // Two matches refuse and create nothing.
    await kit.call('workspace.create', { cwd: '/tmp/place', label: 'fresh-label' });
    await assert.rejects(kit.place({ place: { workspace: 'fresh-label' } }),
      (e: { code?: string }) => e.code === 'workspace-ambiguous');
  }, 'herdr-place-label');
});

test('place on a caller-owned pane answers its ids from pane.get', async () => {
  await withKit(async (kit, fake) => {
    const panes = fake.world.panes.length;
    const ref = await kit.place({ place: { pane: 'w1:p1' } });
    assert.deepEqual(ref, { paneId: 'w1:p1', tabId: 'w1:t1', workspaceId: 'w1' });
    assert.equal(fake.world.panes.length, panes, 'a pane place creates nothing');
    // An env on an existing pane has no create call to ride: refused, never dropped.
    await assert.rejects(kit.place({ env: { A: 'b' }, place: { pane: 'w1:p1' } }),
      (e: { code?: string }) => e.code === 'env_mismatch');
  }, 'herdr-place-pane');
});

test('place labels a created root tab and proves an overlay env in the pane', async () => {
  await withKit(async (kit, fake) => {
    // A fresh fake pane's shell starts with PATH and HOME, so HOME is the name to remove.
    const ref = await kit.place({ cwd: '/tmp/place', place: { workspace: 'Umer repo', label: 'shell' },
      env: { overlay: { BYOKIT_ACCOUNT: 'umer' }, unset: ['HOME'] } });
    assert.equal(fake.world.workspaces.find((w) => w.workspace_id === ref.workspaceId)?.label, 'Umer repo');
    assert.equal(fake.world.tabs.find((t) => t.tab_id === ref.tabId)?.label, 'shell', 'the root tab takes the label');
    const env = fake.world.panes.find((p) => p.pane_id === ref.paneId)?.env ?? {};
    assert.equal(env.BYOKIT_ACCOUNT, 'umer', 'the overlay value lands in the pane');
    assert.ok('PATH' in env && !('HOME' in env), 'the unset name is gone, the rest survives');
    assert.equal(fake.world.agents.some((a) => a.pane_id === ref.paneId), false, 'no agent on the placed pane');
    // A failed overlay check closes the workspace this place made.
    const workspaces = fake.world.workspaces.length;
    await assert.rejects(kit.place({ place: { workspace: 'new', label: 'bad' }, env: { overlay: { 'bad;name': 'x' } } }),
      (e: { code?: string }) => e.code === 'env_mismatch');
    assert.equal(fake.world.workspaces.length, workspaces, 'no workspace survives a failed overlay');
    // An overlay on a caller-owned pane has nothing to land on: refused.
    await assert.rejects(kit.place({ place: { pane: 'w1:p1' }, env: { overlay: { A: 'b' } } }),
      (e: { code?: string }) => e.code === 'env_mismatch');
  }, 'herdr-place-overlay');
});

test('place closes the workspace it made when the root tab rename fails', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-place-rename-fault') });
  const socket = socketTransport(fake.socketPath);
  const transport = { ...socket, call: (method: string, params: Record<string, unknown>, timeoutMs?: number) =>
    method === 'tab.rename' ? Promise.reject(Object.assign(new Error('herdr: rename_failed: no'), { code: 'rename_failed' }))
      : socket.call(method, params, timeoutMs) };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath, transport });
  try {
    await kit.start();
    const workspaces = fake.world.workspaces.map((w) => w.workspace_id);
    await assert.rejects(kit.place({ place: { workspace: 'Umer repo', label: 'shell' } }),
      (e: { code?: string }) => e.code === 'rename_failed');
    assert.deepEqual(fake.world.workspaces.map((w) => w.workspace_id), workspaces, 'no new workspace is left');
    assert.equal(fake.world.workspaces.some((w) => w.label === 'Umer repo'), false);
  } finally { await kit.stop(); await fake.stop(); }
});

async function until(count: () => number, want: number, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (count() === want) return;
    if (Date.now() >= deadline) assert.fail(`not reached within ${ms}ms: ${what} (have ${count()})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
