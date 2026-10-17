// The contract suite (docs/runtime-kits.md 6.8): the same kit-level assertions run against the fake
// in later work packages' tests (H3/H5 wire `make` up) and against the real pinned Herdr in the lab
// (H9, which passes no `fake`). Cases that need to script the transport's wire answers use
// `withTransport`; when a `make` omits it, those cases skip.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { HERDR_PROTOCOL } from '../constants.ts';
import type { HerdrKit } from '../kit.ts';
import type { FakeHerdr } from './fake-herdr/server.ts';
import type { AgentStatus, HerdrEvent, HerdrProtocolRange, HerdrSnapshot, HerdrSubscribeStop, HerdrSubscription, HerdrTransport, PromptReceipt } from '../types.ts';

export type HerdrContractBench = {
  kit: HerdrKit;
  fake?: FakeHerdr;
  withTransport?: (transport: HerdrTransport, o?: { protocolRange?: HerdrProtocolRange }) => HerdrKit;
};

export type HerdrContractTestContext = {
  skip: (message?: string) => void;
};

export type HerdrContractTestFn = (
  name: string,
  fn: (t: HerdrContractTestContext) => void | Promise<void>,
) => void | Promise<void>;

export type HerdrContractOptions = {
  /** The runner's `test` (node:test's by default; pass vitest's `test` under vitest). */
  test?: HerdrContractTestFn;
};

export function herdrContract(
  make: () => Promise<HerdrContractBench>,
  options?: HerdrContractOptions | HerdrContractTestFn,
): void {
  const runTest: HerdrContractTestFn =
    typeof options === 'function' ? options : (options?.test ?? (nodeTest as unknown as HerdrContractTestFn));
  const test = runTest;
  const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function until<T>(probe: () => T | undefined | null, ok: (value: T) => boolean, ms = 2000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = probe();
      if (value !== undefined && value !== null && ok(value)) return value;
      if (Date.now() >= deadline) {
        assert.fail(`condition not reached within ${ms}ms: ${JSON.stringify(value ?? null)}`);
      }
      await settle(10);
    }
  }

  async function bench(run: (b: HerdrContractBench) => Promise<void>): Promise<void> {
    const made = await make();
    try {
      await run(made);
    } finally {
      await made.kit.stop().catch(() => {});
      await made.fake?.stop().catch(() => {});
    }
  }

  // Transport doubles that never exercise the control surface still satisfy its type.
  function ackedStop(): HerdrSubscribeStop {
    return Object.assign(() => {}, {
      ready: Promise.resolve(true),
      onReconnect() {},
      onDisconnect() {},
    });
  }

  function agentStatusOf(snapshot: HerdrSnapshot, paneId: string): { status?: AgentStatus; panes: number } {
    let panes = 0;
    let status: AgentStatus | undefined;
    for (const workspace of snapshot.workspaces) {
      for (const tab of workspace.tabs) {
        for (const pane of tab.panes) {
          panes += 1;
          if (pane.id === paneId) status = pane.agent?.status;
        }
      }
    }
    return { status, panes };
  }

  function ownerOf(snapshot: HerdrSnapshot, paneId: string):
    { workspace: HerdrSnapshot['workspaces'][number];
      tab: HerdrSnapshot['workspaces'][number]['tabs'][number] } | undefined {
    for (const workspace of snapshot.workspaces) {
      for (const tab of workspace.tabs) {
        if (tab.panes.some((pane) => pane.id === paneId)) return { workspace, tab };
      }
    }
    return undefined;
  }

  test('contract: start reaches ready and ping speaks the pinned protocol', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      assert.equal(kit.state.phase, 'ready');
      const ping = (await kit.call('ping', {})) as { protocol?: number; version?: string };
      assert.equal(ping.protocol, HERDR_PROTOCOL);
      assert.equal(typeof ping.version, 'string');
    });
  });

  test('contract: a newer server is needs-update state, not a throw — the kit stays usable', async (t) => {
    await bench(async ({ withTransport }) => {
      if (!withTransport) return t.skip('make provides no transport double');
      const snapshot = {
        protocol: HERDR_PROTOCOL + 999,
        snapshot: {
          protocol: HERDR_PROTOCOL + 999,
          workspaces: [{ workspace_id: 'w1', label: 'x' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
          panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }],
          agents: [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1 }],
        },
      };
      const kit = withTransport({
        call: async (method) => (method === 'session.snapshot' ? snapshot : { protocol: HERDR_PROTOCOL + 999 }),
        subscribe: () => ackedStop(),
        close: () => {},
      });
      try {
        await kit.start();
        assert.equal(kit.state.phase, 'needs-update');
        assert.equal(kit.state.why, 'version');
        assert.equal(kit.snapshot().workspaces.length, 1, 'the snapshot still installs');
        assert.ok(kit.snapshot().connected, 'the kit stays connected');
        await kit.call('ping', {});
      } finally {
        await kit.stop().catch(() => {});
      }
    });
  });

  test('contract: an older server fails closed', async (t) => {
    await bench(async ({ withTransport }) => {
      if (!withTransport) return t.skip('make provides no transport double');
      const kit = withTransport({
        call: async () => ({ protocol: HERDR_PROTOCOL - 1 }),
        subscribe: () => ackedStop(),
        close: () => {},
      });
      try {
        await assert.rejects(kit.start(), /protocol mismatch/);
        assert.equal(kit.state.phase, 'needs-update');
      } finally {
        await kit.stop().catch(() => {});
      }
    });
  });

  test('contract: a declared protocol range accepts a newer server as ready', async (t) => {
    await bench(async ({ withTransport }) => {
      if (!withTransport) return t.skip('make provides no transport double');
      const snapshot = {
        protocol: HERDR_PROTOCOL + 1,
        snapshot: {
          protocol: HERDR_PROTOCOL + 1,
          workspaces: [{ workspace_id: 'w1', label: 'x' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
          panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }],
          agents: [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1 }],
        },
      };
      const transport: HerdrTransport = {
        call: async (method) => (method === 'session.snapshot' ? snapshot : { protocol: HERDR_PROTOCOL + 1 }),
        subscribe: () => ackedStop(),
        close: () => {},
      };
      const inRange = withTransport(transport);
      try {
        await inRange.start();
        assert.equal(inRange.state.phase, 'needs-update', 'without the range a newer server is needs-update');
      } finally {
        await inRange.stop().catch(() => {});
      }
      const ranged = withTransport(transport, {
        protocolRange: { min: HERDR_PROTOCOL, max: HERDR_PROTOCOL + 1 },
      });
      try {
        await ranged.start();
        assert.equal(ranged.state.phase, 'ready', 'the declared range accepts the newer server');
        assert.equal(ranged.snapshot().workspaces.length, 1);
      } finally {
        await ranged.stop().catch(() => {});
      }
    });
  });

  test('contract: an event racing the bootstrap snapshot is applied after it, once', async (t) => {
    await bench(async ({ withTransport }) => {
      if (!withTransport) return t.skip('make provides no transport double');
      const snapshot = {
        snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'x', focused: true, tab_count: 1, active_tab_id: 'w1:t1' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
          panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', focused: false, agent_status: 'idle' }],
          agents: [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 0 }],
        },
      };
      const kit = withTransport({
        // The ack carries the race: `pane_updated` lands after the subscribe but before the kit
        // installs the snapshot, so buffering must order it after — and never duplicate it.
        call: async (method) => (method === 'session.snapshot' ? snapshot : { protocol: HERDR_PROTOCOL }),
        subscribe: (_subs, on) => {
          queueMicrotask(() => on({ type: 'pane_updated', pane: { pane_id: 'w1:p2', agent_status: 'working' } }));
          return ackedStop();
        },
        close: () => {},
      });
      try {
        await kit.start();
        assert.equal(kit.state.phase, 'ready');
        assert.equal(kit.snapshot().workspaces.length, 1, 'the snapshot still installs');
        await until(() => agentStatusOf(kit.snapshot(), 'w1:p2').status, (s) => s === 'working');
        assert.equal(agentStatusOf(kit.snapshot(), 'w1:p2').panes, 1, 'no duplicate pane from the race');
      } finally {
        await kit.stop().catch(() => {});
      }
    });
  });

  test('contract: a rejected subscription surfaces once and is not retried', async (t) => {
    await bench(async ({ withTransport }) => {
      if (!withTransport) return t.skip('make provides no transport double');
      let subscribeCalls = 0;
      const kit = withTransport({
        call: async () => ({ protocol: HERDR_PROTOCOL }),
        subscribe: (subs, _on, onError) => {
          subscribeCalls += 1;
          if (subs.some((s) => s.type === 'pane.agent_status_changed')) {
            onError('invalid_subscription', 'pane.agent_status_changed needs a pane_id');
          }
          return ackedStop();
        },
        close: () => {},
      });
      try {
        await kit.start().catch(() => {});
        const bootstrapCalls = subscribeCalls;
        // Deliberately schema-invalid: the pinned schema (6.7) requires pane_id for this filtered
        // kind, so the server rejects the batch — the exact answer the transport double gives here.
        const rejected = { type: 'pane.agent_status_changed' } as unknown as HerdrSubscription;
        const errors: { code: string; message: string }[] = [];
        const stop = kit.subscribe([rejected], () => {},
          (code, message) => errors.push({ code, message }));
        assert.equal(typeof stop, 'function');
        assert.ok(stop.ready instanceof Promise, 'the stop carries the ack promise');
        assert.equal(typeof stop.onReconnect, 'function');
        assert.equal(typeof stop.onDisconnect, 'function');
        await settle(1200);   // longer than the 1 s reconnect delay a retry would use
        assert.deepEqual(errors.map((e) => e.code), ['invalid_subscription'],
          'the rejection reaches onError exactly once');
        assert.match(errors[0].message, /pane_id/);
        assert.equal(subscribeCalls, bootstrapCalls + 1, 'the rejected subscription is never retried');
        stop();
      } finally {
        await kit.stop().catch(() => {});
      }
    });
  });

  test('contract: events reach a subscriber; unsubscribe stops them', async () => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return;
      await kit.start();
      const seen: HerdrEvent[] = [];
      const stop = kit.subscribe([{ type: 'pane.created' }], (event) => seen.push(event));
      await settle(100);   // the subscribe registers on its own socket; an emit before that never arrives
      fake.emit({ type: 'pane.created', pane_id: 'w9:p9' });
      await until(() => seen.length, (n) => n >= 1);
      // The fake emits the live underscore spelling; the kit matches both spellings.
      assert.equal(seen[0].type, 'pane_created');
      assert.equal((seen[0] as Record<string, unknown>).pane_id, 'w9:p9');
      stop();
      fake.emit({ type: 'pane.created', pane_id: 'w9:p10' });
      await settle(100);
      assert.equal(seen.length, 1, 'no frames after unsubscribe');
    });
  });

  test('contract: the per-pane status watch keeps the tree and blocked list current', async () => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return;
      await kit.start();
      await settle(100);   // the bootstrap's per-pane watch registers on its own socket
      fake.setStatus('w1:p2', 'working');
      await until(() => agentStatusOf(kit.snapshot(), 'w1:p2').status, (s) => s === 'working');
      fake.setStatus('w1:p2', 'blocked');
      const blocked = await until(() => kit.blocked(), (list) => list.length === 1);
      assert.equal(blocked[0].paneId, 'w1:p2');
      assert.equal(blocked[0].prompt, 'Allow this? (y/n)');
      assert.equal(typeof blocked[0].revision, 'number');
      assert.ok(blocked[0].revision >= 1);
      fake.setStatus('w1:p2', 'idle');
      await until(() => kit.blocked().length, (n) => n === 0);
    });
  });

  test('contract: startAgent returns fresh pane ids in every placement', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const taken = new Set(['w1:p1', 'w1:p2']);
      const start = (place: Parameters<HerdrKit['startAgent']>[0]['place'], extra: Partial<Parameters<HerdrKit['startAgent']>[0]> = {}) =>
        kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place, ...extra } as Parameters<HerdrKit['startAgent']>[0]);

      const ws = await start({ workspace: 'new' });
      const tab = await start({ tab: 'new', workspaceId: 'w1' });
      const split = await start({ split: 'w1:p1', direction: 'right' });
      const pane = await start({ pane: 'w1:p1' });
      const tree = await start({ workspace: 'new' }, { worktree: { branch: 'h6' } });
      for (const [name, ref] of [['workspace', ws], ['tab', tab], ['split', split], ['worktree', tree]] as const) {
        assert.match(ref.paneId, /^w\d+:p\d+$/, `${name} placement gets a live-shaped pane id`);
        assert.ok(!taken.has(ref.paneId), `${name} placement never predicts an existing pane id`);
        taken.add(ref.paneId);
      }
      assert.equal(pane.paneId, 'w1:p1', 'the pane placement uses the pane as given');
      assert.equal(typeof ws.name, 'string');
      // `created` tells a workspace-making placement from one landing in an existing workspace.
      assert.equal(ws.created, true, 'a new workspace reports created');
      assert.equal(tree.created, true, 'a worktree checkout reports created');
      assert.equal(tab.created, false, 'a new tab reports reuse');
      assert.equal(split.created, false, 'a split reports reuse');
      assert.equal(pane.created, false, 'a caller-owned pane reports reuse');

      const workspaces = (await kit.call('workspace.list', {})) as { workspaces?: { worktree?: { is_linked_worktree?: boolean } }[] };
      assert.ok(
        workspaces.workspaces?.some((workspace) => workspace.worktree?.is_linked_worktree === true),
        'the worktree placement registers a linked checkout',
      );
    });
  });

  test('contract: startAgent with a workspace label reuses the matching workspace', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const before = kit.snapshot().workspaces.length;
      const made = (await kit.call('workspace.create', { cwd: '/tmp/h6-label', label: 'byokit-reuse' })) as
        { workspace?: { workspace_id?: string } };
      const wid = made.workspace?.workspace_id;
      assert.equal(typeof wid, 'string');
      await until(() => kit.snapshot().workspaces.find((w) => w.id === wid), (w) => w !== undefined);

      const first = await kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'byokit-reuse', label: 'agent-tab' } });
      assert.equal(first.created, false, 'landing in an existing workspace reports reuse');
      assert.match(first.paneId, /^w\d+:p\d+$/);
      const tree = await until(() => {
        const snap = kit.snapshot();
        const owner = ownerOf(snap, first.paneId);
        return owner !== undefined && snap.workspaces.length === before + 1 ? { snap, owner } : undefined;
      }, () => true);
      assert.equal(tree.owner.workspace.id, wid, 'the agent lands in the workspace with that label');
      assert.equal(tree.owner.tab.label, 'agent-tab', 'the tab label rides the reuse');

      const second = await kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'byokit-reuse' } });
      assert.equal(second.created, false);
      assert.notEqual(second.paneId, first.paneId, 'the second start gets its own tab pane');
      const again = await until(() => {
        const snap = kit.snapshot();
        return ownerOf(snap, second.paneId) !== undefined && snap.workspaces.length === before + 1 ? snap : undefined;
      }, () => true);
      assert.equal(again.workspaces.length, before + 1, 'reuse adds a tab, never a workspace');
    });
  });

  test('contract: startAgent with an unknown workspace label creates it', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const before = kit.snapshot().workspaces.length;
      const ref = await kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'byokit-fresh' } });
      assert.equal(ref.created, true, 'no match creates the workspace');
      assert.match(ref.paneId, /^w\d+:p\d+$/);
      const snap = await until(() => {
        const s = kit.snapshot();
        const owner = ownerOf(s, ref.paneId);
        return owner !== undefined && owner.workspace.label === 'byokit-fresh' && s.workspaces.length === before + 1
          ? s : undefined;
      }, () => true);
      assert.equal(snap.workspaces.length, before + 1);
    });
  });

  test('contract: place labels the root tab of a workspace it creates and refuses env on a pane', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const ref = await kit.place({ cwd: '/tmp/h6', place: { workspace: 'byokit-place', label: 'shell' } });
      const owner = await until(() => ownerOf(kit.snapshot(), ref.paneId), (o) => o?.tab.label === 'shell');
      assert.equal(owner?.workspace.label, 'byokit-place', 'the workspace keeps its own label');
      assert.equal(owner?.tab.id, ref.tabId);
      await assert.rejects(kit.place({ place: { pane: ref.paneId }, env: { overlay: { A: 'b' } } }),
        (e: { code?: string }) => e.code === 'env_mismatch', 'an overlay on an existing pane is refused');
    });
  });

  test('contract: a failed start into a reused workspace keeps the workspace', async () => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return;
      await kit.start();
      const made = (await kit.call('workspace.create', { cwd: '/tmp/h6-label', label: 'byokit-keep' })) as
        { workspace?: { workspace_id?: string } };
      const wid = made.workspace?.workspace_id;
      assert.equal(typeof wid, 'string');
      await until(() => kit.snapshot().workspaces.find((w) => w.id === wid), (w) => w !== undefined);
      const panesBefore = agentStatusOf(kit.snapshot(), 'none').panes;
      fake.agentStartFaults.push({ code: 'agent_failed', message: 'boom' });
      await assert.rejects(
        kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'byokit-keep' } }), /boom/);
      await until(() => agentStatusOf(kit.snapshot(), 'none').panes, (n) => n === panesBefore);
      assert.ok(kit.snapshot().workspaces.some((w) => w.id === wid && w.label === 'byokit-keep'),
        'the reused workspace is never closed by a failed start');
    });
  });

  test('contract: two workspaces with one label refuse as ambiguous and pick nothing', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      await kit.call('workspace.create', { cwd: '/tmp/h6-label', label: 'byokit-dup' });
      await kit.call('workspace.create', { cwd: '/tmp/h6-label', label: 'byokit-dup' });
      const settled = await until(() => {
        const snap = kit.snapshot();
        return snap.workspaces.filter((w) => w.label === 'byokit-dup').length === 2 ? snap : undefined;
      }, () => true);
      const workspacesBefore = settled.workspaces.length;
      const panesBefore = agentStatusOf(settled, 'none').panes;
      await assert.rejects(
        kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'byokit-dup' } }),
        (e: { code?: string }) => e.code === 'workspace-ambiguous',
        'two matching labels refuse with the named ambiguous error');
      assert.equal(kit.snapshot().workspaces.filter((w) => w.label === 'byokit-dup').length, 2);
      assert.equal(kit.snapshot().workspaces.length, workspacesBefore, 'the refusal creates no workspace');
      assert.equal(agentStatusOf(kit.snapshot(), 'none').panes, panesBefore, 'the refusal creates no pane');
    });
  });

  test('contract: a started agent joins snapshot() and its status stays current there', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const { paneId } = await kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'new' } });
      await until(() => agentStatusOf(kit.snapshot(), paneId).status, (status) => status === 'idle');
      await kit.prompt({ paneId }, 'ask permission');
      await until(() => agentStatusOf(kit.snapshot(), paneId).status, (status) => status === 'blocked');
      const blocked = await until(() => kit.blocked().find((b) => b.paneId === paneId), () => true);
      await kit.answer(paneId, ['y'], { revision: blocked.revision });
      await until(() => agentStatusOf(kit.snapshot(), paneId).status, (status) => status === 'idle');
    });
  });

  test('contract: prompt validates the receipt and appends the reply text', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const receipt = await kit.prompt({ paneId: 'w1:p2' }, 'hello world');
      const shaped: PromptReceipt = receipt;   // compile-time: the receipt keeps the frozen shape
      assert.equal(shaped.paneId, 'w1:p2');
      assert.equal(typeof shaped.terminalId, 'string');
      assert.equal(shaped.status, 'working');
      assert.ok(shaped.revision >= 1);
      assert.equal(await kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 }), 'idle');
      const read = await kit.read('w1:p2');
      assert.match(read.text, /fake pi: hello world/);
    });
  });

  test('contract: a malformed prompt receipt fails', async (t) => {
    await bench(async ({ withTransport }) => {
      if (!withTransport) return t.skip('make provides no transport double');
      const kit = withTransport({
        call: async (method) => {
          if (method === 'agent.prompt') return { type: 'nonsense' };
          if (method === 'session.snapshot') {
            return { snapshot: {
              workspaces: [{ workspace_id: 'w1', label: 'x' }],
              tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
              panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }],
              agents: [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1 }],
            } };
          }
          return { protocol: HERDR_PROTOCOL };
        },
        subscribe: () => ackedStop(),
        close: () => {},
      });
      try {
        await kit.start().catch(() => {});
        await assert.rejects(kit.prompt({ paneId: 'w1:p2' }, 'x'), /did not queue/);
      } finally {
        await kit.stop().catch(() => {});
      }
    });
  });

  test('contract: wait resolves on a matching status and honors its timeout', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      assert.equal(await kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 }), 'idle');
      const started = Date.now();
      const status = await kit.wait({ paneId: 'w1:p2' }, { until: ['done'], timeoutMs: 60 });
      assert.equal(status, 'idle', 'the deadline returns the current status');
      assert.ok(Date.now() - started < 2000, 'the wait honors its timeout instead of hanging');
    });
  });

  test('contract: read unwraps result.read', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      assert.deepEqual(await kit.read('w1:p1'), { text: 'ready.', truncated: false });
      assert.deepEqual(await kit.read('w1:p1', { lines: 5 }), { text: 'ready.', truncated: false });
      assert.equal((await kit.read('w1:p2', { source: 'detection' })).text, '', 'an unblocked agent has no detection text');
    });
  });

  test('contract: blocked answers refuse a stale revision and accept the current one', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      await kit.prompt({ paneId: 'w1:p2' }, 'ask permission');
      const blocked = await until(() => kit.blocked(), (list) => list.length === 1);
      const revision = blocked[0].revision;
      await assert.rejects(
        kit.answer('w1:p2', ['y'], { revision: revision - 1 }),
        (e: { code?: string }) => e.code === 'approval-stale',
        'a stale revision is refused',
      );
      assert.equal(kit.blocked().length, 1, 'the refusal leaves the question open');
      await kit.answer('w1:p2', ['y'], { revision });
      await until(() => kit.blocked().length, (n) => n === 0);
      assert.equal(await kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 }), 'idle');
    });
  });

  test('contract: close guards refuse widening and close exact', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      // A fresh workspace holds exactly one tab with exactly one pane: the widening cases.
      const made = (await kit.call('workspace.create', { cwd: '/tmp/h6-other', label: 'other' })) as { workspace?: { workspace_id?: string } };
      const w2 = made.workspace?.workspace_id;
      assert.equal(typeof w2, 'string');
      // A refusal carries the wider target (scope, id, label) the app would close instead (6.4).
      // A worktree-group refusal adds the member count, so the confirmation needs no tree read.
      const widen = async (work: Promise<unknown>): Promise<Record<string, unknown>> => {
        try { await work; } catch (e) {
          const { scope, id, label, size, code } = e as { scope?: string; id?: string; label?: string; size?: number; code?: string };
          return { scope, id, label, ...(size === undefined ? {} : { size }), code };
        }
        assert.fail('expected a would-widen refusal');
      };
      assert.deepEqual(await widen(kit.closePane(`${w2}:p1`)),
        { scope: 'tab', id: `${w2}:t1`, label: 'main', code: 'pane-close-would-widen' },
        'closing the last pane widens to its tab');
      assert.deepEqual(await widen(kit.closeTab(`${w2}:t1`)),
        { scope: 'workspace', id: w2, label: 'other', code: 'tab-close-would-widen' },
        'closing the only tab widens to its workspace');
      // worktree.create links a checkout into w1's group: the root now widens on close.
      await kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'new' }, worktree: { branch: 'h6' } });
      assert.deepEqual(await widen(kit.closeWorkspace('w1')),
        { scope: 'worktreeGroup', id: 'w1', label: 'fake-herdr', size: 2, code: 'workspace-close-would-widen' },
        'closing a worktree group root names the group: repo name plus member count');
      // The exact closes still go through.
      await kit.call('pane.split', { target_pane_id: `${w2}:p1`, direction: 'right' });
      await kit.closePane(`${w2}:p1`);
      await kit.call('tab.create', { workspace_id: w2, cwd: '/tmp/h6-other' });
      await kit.closeTab(`${w2}:t1`);
      await kit.closeWorkspace(w2!);
    });
  });

  test('contract: waitPromptable waits through a launch-pending agent and resolves', async () => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return;
      const paneId = 'w1:p2';
      const agent = fake.world.agents.find((row) => row.pane_id === paneId);
      assert.ok(agent, 'the fake seeds w1:p2');
      agent.launch_pending = true;
      await kit.start();
      // A still-pending launch is not promptable: the deadline rejects agent-not-ready.
      await assert.rejects(kit.waitPromptable({ paneId }, { timeoutMs: 120 }),
        (e: { code?: string }) => e.code === 'agent-not-ready',
        'a launch that stays pending rejects with agent-not-ready');
      // Flip the fake ready: the next read clears launch_pending and the wait resolves.
      const waiting = kit.waitPromptable({ paneId }, { timeoutMs: 2000 });
      agent.launch_pending = false;
      await waiting;
      assert.equal(agentStatusOf(kit.snapshot(), paneId).status, 'idle');
    });
  });

  test('contract: waitPromptable rejects pane-unavailable when the pane closes mid-wait', async () => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return;
      const paneId = 'w1:p2';
      fake.world.agents.find((row) => row.pane_id === paneId)!.launch_pending = true;
      await kit.start();
      const waiting = kit.waitPromptable({ paneId }, { timeoutMs: 2000 });
      await kit.closePane(paneId);
      await assert.rejects(waiting, (e: { code?: string }) => e.code === 'pane-unavailable',
        'a pane closed while waiting rejects pane-unavailable instead of hanging');
    });
  });

  test('contract: host rename, focus and layout land in Herdr and read back', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const made = await kit.call('workspace.create', { cwd: '/tmp', label: 'umer-ops', focus: false });
      const workspaceId = made.workspace.workspace_id;
      const left = made.root_pane!.pane_id;
      const tabId = made.root_pane!.tab_id;
      const right = (await kit.call('pane.split', { target_pane_id: left, direction: 'right', focus: false })).pane.pane_id;

      await kit.rename({ tab: tabId, label: 'Umer tab' });
      await kit.rename({ pane: left, label: 'umer-left' });
      await kit.rename({ workspace: workspaceId, label: 'Umer desk' });
      assert.equal((await kit.call('tab.get', { tab_id: tabId })).tab.label, 'Umer tab');
      assert.equal((await kit.call('pane.get', { pane_id: left })).pane.label, 'umer-left');
      assert.equal((await kit.call('workspace.get', { workspace_id: workspaceId })).workspace.label, 'Umer desk');

      await kit.focus({ pane: right });
      assert.equal((await kit.call('pane.get', { pane_id: right })).pane.focused, true, 'the focused pane reads back focused');
      assert.equal((await kit.call('pane.get', { pane_id: left })).pane.focused, false);

      // The real server lays the tree out in a fresh tab; the fake moves the named panes. Both answer
      // the applied tree, and the first leaf reads back at a quarter of the width, left of the second.
      const applied = await kit.layout({
        workspaceId, tabLabel: 'Umer layout', focus: false,
        root: { type: 'split', direction: 'right', ratio: 0.25,
          first: { type: 'pane', pane_id: right }, second: { type: 'pane', pane_id: left } },
      });
      const root = applied.layout.root as { type: string; first?: { pane_id?: string }; second?: { pane_id?: string } };
      assert.equal(root.type, 'split');
      const first = root.first?.pane_id;
      const second = root.second?.pane_id;
      assert.equal(typeof first, 'string');
      assert.equal((await kit.call('tab.get', { tab_id: applied.layout.tab_id })).tab.label, 'Umer layout');
      const rects = (await kit.call('pane.layout', { pane_id: first! })).layout.panes;
      const firstRect = rects.find((p) => p.pane_id === first)!.rect;
      const secondRect = rects.find((p) => p.pane_id === second)!.rect;
      assert.ok(firstRect.x < secondRect.x && firstRect.width < secondRect.width,
        `the 0.25 split reads back narrower on the left: ${JSON.stringify(rects)}`);

      // A Herdr refusal surfaces Herdr's own code and sentence; a target that is not exactly one never calls.
      await assert.rejects(kit.rename({ pane: `${workspaceId}:p99`, label: 'x' }),
        (e: Error & { code?: string }) => e.code === 'pane_not_found' && e.message.startsWith('herdr: pane_not_found: '));
      await assert.rejects(kit.focus({ tab: 'w99:t1' }), (e: Error & { code?: string }) => e.code === 'tab_not_found');
      await assert.rejects(kit.focus({}), /focus picks exactly one of pane, tab or workspace/);
      await assert.rejects(kit.rename({ pane: left, tab: tabId, label: 'x' }), /rename picks exactly one/);
    });
  });

  test('contract: pane.focus_direction moves focus to the neighbour and holds at an edge', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const made = await kit.call('workspace.create', { cwd: '/tmp', label: 'umer-focus-dir', focus: false });
      const workspaceId = made.workspace.workspace_id;
      const left = made.root_pane!.pane_id;
      const right = (await kit.call('pane.split', { target_pane_id: left, direction: 'right', focus: false })).pane.pane_id;
      // Side by side, so `right` is the neighbour past the left edge and vice versa.
      // Like the rename/focus/layout case above, the applied tree's ids are read back: the
      // fake moves the named panes in place while real Herdr lays out fresh panes.
      const applied = await kit.layout({ workspaceId, focus: false,
        root: { type: 'split', direction: 'right', ratio: 0.5,
          first: { type: 'pane', pane_id: left }, second: { type: 'pane', pane_id: right } } });
      const ends = applied.layout.root as { first?: { pane_id?: string }; second?: { pane_id?: string } };
      const first = ends.first?.pane_id;
      const second = ends.second?.pane_id;
      assert.equal(typeof first, 'string');
      assert.equal(typeof second, 'string');
      await kit.focus({ pane: first! });

      const moved = await kit.call('pane.focus_direction', { pane_id: first, direction: 'right' });
      assert.equal(moved.type, 'pane_focus_direction');
      assert.equal(moved.focus.changed, true);
      assert.equal(moved.focus.source_pane_id, first);
      assert.equal(moved.focus.focused_pane_id, second);
      assert.equal((await kit.call('pane.get', { pane_id: second! })).pane.focused, true);
      assert.equal((await kit.call('pane.get', { pane_id: first! })).pane.focused, false);

      // Past the outer edge there is no neighbour: focus holds with `no_neighbor`, like real Herdr.
      const held = await kit.call('pane.focus_direction', { pane_id: second, direction: 'right' });
      assert.equal(held.focus.changed, false);
      assert.equal(held.focus.source_pane_id, second);
      assert.equal(held.focus.focused_pane_id, second);
      assert.equal(held.focus.reason, 'no_neighbor');
      assert.equal((await kit.call('pane.get', { pane_id: second! })).pane.focused, true);

      // Back across the split, and nothing above a full-height pane either.
      const back = await kit.call('pane.focus_direction', { pane_id: second, direction: 'left' });
      assert.equal(back.focus.changed, true);
      assert.equal(back.focus.focused_pane_id, first);
      const top = await kit.call('pane.focus_direction', { pane_id: first, direction: 'up' });
      assert.equal(top.focus.changed, false);
      assert.equal(top.focus.reason, 'no_neighbor');

      await assert.rejects(kit.call('pane.focus_direction', { pane_id: `${workspaceId}:p99`, direction: 'right' }),
        (e: Error & { code?: string }) => e.code === 'pane_not_found');
    });
  });

  test('contract: layout.export returns the tab layout with every live pane as a leaf', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const made = await kit.call('workspace.create', { cwd: '/tmp', label: 'umer-export', focus: false });
      const workspaceId = made.workspace.workspace_id;
      const tabId = made.root_pane!.tab_id;
      const first = made.root_pane!.pane_id;
      const second = (await kit.call('pane.split', { target_pane_id: first, direction: 'right', focus: false })).pane.pane_id;
      const leaves = (root: unknown): string[] => {
        const node = root as { type?: string; pane_id?: string; first?: unknown; second?: unknown };
        if (node.type === 'pane') return typeof node.pane_id === 'string' ? [node.pane_id] : [];
        return [...leaves(node.first), ...leaves(node.second)];
      };

      const exported = await kit.call('layout.export', { tab_id: tabId });
      assert.equal(exported.type, 'layout_export');
      assert.equal(exported.layout.tab_id, tabId);
      assert.equal(exported.layout.workspace_id, workspaceId);
      assert.equal(typeof exported.layout.focused_pane_id, 'string');
      assert.equal(typeof exported.layout.zoomed, 'boolean');
      assert.deepEqual(leaves(exported.layout.root).sort(), [first, second].sort());

      // The pane-addressed form exports the same tab.
      const viaPane = await kit.call('layout.export', { pane_id: second });
      assert.equal(viaPane.layout.tab_id, tabId);
      assert.deepEqual(leaves(viaPane.layout.root).sort(), [first, second].sort());

      await assert.rejects(kit.call('layout.export', { tab_id: 'w99:t9' }),
        (e: Error & { code?: string }) => e.code === 'tab_not_found');
    });
  });

  test('contract: the cli answers --version and the terminal echoes', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      const cli = await kit.cli(['--version']);
      assert.equal(cli.exitCode, 0);
      assert.match(cli.stdout, /^herdr 0\.9\.1\n$/);

      const terminal = kit.terminal('w1:p1', { mode: 'observe', cols: 80, rows: 24 });
      const frames: string[] = [];
      terminal.onFrame((line) => frames.push(line));
      await terminal.ready;
      assert.match(frames[0], /terminal\.ready/);
      terminal.send(`${JSON.stringify({ type: 'terminal.input', data: 'echo hi' })}\n`);
      await until(() => frames.length, (n) => n >= 2);
      assert.match(frames[1], /echo hi/);
      terminal.close();
      const exited = await terminal.exited;
      assert.ok(exited.code === 0 || exited.code === null);
    });
  });

  test('contract: pane.report_agent sets the status the snapshot shows', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      await settle(100);   // the bootstrap's per-pane watch registers on its own socket
      await kit.call('pane.report_agent', { pane_id: 'w1:p2', agent: 'pi', source: 'contract', state: 'working' });
      await until(() => agentStatusOf(kit.snapshot(), 'w1:p2').status, (s) => s === 'working');
    });
  });

  test('contract: pane.report_agent refuses a state the pinned schema does not report', async () => {
    await bench(async ({ kit }) => {
      await kit.start();
      await settle(100);
      // The typed surface forbids `failed`; the refusal the real server gives is what this case proves.
      const failed = { pane_id: 'w1:p2', agent: 'pi', source: 'contract', state: 'failed' } as never;
      await assert.rejects(kit.call('pane.report_agent', failed));
      assert.notEqual(agentStatusOf(kit.snapshot(), 'w1:p2').status, 'failed');
    });
  });

  test('contract: pane report-agent from a child process sets the status, and failed is refused', async (t) => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return t.skip('the child-process verb is checked against the fake bin here');
      await kit.start();
      await settle(100);
      const reported = await kit.cli(['pane', 'report-agent', '--pane', 'w1:p2', '--source', 'contract', '--agent', 'pi', '--state', 'blocked']);
      assert.equal(reported.exitCode, 0, reported.stderr);
      await until(() => agentStatusOf(kit.snapshot(), 'w1:p2').status, (s) => s === 'blocked');
      const refused = await kit.cli(['pane', 'report-agent', '--pane', 'w1:p2', '--source', 'contract', '--agent', 'pi', '--state', 'failed']);
      assert.notEqual(refused.exitCode, 0);
      assert.match(refused.stderr, /failed/);
      assert.equal(agentStatusOf(kit.snapshot(), 'w1:p2').status, 'blocked');
    });
  });

  test('contract: a held agent.wait answers only after release', async (t) => {
    await bench(async ({ kit, fake }) => {
      if (!fake) return t.skip('the hold is a fake-only control');
      await kit.start();
      const release = fake.holdAgentWait();
      let answered: string | undefined;
      const waiting = kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 }).then((status) => {
        answered = status;
        return status;
      });
      await settle(100);
      assert.equal(answered, undefined, 'the held wait has not answered');
      release();
      assert.equal(await waiting, 'idle');
    });
  });
}
