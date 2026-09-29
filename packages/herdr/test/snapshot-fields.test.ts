// K2 acceptance: the snapshot carries the agent/pane/workspace fields muxr's mirror used to
// provide, `pane.updated` titles and labels merge with no re-bootstrap, and a status push that
// races a snapshot read is not lost (lifecycle-epoch guard) — all against the kit fake, never a
// real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { socketTransport } from '../src/socket.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import type { HerdrEvent, HerdrSnapshot, HerdrTransport } from '../src/types.ts';
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
        const stop = () => {};
        return Object.assign(stop, { ready: Promise.resolve(true) });
      }
      batchOn = on as (e: HerdrEvent) => void;
      return () => {};
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
