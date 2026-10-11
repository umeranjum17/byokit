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

      const workspaces = (await kit.call('workspace.list', {})) as { workspaces?: { worktree?: { is_linked_worktree?: boolean } }[] };
      assert.ok(
        workspaces.workspaces?.some((workspace) => workspace.worktree?.is_linked_worktree === true),
        'the worktree placement registers a linked checkout',
      );
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
      const made = (await kit.call('workspace.create', { cwd: '/tmp/h6-other' })) as { workspace?: { workspace_id?: string } };
      const w2 = made.workspace?.workspace_id;
      assert.equal(typeof w2, 'string');
      await assert.rejects(
        kit.closePane(`${w2}:p1`),
        (e: { code?: string }) => e.code === 'pane-close-would-widen',
        'closing the last pane would close the tab',
      );
      await assert.rejects(
        kit.closeTab(`${w2}:t1`),
        (e: { code?: string }) => e.code === 'tab-close-would-widen',
        'closing the only tab would close the workspace',
      );
      // worktree.create links a checkout into w1's group: the root now widens on close.
      await kit.startAgent({ kind: 'pi', cwd: '/tmp/h6', place: { workspace: 'new' }, worktree: { branch: 'h6' } });
      await assert.rejects(
        kit.closeWorkspace('w1'),
        (e: { code?: string }) => e.code === 'workspace-close-would-widen',
        'closing a worktree group parent would close the group',
      );
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
}
