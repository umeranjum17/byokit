// K2 acceptance: the snapshot carries the agent/pane/workspace fields muxr's mirror used to
// provide, `pane.updated` titles and labels merge with no re-bootstrap, and a status push that
// races a snapshot read is not lost (lifecycle-epoch guard) — all against the kit fake, never a
// real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { isPromptable } from '../src/agents.ts';
import { socketTransport } from '../src/socket.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import type { AgentStatus, HerdrEvent, HerdrSnapshot, HerdrSnapshotWorktree, HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(probe: () => T | undefined | null, ok: (value: T) => boolean, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && ok(value)) return value;
    if (Date.now() >= deadline) assert.fail(`condition not reached within ${ms}ms: ${JSON.stringify(value ?? null)}`);
    await settle(10);
  }
}

function paneOf(snapshot: HerdrSnapshot, paneId: string) {
  for (const w of snapshot.workspaces) for (const t of w.tabs) {
    const pane = t.panes.find((p) => p.id === paneId);
    if (pane !== undefined) return { workspace: w, pane };
  }
  return undefined;
}

test('K2: snapshot() carries the seeded agent, pane and workspace fields', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-fields') });
  // Seed tokens before the kit's bootstrap reads them.
  const seed = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  await seed.start();
  try {
    await seed.call('pane.report_metadata', { pane_id: 'w1:p2', source: 'byokit-k2', tokens: { k2: 'pane' } });
    await seed.call('workspace.report_metadata', { workspace_id: 'w1', source: 'byokit-k2', tokens: { k2: 'ws' } });
  } finally {
    await seed.stop().catch(() => {});
  }
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    const snapshot = kit.snapshot();
    assert.equal(snapshot.workspaces.length, 1);
    const w1 = snapshot.workspaces[0];
    assert.equal(w1.id, 'w1');
    assert.equal(w1.focused, true);
    assert.equal(w1.number, 1);
    assert.deepEqual(w1.tokens, { k2: 'ws' });
    assert.deepEqual(w1.worktree, {
      repoKey: 'fake-herdr', repoName: 'fake-herdr', repoRoot: fake.world.cwd,
      checkoutPath: fake.world.cwd, isLinkedWorktree: false,
    });

    const agent = paneOf(snapshot, 'w1:p2');
    assert.ok(agent !== undefined);
    assert.equal(agent.pane.label, 'pi');
    assert.equal(agent.pane.focused, false);
    assert.equal(agent.pane.terminalTitle, 'pi · pi');
    assert.deepEqual(agent.pane.tokens, { k2: 'pane' });
    assert.equal(agent.pane.agent?.kind, 'pi');
    assert.equal(agent.pane.agent?.displayAgent, 'pi');
    assert.equal(agent.pane.agent?.title, 'pi');
    assert.deepEqual(agent.pane.agent?.agentSession, { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'gen-w1:p2' });
    assert.equal(agent.pane.agent?.foregroundCwd, fake.world.cwd);
    assert.equal(agent.pane.agent?.status, 'idle');

    const shell = paneOf(snapshot, 'w1:p1');
    assert.ok(shell !== undefined);
    assert.equal(shell.pane.agent, undefined, 'the plain shell carries no agent');
    assert.equal(shell.pane.label, 'zsh');
    assert.equal(shell.pane.focused, true);
    assert.equal(shell.pane.terminalTitle, `zsh · ${fake.world.cwd}`);
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: a pane.updated title change appears in the next onChange with no extra session.snapshot', async () => {
  const fake: FakeHerdr = await startFakeHerdr({ dir: scratchDir('herdr-k2-updated') });
  const real = socketTransport(fake.socketPath);
  let snapshots = 0;
  const counting: HerdrTransport = {
    call: (method, params, timeoutMs) => {
      if (method === 'session.snapshot') snapshots += 1;
      return real.call(method, params, timeoutMs);
    },
    subscribe: (subs, on, onError) => real.subscribe(subs, on, onError),
    close: () => real.close(),
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport: counting });
  try {
    await kit.start();
    assert.equal(snapshots, 1, 'the bootstrap reads the snapshot once');
    const seen: HerdrSnapshot[] = [];
    const stop = kit.onChange((s) => seen.push(s));
    try {
      fake.emit({
        type: 'pane.updated',
        pane: {
          pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1',
          label: 'renamed', terminal_title_stripped: 'renamed title',
          title: 'Task One', display_agent: 'pi',
        },
      });
      const next = await until(() => seen.at(-1), (s) => paneOf(s, 'w1:p2')?.pane.label === 'renamed');
      const pane = paneOf(next, 'w1:p2')?.pane;
      assert.equal(pane?.terminalTitle, 'renamed title');
      assert.equal(pane?.agent?.title, 'Task One');
      assert.equal(pane?.agent?.displayAgent, 'pi');
      assert.equal(pane?.agent?.status, 'idle', 'the merge keeps the untouched status');
      assert.equal(snapshots, 1, 'no re-bootstrap: the merge lands without another session.snapshot');
    } finally {
      stop();
    }
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: a pane.updated title tick on a plain shell invents no agent and starts no status watch', async () => {
  const fake: FakeHerdr = await startFakeHerdr({ dir: scratchDir('herdr-agentless-shell') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    assert.equal(fake.watching('w1:p1'), false, 'the plain shell starts with no status watch');
    // Hold the next bootstrap's snapshot read so a title tick lands while booting: bootstrap replays
    // buffered events through update() right before it opens the status watches. A phantom agent here
    // would ride that replay into an unwanted status watch for the shell.
    const release = fake.holdSnapshot();
    fake.emit({ type: 'pane.created', pane: { pane_id: 'w1:p9', tab_id: 'w1:t1', workspace_id: 'w1' } });
    await until(() => fake.snapshotCount(), (n) => n >= 2);
    fake.emit({ type: 'pane.updated', pane: {
      pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1',
      label: 'zsh', terminal_title_stripped: 'zsh · renamed', agent_status: 'unknown',
    } });
    release();
    await kit.statusWatchReady();
    const shell = paneOf(kit.snapshot(), 'w1:p1');
    assert.ok(shell !== undefined);
    assert.equal(shell.pane.terminalTitle, 'zsh · renamed', 'the title tick landed');
    assert.equal(shell.pane.agent, undefined, 'a title tick never conjures an agent');
    assert.equal(fake.watching('w1:p1'), false, 'and opens no status watch for the shell');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: a shell pane with no agents record keeps agent_status, display_agent and foreground_cwd', async () => {
  const fake: FakeHerdr = await startFakeHerdr({ dir: scratchDir('herdr-agentless-fields') });
  const shell = fake.world.panes.find((p) => p.pane_id === 'w1:p1');
  assert.ok(shell !== undefined);
  // Herdr reports these pane-level fields on every pane, shells included.
  shell.agent_status = 'unknown';
  shell.display_agent = 'zsh';
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    const found = paneOf(kit.snapshot(), 'w1:p1');
    assert.ok(found !== undefined);
    assert.equal(found.pane.agent, undefined, 'no agents record: still no agent');
    assert.equal(found.pane.agentStatus, 'unknown');
    assert.equal(found.pane.displayAgent, 'zsh');
    assert.equal(found.pane.foregroundCwd, fake.world.cwd);
    assert.equal(fake.watching('w1:p1'), false, 'a shell with pane-level fields still opens no watch');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: a status push racing the snapshot read wins over the read', async () => {
  // The race the per-pane status socket loses without the guard: bootstrap #2 reads the snapshot
  // while the previous generation's status watch delivers a newer status onto the old tree. The
  // read predates the push, so the live push must survive the install.
  const world = {
    workspaces: [{ workspace_id: 'w1', label: 'x', focused: true, number: 1 }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
    panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', focused: true, label: 'pi' }],
    agents: [{ pane_id: 'w1:p2', agent: 'pi', name: 'pi', agent_status: 'idle', revision: 5 }],
  };
  let resolveRead: ((snapshot: unknown) => void) | undefined;
  let reads = 0;
  let batchOn: ((e: HerdrEvent) => void) | undefined;
  let statusOn: ((e: HerdrEvent) => void) | undefined;
  const transport: HerdrTransport = {
    call: async (method) => {
      if (method === 'session.snapshot') {
        reads += 1;
        if (reads === 1) return { snapshot: structuredClone(world) };
        return new Promise((resolve) => { resolveRead = resolve as (snapshot: unknown) => void; });
      }
      return { protocol: HERDR_PROTOCOL };
    },
    subscribe: (subs, on) => {
      if (subs.some((s) => s.type === 'pane.agent_status_changed')) {
        statusOn = on as (e: HerdrEvent) => void;
        return Object.assign(() => {}, {
          ready: Promise.resolve(true), onReconnect() {}, onDisconnect() {},
        }) as HerdrSubscribeStop;
      }
      batchOn = on as (e: HerdrEvent) => void;
      return (() => {}) as HerdrSubscribeStop;
    },
    close: () => {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/bin/false', socketPath: '/none', transport });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await kit.statusWatchReady();
    assert.ok(statusOn !== undefined, 'the bootstrap opens the per-pane status watch');
    // A structural event starts bootstrap #2, whose snapshot read hangs.
    batchOn?.({ type: 'pane.created', pane_id: 'w1:p9' } as HerdrEvent);
    await until(() => resolveRead, () => true, 2000);
    // The old watch delivers the newer status while the read is in flight.
    statusOn?.({ type: 'pane.agent_status_changed', pane_id: 'w1:p2', agent_status: 'working', revision: 6 } as HerdrEvent);
    resolveRead?.({ snapshot: structuredClone(world) });
    // Wait past the install (the re-bootstrap's status-watch ready resolves only after it), so the
    // probe below reads the post-install tree rather than the pre-install one.
    await kit.statusWatchReady();
    const found = paneOf(kit.snapshot(), 'w1:p2');
    assert.ok(found !== undefined);
    assert.equal(found.pane.agent?.status, 'working', 'the live push survives the stale read');
    assert.equal(found.pane.agent?.revision, 6, 'the live revision survives the stale read');
    assert.equal(kit.snapshot().workspaces.flatMap((w) => w.tabs).flatMap((t) => t.panes).length, 1,
      'no duplicate pane from the race');
  } finally {
    await kit.stop().catch(() => {});
  }
});

test('K2: workspace.updated merges label, focused, tokens and worktree into the tree', async () => {
  const fake: FakeHerdr = await startFakeHerdr({ dir: scratchDir('herdr-k2-ws-updated') });
  const real = socketTransport(fake.socketPath);
  let snapshots = 0;
  const counting: HerdrTransport = {
    call: (method, params, timeoutMs) => {
      if (method === 'session.snapshot') snapshots += 1;
      return real.call(method, params, timeoutMs);
    },
    subscribe: (subs, on, onError) => real.subscribe(subs, on, onError),
    close: () => real.close(),
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport: counting });
  try {
    await kit.start();
    assert.equal(snapshots, 1, 'the bootstrap reads the snapshot once');
    const seen: HerdrSnapshot[] = [];
    const stop = kit.onChange((s) => seen.push(s));
    try {
      // The tokens leg rides the real call path: the fake announces it with workspace_updated.
      await kit.call('workspace.report_metadata', { workspace_id: 'w1', source: 'byokit-k2', tokens: { k2: 'ws' } });
      await until(() => seen.at(-1), (s) => s.workspaces[0]?.tokens?.k2 === 'ws');
      // Label, focused and worktree ride the wire frame Herdr sends on workspace field changes.
      fake.emit({ type: 'workspace.updated', workspace: {
        workspace_id: 'w1', label: 'renamed', focused: false, number: 1, tokens: { k2: 'ws' },
        worktree: { repo_key: 'k', repo_name: 'n', repo_root: '/r', checkout_path: '/r', is_linked_worktree: true },
      } });
      const next = await until(() => seen.at(-1), (s) => s.workspaces[0]?.label === 'renamed');
      const w = next.workspaces[0];
      assert.equal(w.focused, false);
      assert.deepEqual(w.tokens, { k2: 'ws' });
      assert.deepEqual(w.worktree, { repoKey: 'k', repoName: 'n', repoRoot: '/r', checkoutPath: '/r', isLinkedWorktree: true });
      assert.equal(snapshots, 1, 'no re-bootstrap: the merge lands without another session.snapshot');
    } finally {
      stop();
    }
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: focus events are subscribed and move pane and workspace focus in the tree', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-focus') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    // A second workspace arrives through the structural path first.
    await kit.call('workspace.create', { label: 'two' });
    await until(() => kit.snapshot(), (s) => s.workspaces.length === 2);
    // workspace_focused (and the pane_focused riding it) flips the tree.
    await kit.call('workspace.focus', { workspace_id: 'w2' });
    await until(() => kit.snapshot(), (s) => s.workspaces.find((w) => w.id === 'w2')?.focused === true);
    let snap = kit.snapshot();
    assert.equal(snap.workspaces.find((w) => w.id === 'w1')?.focused, false);
    const focused = snap.workspaces.flatMap((w) => w.tabs.flatMap((t) => t.panes)).filter((p) => p.focused);
    assert.equal(focused.length, 1);
    assert.ok(focused[0]?.id.startsWith('w2:'), 'the focused pane moved with the workspace');
    // pane_focused moves pane focus back across workspaces; the workspace flag rides.
    await kit.call('pane.focus', { pane_id: 'w1:p1' });
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p1')?.pane.focused === true);
    snap = kit.snapshot();
    assert.equal(snap.workspaces.find((w) => w.id === 'w1')?.focused, true);
    assert.equal(snap.workspaces.find((w) => w.id === 'w2')?.focused, false);
    // tab_focused is subscribed: it carries no tree field, so it changes nothing (and breaks nothing).
    fake.emit({ type: 'tab.focused', tab_id: 'w1:t1', workspace_id: 'w1' });
    await settle(50);
    assert.equal(paneOf(kit.snapshot(), 'w1:p1')?.pane.focused, true);
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: a worktree record with only checkout_path is kept', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-worktree-partial') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    fake.emit({ type: 'workspace.updated',
      workspace: { workspace_id: 'w1', worktree: { checkout_path: '/srv/checkout-only' } } });
    await until(() => kit.snapshot(), (s) => s.workspaces[0]?.worktree?.checkoutPath === '/srv/checkout-only');
    assert.deepEqual(kit.snapshot().workspaces[0]?.worktree, { checkoutPath: '/srv/checkout-only' });
    // The type keeps the other fields optional: checkout_path alone is a valid record.
    const partial: HerdrSnapshotWorktree = { checkoutPath: '/x' };
    assert.equal(partial.checkoutPath, '/x');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: the seeded agent carries its cwd', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-agent-cwd') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    assert.equal(paneOf(kit.snapshot(), 'w1:p2')?.pane.agent?.cwd, fake.world.cwd);
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: a failed agent status lands in the tree and is not promptable', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-failed-status') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    fake.setStatus('w1:p2', 'failed');
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p2')?.pane.agent?.status === 'failed');
    const status: AgentStatus = 'failed';   // the union carries it
    assert.equal(status, 'failed');
    assert.equal(isPromptable(paneOf(kit.snapshot(), 'w1:p2')?.pane.agent), false);
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: snapshot revision increases on every tree change', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-revision') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    const r0 = kit.snapshot().revision;
    assert.ok(r0 >= 1, 'the bootstrap publishes a first revision');
    fake.setStatus('w1:p2', 'working');
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p2')?.pane.agent?.status === 'working');
    const r1 = kit.snapshot().revision;
    assert.ok(r1 > r0);
    fake.setStatus('w1:p2', 'idle');
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p2')?.pane.agent?.status === 'idle');
    assert.ok(kit.snapshot().revision > r1);
    // Delivered onChange snapshots carry the revision too.
    const seen: HerdrSnapshot[] = [];
    const stop = kit.onChange((s) => seen.push(s));
    fake.emit({ type: 'pane.updated', pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1', label: 'fish' } });
    await until(() => seen.at(-1), (s) => paneOf(s, 'w1:p1')?.pane.label === 'fish');
    assert.ok(seen.every((s) => Number.isInteger(s.revision)));
    assert.equal(seen.at(-1)?.revision, kit.snapshot().revision);
    stop();
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('K2: pane.moved clears the previous pane id and its status epoch', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k2-moved-epoch') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    // The epoch map is kit-private lifecycle bookkeeping; this journey asserts its one
    // pane.moved contract: the replaced pane id drops its entry.
    const epochs = (kit as unknown as { statusEpoch: Map<string, number> }).statusEpoch;
    fake.setStatus('w1:p2', 'working');
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p2')?.pane.agent?.status === 'working');
    assert.ok(epochs.get('w1:p2') !== undefined, 'the push stamps the pane epoch');
    // The move replaces w1:p2 with a fresh pane id (the account-move shape).
    const old = fake.world.panes.find((p) => p.pane_id === 'w1:p2');
    const agent = fake.world.agents.find((a) => a.pane_id === 'w1:p2');
    assert.ok(old !== undefined && agent !== undefined);
    fake.world.panes = fake.world.panes.filter((p) => p.pane_id !== 'w1:p2')
      .concat({ ...structuredClone(old), pane_id: 'w1:p9' });
    fake.world.agents = fake.world.agents.filter((a) => a.pane_id !== 'w1:p2')
      .concat({ ...structuredClone(agent), pane_id: 'w1:p9' });
    fake.emit({ type: 'pane.moved', previous_pane_id: 'w1:p2',
      pane: { pane_id: 'w1:p9', tab_id: 'w1:t1', workspace_id: 'w1', focused: false,
        agent_status: 'working', revision: agent.revision },
      previous_tab_id: 'w1:t1', previous_workspace_id: 'w1' });
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p9') !== undefined && paneOf(s, 'w1:p2') === undefined);
    assert.equal(epochs.has('w1:p2'), false, 'the replaced pane id drops its epoch');
    // The successor still gets live status pushes.
    fake.setStatus('w1:p9', 'idle');
    await until(() => kit.snapshot(), (s) => paneOf(s, 'w1:p9')?.pane.agent?.status === 'idle');
    assert.ok(epochs.get('w1:p9') !== undefined, 'the successor pane stamps its own epoch');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});
