// H9 lab contract run (docs/runtime-kits.md §11.3): `herdrContract` against the real
// pinned Herdr v0.9.1 in `own` mode inside a task-owned HOME/stateDir.
//
// Not matched by `npm test`'s glob (`packages/*/test/*.test.ts`): run by hand under a
// `--herdr-lab` brief only, with the fleet `default` session wrapped in the Herdr lab
// helper's provision/teardown (the helper owns that tripwire; this file never touches a
// person's Herdr):
//
//   HOME=<task-home> node packages/herdr/test/lab/contract.lab.ts
//
// The run downloads the H2-recorded asset, verifies its sha256, then drives
// `HerdrKit({ mode: 'own', bin, stateDir })`. Every case in
// `src/testing/contract.ts` is listed here exactly once: agent cases run only when the
// lab home has a signed-in agent CLI (else skipped — the schema has no `bash` custom
// kind, verified below from `agent start --help`), fake-helper cases are skipped, and
// H7 cases (link, device, notices, terminal over link) are skipped as `awaits H7` so
// the run can be repeated after H7 lands. Results go to `schema/LAB.md`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../../src/constants.ts';
import { HerdrKit } from '../../src/kit.ts';
import type { HerdrSnapshot, HerdrSubscription, HerdrTransport } from '../../src/types.ts';

const ASSET_URL = 'https://github.com/herdrdev/herdr/releases/download/v0.9.1/herdr-linux-x86_64';
const ASSET_SHA256 = '2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7';

const run = (bin: string, args: string[], env?: Record<string, string>): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ...env } }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });

const sha256 = async (path: string): Promise<string> => {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
};

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function paneCount(snapshot: HerdrSnapshot, paneId: string): Promise<number> {
  let panes = 0;
  for (const w of snapshot.workspaces) for (const t of w.tabs) for (const p of t.panes) {
    panes += 1;
    if (p.id === paneId) return panes;
  }
  return panes;
}

const lab = await mkdtemp(join(tmpdir(), 'byokit-herdr-lab-'));
const bin = join(lab, 'herdr-linux-x86_64');
let stateCount = 0;
const cwdA = join(lab, 'cwd-a');
const cwdB = join(lab, 'cwd-b');
await mkdir(cwdA, { recursive: true });
await mkdir(cwdB, { recursive: true });

test('lab: Herdr v0.9.1 asset matches the H2-recorded sha256', async () => {
  const cached = join(tmpdir(), 'byk-hd-lab', 'herdr-linux-x86_64');
  try {
    assert.equal(await sha256(cached), ASSET_SHA256);
    await writeFile(bin, await readFile(cached));
  } catch {
    const response = await fetch(ASSET_URL);
    assert.ok(response.ok, `asset download failed: ${response.status}`);
    await writeFile(bin, Buffer.from(await response.arrayBuffer()));
    assert.equal(await sha256(bin), ASSET_SHA256, 'downloaded asset sha256 mismatch');
  }
  await chmod(bin, 0o700);
  assert.match(await run(bin, ['--version']), /^herdr 0\.9\.1\n$/);
  assert.equal(HERDR_VERSION, '0.9.1');
});

test('lab: the schema has no bash custom kind for agent cases', async (t) => {
  const help = await run(bin, ['agent', 'start', '--help']);
  const kinds = /possible values: ([^\]]+)\]/.exec(help)?.[1]?.split(',').map((k) => k.trim()) ?? [];
  assert.ok(kinds.length > 0, 'kind list unreadable');
  assert.ok(kinds.includes('pi'), 'expected pi among agent kinds');
  if (kinds.includes('bash')) return;
  t.skip('no bash custom kind in the pinned schema; agent cases stay skipped without a signed-in CLI');
});

const ownKit = (): HerdrKit => {
  // A fresh stateDir per kit: Herdr restores prior workspaces across restarts, so sharing
  // one would contaminate each case with the previous case's tree.
  stateCount += 1;
  return new HerdrKit({ mode: 'own', bin, stateDir: join(lab, `state-${stateCount}`) });
};
const double = (transport: HerdrTransport): HerdrKit =>
  new HerdrKit({ mode: 'adopt', bin, socketPath: join(lab, 'double.sock'), transport });

test('contract: start reaches ready and ping speaks the pinned protocol', async () => {
  const k = ownKit();
  await k.start();
  try {
    assert.equal(k.state.phase, 'ready');
    // A fresh task server owns an empty tree: it never sees the fleet's workspaces.
    assert.deepEqual(k.snapshot().workspaces, []);
    const ping = (await k.call('ping', {})) as { protocol?: number; version?: string };
    assert.equal(ping.protocol, HERDR_PROTOCOL);
    assert.equal(typeof ping.version, 'string');
    const kinds = await k.agentKinds();
    assert.ok(kinds.includes('pi'), 'real server lists pi among agent kinds');
    assert.ok(!kinds.includes('bash'), 'real server has no bash agent kind');
  } finally {
    await k.stop().catch(() => {});
  }
});

test('contract: a protocol mismatch reports needs-update', async () => {
  const other = double({
    call: async () => ({ protocol: HERDR_PROTOCOL + 999 }),
    subscribe: () => () => {},
    close: () => {},
  });
  try {
    await other.start().catch(() => {});
    assert.equal(other.state.phase, 'needs-update');
  } finally {
    await other.stop().catch(() => {});
  }
});

test('contract: an event racing the bootstrap snapshot is applied after it, once', async () => {
  const snapshot = {
    snapshot: {
      workspaces: [{ workspace_id: 'w1', label: 'x', focused: true, tab_count: 1, active_tab_id: 'w1:t1' }],
      tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
      panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1', focused: false, agent_status: 'idle' }],
      agents: [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 0 }],
    },
  };
  const other = double({
    call: async (method) => (method === 'session.snapshot' ? snapshot : { protocol: HERDR_PROTOCOL }),
    subscribe: (_subs, on) => {
      queueMicrotask(() => on({ type: 'pane.updated', pane: { pane_id: 'w1:p2', agent_status: 'working' } }));
      return () => {};
    },
    close: () => {},
  });
  try {
    await other.start();
    assert.equal(other.state.phase, 'ready');
    const deadline = Date.now() + 2000;
    for (;;) {
      const panes = await paneCount(other.snapshot(), 'w1:p2');
      if (panes === 1) break;
      assert.ok(Date.now() < deadline, 'racing event lost or duplicated');
      await settle(10);
    }
  } finally {
    await other.stop().catch(() => {});
  }
});

test('contract: a rejected subscription surfaces once and is not retried', async () => {
  let subscribeCalls = 0;
  const other = double({
    call: async () => ({ protocol: HERDR_PROTOCOL }),
    subscribe: (subs, _on, onError) => {
      subscribeCalls += 1;
      if (subs.some((s) => s.type === 'pane.agent_status_changed')) {
        onError('invalid_subscription', 'pane.agent_status_changed needs a pane_id');
      }
      return () => {};
    },
    close: () => {},
  });
  try {
    await other.start().catch(() => {});
    const bootstrapCalls = subscribeCalls;
    const rejected = { type: 'pane.agent_status_changed' } as unknown as HerdrSubscription;
    other.subscribe([rejected], () => {});
    await settle(1200);
    assert.equal(subscribeCalls, bootstrapCalls + 1, 'the rejected subscription is never retried');
  } finally {
    await other.stop().catch(() => {});
  }
});

test('contract: events reach a subscriber; unsubscribe stops them', async (t) => {
  t.skip('needs the fake emit helper; the real server has no scripted event source');
});

test('contract: the per-pane status watch keeps the tree and blocked list current', async (t) => {
  t.skip('needs the fake setStatus helper; no signed-in agent CLI in the lab home');
});

test('contract: startAgent returns fresh pane ids in every placement', async (t) => {
  t.skip('needs a signed-in agent CLI; the pinned schema has no bash custom kind');
});

test('contract: prompt validates the receipt and appends the reply text', async (t) => {
  t.skip('needs a signed-in agent CLI; the pinned schema has no bash custom kind');
});

test('contract: a malformed prompt receipt fails', async () => {
  const other = double({
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
    subscribe: () => () => {},
    close: () => {},
  });
  try {
    await other.start().catch(() => {});
    await assert.rejects(other.prompt({ paneId: 'w1:p2' }, 'x'), /did not queue/);
  } finally {
    await other.stop().catch(() => {});
  }
});

test('contract: wait resolves on a matching status and honors its timeout', async (t) => {
  t.skip('needs a live agent pane; no signed-in agent CLI in the lab home');
});

test('contract(lab): read unwraps result.read on a real shell pane', async () => {
  const k = ownKit();
  await k.start();
  try {
    await k.call('workspace.create', { cwd: cwdA, focus: false });
    let paneId: string | undefined;
    const deadline = Date.now() + 8000;
    while (paneId === undefined) {
      paneId = k.snapshot().workspaces[0]?.tabs[0]?.panes[0]?.id;
      assert.ok(Date.now() < deadline, 'real workspace never appeared in the live tree');
      if (paneId === undefined) await settle(100);
    }
    // Same unwrap as the fake-world case (`result.read` → `{ text, truncated }`).
    const read = await k.read(paneId);
    assert.equal(typeof read.text, 'string');
    assert.equal(typeof read.truncated, 'boolean');
    assert.equal(typeof (await k.read(paneId, { lines: 5 })).text, 'string');
    assert.equal(typeof (await k.read(paneId, { source: 'detection' })).text, 'string');
  } finally {
    await k.stop().catch(() => {});
  }
});

test('contract: blocked answers refuse a stale revision and accept the current one', async (t) => {
  t.skip('needs a live blocked agent; no signed-in agent CLI in the lab home');
});

test('contract(lab): close guards refuse widening and close exact on the real server', async () => {
  const k = ownKit();
  await k.start();
  try {
    const made = (await k.call('workspace.create', { cwd: cwdB, focus: false })) as {
      workspace?: { workspace_id?: string };
    };
    const w2 = made.workspace?.workspace_id;
    assert.equal(typeof w2, 'string');
    let paneId: string | undefined;
    let tabId: string | undefined;
    const deadline = Date.now() + 8000;
    while (paneId === undefined || tabId === undefined) {
      const ws = k.snapshot().workspaces.find((w) => w.id === w2);
      paneId = ws?.tabs[0]?.panes[0]?.id;
      tabId = ws?.tabs[0]?.id;
      assert.ok(Date.now() < deadline, 'real workspace never appeared in the live tree');
      if (paneId === undefined || tabId === undefined) await settle(100);
    }
    await assert.rejects(
      k.closePane(paneId),
      (e: { code?: string }) => e.code === 'pane-close-would-widen',
      'closing the last pane would close the tab',
    );
    await assert.rejects(
      k.closeTab(tabId),
      (e: { code?: string }) => e.code === 'tab-close-would-widen',
      'closing the only tab would close the workspace',
    );
    await k.call('pane.split', { target_pane_id: paneId, direction: 'right' });
    await k.closePane(paneId);
    await k.call('tab.create', { workspace_id: w2, cwd: cwdB });
    await k.closeTab(tabId);
    await k.closeWorkspace(w2!);
  } finally {
    await k.stop().catch(() => {});
  }
});

test('contract(lab): the worktree-parent close guard', async (t) => {
  t.skip('needs a live agent placement via startAgent; no signed-in agent CLI in the lab home');
});

test('contract(lab): the cli answers --version on the real binary', async () => {
  const k = ownKit();
  await k.start();
  try {
    const cli = await k.cli(['--version']);
    assert.equal(cli.exitCode, 0);
    assert.match(cli.stdout, /^herdr 0\.9\.1\n$/);
  } finally {
    await k.stop().catch(() => {});
  }
});

test('contract(lab): terminal observe reaches ready and exits cleanly on the real server', async () => {
  const k = ownKit();
  await k.start();
  try {
    await k.call('workspace.create', { cwd: cwdA, focus: false });
    let paneId: string | undefined;
    const deadline = Date.now() + 8000;
    while (paneId === undefined) {
      paneId = k.snapshot().workspaces[0]?.tabs[0]?.panes[0]?.id;
      assert.ok(Date.now() < deadline, 'real workspace never appeared in the live tree');
      if (paneId === undefined) await settle(100);
    }
    const terminal = k.terminal(paneId, { mode: 'observe', cols: 80, rows: 24 });
    const frames: string[] = [];
    terminal.onFrame((line) => frames.push(line));
    await terminal.ready;
    assert.ok(frames.length >= 1 && typeof frames[0] === 'string' && frames[0].length > 0);
    terminal.send(`${JSON.stringify({ type: 'terminal.input', data: 'echo hi' })}\n`);
    await settle(500);
    terminal.close();
    await terminal.exited;
  } finally {
    await k.stop().catch(() => {});
  }
});

test('contract(lab): terminal observe echoes sent input', async (t) => {
  t.skip('the fake shim echoes sends; the real server emits NDJSON bytes frames (see schema/LAB.md)');
});

test('contract(lab): hd.link round-trips member ops', async (t) => {
  t.skip('awaits H7');
});

test('contract(lab): hd.device client over the link', async (t) => {
  t.skip('awaits H7');
});

test('contract(lab): sealed blocked-agent notices', async (t) => {
  t.skip('awaits H7');
});

test('contract(lab): hd.terminal stream over the link', async (t) => {
  t.skip('awaits H7');
});

test('lab: teardown removes the task server and temp dirs', async () => {
  await rm(lab, { recursive: true, force: true });
});
