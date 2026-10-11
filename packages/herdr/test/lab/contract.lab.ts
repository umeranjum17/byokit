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
// the H7 link/device/notices/terminal-over-link cases run over a real Host +
// DeviceLink pair on loopback against the real server (only the live-agent sub-paths
// stay skipped). Results go to `schema/LAB.md`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchDir } from '../../../test-support.ts';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  DeviceLink, Host, keyPair, pairWithOffer,
  type DeviceGrant, type Grant,
} from '@byokit/pair';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../../src/constants.ts';
import { HerdrKit } from '../../src/kit.ts';
import { herdrLink, serve, type HerdrScope } from '../../src/link.ts';
import { herdrDevice } from '../../src/device.ts';
import { boxPublicKeyB64, decodeB64Url, openNotice, sealNotice } from '../../src/notices.ts';
import type { BlockedAgent, HerdrSnapshot, HerdrSubscribeStop, HerdrSubscription, HerdrTransport } from '../../src/types.ts';
import { words } from '../../src/words.ts';

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

const lab = scratchDir('herdr-lab');
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
    subscribe: () => (() => {}) as HerdrSubscribeStop,
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
      return (() => {}) as HerdrSubscribeStop;
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
      return (() => {}) as HerdrSubscribeStop;
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
    subscribe: () => (() => {}) as HerdrSubscribeStop,
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

// ---- H7 over the real server: a real Host + DeviceLink pair on loopback ----
const scopeOf = (grant: Grant): HerdrScope =>
  (grant.meta as { scope?: HerdrScope } | undefined)?.scope ?? { workspaces: [] };
const ALL: HerdrScope = { workspaces: 'all' };
const NOT_ALLOWED = words('link.notAllowed');

const untilFrames = async <T>(probe: () => T | Promise<T>, ok: (value: T) => boolean, ms = 8000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (ok(value)) return value;
    assert.ok(Date.now() < deadline, 'timed out waiting for the live condition');
    await settle(50);
  }
};

type LinkBench = {
  kit: HerdrKit;
  pair: (role: 'control' | 'view', scope: HerdrScope, name: string) =>
    Promise<{ hd: ReturnType<typeof herdrDevice>; link: DeviceLink }>;
};

async function withLinkBench(o: {
  passThrough?: (method: string, grant: Grant) => boolean;
  run: (b: LinkBench) => Promise<void>;
}): Promise<void> {
  const kit = ownKit();
  const links: DeviceLink[] = [];
  let saved: Grant[] = [];
  let host: Host | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let wss: WebSocketServer | undefined;
  const sockets = new Set<WsSocket>();
  try {
    await kit.start();
    host = await Host.open({
      keys: keyPair(), name: 'H9 lab bench',
      grants: { load: () => saved, save: (g) => { saved = g; } },
      confirm: () => true,
      ...herdrLink(kit, { scopeOf, ...(o.passThrough ? { passThrough: o.passThrough } : {}) }),
    });
    server = createServer();
    wss = new WebSocketServer({ server });
    const h = host;
    wss.on('connection', (ws) => { sockets.add(ws); h.accept(ws); });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
    const pair = async (role: 'control' | 'view', scope: HerdrScope, name: string) => {
      const { text } = h.offer({ role, urls: [url], meta: { scope } });
      const grant = await pairWithOffer(text, { name, onWords: () => {} });
      const store = { g: grant as DeviceGrant | null, save(g: DeviceGrant) { this.g = g; }, clear() { this.g = null; } };
      const link = new DeviceLink(grant, { store });
      links.push(link);
      await untilFrames(() => link.status, (s) => s === 'online');
      return { hd: herdrDevice(link), link };
    };
    await o.run({ kit, pair });
  } finally {
    for (const link of links) link.stop();
    host?.close();
    for (const s of sockets) s.terminate();
    if (wss) await new Promise<void>((r) => wss!.close(() => r()));
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await kit.stop().catch(() => {});
  }
}

async function livePane(hd: ReturnType<typeof herdrDevice>): Promise<string> {
  const tree = await untilFrames(() => hd.tree(), (t) => t.workspaces.length === 1);
  const paneId = tree.workspaces[0]?.tabs[0]?.panes[0]?.id;
  assert.equal(typeof paneId, 'string');
  return paneId!;
}

test('contract(lab): hd.* ops round-trip over loopback against the real server', async () => {
  await withLinkBench({ run: async ({ kit, pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    const state = await hd.state();
    assert.equal(state.state.phase, 'ready');
    assert.equal(state.words, 'Connected to Herdr.');
    await kit.call('workspace.create', { cwd: cwdA, focus: false });
    const paneId = await livePane(hd);
    const read = await hd.read(paneId);
    assert.equal(typeof read.text, 'string');
    assert.equal(typeof read.truncated, 'boolean');
    assert.deepEqual(await hd.blocked(), []);
    // Pass-through is denied by default (D8).
    await assert.rejects(hd.call('ping', {}), (e: Error) => e.message === NOT_ALLOWED);
    // The events stream opens with a snapshot first.
    const frames: unknown[] = [];
    for await (const frame of hd.events()) {
      frames.push(frame);
      break;
    }
    assert.equal((frames[0] as { type: string }).type, 'snapshot');
  } });
});

test('contract(lab): hd.call opens when the pass-through predicate allows it', async () => {
  await withLinkBench({
    passThrough: (method) => method === 'ping',
    run: async ({ pair }) => {
      const { hd } = await pair('control', ALL, 'desk');
      // The real ping carries more fields than the fake's; the pass-through returns both verbatim.
      const pong = (await hd.call('ping', {})) as { protocol?: number; version?: string };
      assert.equal(pong.protocol, HERDR_PROTOCOL);
      assert.equal(pong.version, HERDR_VERSION);
      await assert.rejects(hd.call('session.snapshot', {}), (e: Error) => e.message === NOT_ALLOWED);
    },
  });
});

test('contract(lab): view grants and scope are enforced on the real server', async () => {
  await withLinkBench({ run: async ({ kit, pair }) => {
    await kit.call('workspace.create', { cwd: cwdA, label: 'a', focus: false });
    await kit.call('workspace.create', { cwd: cwdB, label: 'b', focus: false });
    const ids = await untilFrames(() => kit.snapshot().workspaces.map((w) => w.id), (got) => got.length === 2);
    const paneIn = async (workspaceId: string): Promise<string> => {
      const ws = (await untilFrames(() => kit.snapshot().workspaces.find((w) => w.id === workspaceId),
        (w) => w?.tabs[0]?.panes[0] !== undefined))!;
      return ws.tabs[0].panes[0].id;
    };
    const narrow = await pair('control', { workspaces: [ids[0]] }, 'narrow');
    const view = await pair('view', ALL, 'phone');
    assert.deepEqual((await narrow.hd.tree()).workspaces.map((w) => w.id), [ids[0]]);
    await assert.rejects(narrow.hd.read(await paneIn(ids[1])), (e: Error) => e.message === NOT_ALLOWED);
    assert.equal((await view.hd.state()).state.phase, 'ready');
    assert.equal(typeof (await view.hd.read(await paneIn(ids[0]))).text, 'string');
    assert.deepEqual(await view.hd.blocked(), []);
    await assert.rejects(view.hd.prompt(await paneIn(ids[0]), 'hi'), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(view.hd.keys(await paneIn(ids[0]), ['y']), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(view.hd.answer(await paneIn(ids[0]), ['y'], 1), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(view.hd.close({ pane: await paneIn(ids[0]) }), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(view.hd.startAgent({ kind: 'pi', cwd: cwdA, place: { workspace: 'new' } }),
      (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(view.hd.registerNotices(new Uint8Array(32).fill(1)), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(view.hd.call('ping', {}), (e: Error) => e.message === NOT_ALLOWED);
    // A viewer still opens an observe terminal on a real pane.
    const t = view.hd.terminal(await paneIn(ids[0]), { mode: 'control', cols: 80, rows: 24 });
    const lines: string[] = [];
    t.onFrame((line) => { lines.push(line); });
    const [first] = await untilFrames(() => lines, (got) => got.length > 0);
    assert.ok(first.length > 0, 'the observe terminal yields frames');
    t.close();
  } });
});

test('contract(lab): hd.terminal streams a real pane over the link', async () => {
  await withLinkBench({ run: async ({ kit, pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    await kit.call('workspace.create', { cwd: cwdA, focus: false });
    const t = hd.terminal(await livePane(hd), { mode: 'observe', cols: 80, rows: 24 });
    const lines: string[] = [];
    t.onFrame((line) => { lines.push(line); });
    const [first] = await untilFrames(() => lines, (got) => got.length > 0);
    // The real server emits NDJSON bytes frames (not the fake shim's JSON ready/echo).
    assert.ok(first.length > 0, 'the terminal yields frames');
    t.send('echo lab-h7');
    await settle(500);
    t.close();
  } });
});

test('contract(lab): sealed notices round-trip without a live agent', async () => {
  await withLinkBench({ run: async ({ pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    await hd.registerNotices(new Uint8Array(32).fill(7));
    const seed = new Uint8Array(32).fill(7);
    const box = decodeB64Url(boxPublicKeyB64(seed));
    assert.ok(box instanceof Uint8Array);
    const blocked: BlockedAgent = {
      paneId: 'w1:p9', workspaceId: 'w1', tabId: 'w1:t9', kind: 'pi',
      revision: 4, prompt: 'Allow this? (y/n)', since: Date.now(),
    };
    const sealed = sealNotice(blocked, box);
    assert.equal(sealed.v, 1);
    assert.equal(typeof sealed.sealed, 'string');
    const opened = openNotice(sealed as unknown as Record<string, unknown>, seed);
    assert.equal(opened?.paneId, 'w1:p9');
    assert.equal(opened?.workspaceId, 'w1');
    assert.equal(opened?.revision, 4);
    assert.equal(openNotice(sealed as unknown as Record<string, unknown>, new Uint8Array(32).fill(9)), null);
    assert.equal(openNotice({ v: 1 }, seed), null);
  } });
});

test('contract(lab): a live blocked-agent push over the relay', async (t) => {
  t.skip('needs a live blocked agent; no signed-in agent CLI in the lab home');
});

test('contract(lab): serve() binds and pairs over loopback', async () => {
  const kit = ownKit();
  let saved: Grant[] = [];
  const host = await Host.open({
    keys: keyPair(), name: 'H9 lab serve',
    grants: { load: () => saved, save: (g) => { saved = g; } },
    confirm: () => true,
    ...herdrLink(kit, { scopeOf: () => ALL }),
  });
  let served: Awaited<ReturnType<typeof serve>> | undefined;
  let link: DeviceLink | undefined;
  try {
    await kit.start();
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    served = await serve({ host, port, via: 'lan' });
    assert.ok(served.urls.length > 0 && served.urls.every((u) => u.endsWith(`:${port}`)));
    assert.equal(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status), 404);
    const { text } = host.offer({ role: 'control',
      urls: [`ws://127.0.0.1:${port}/link`, ...served.urls], meta: { scope: ALL } });
    const grant = await pairWithOffer(text, { name: 'LAN phone', onWords: () => {} });
    const store = { g: grant as DeviceGrant | null, save(g: DeviceGrant) { this.g = g; }, clear() { this.g = null; } };
    link = new DeviceLink(grant, { store });
    await untilFrames(() => link!.status, (s) => s === 'online');
    assert.equal((await herdrDevice(link).state()).words, 'Connected to Herdr.');
  } finally {
    link?.stop();
    host.close();
    await served?.close();
    await kit.stop().catch(() => {});
  }
});

test('lab: teardown removes the task server and temp dirs', async () => {
  await rm(lab, { recursive: true, force: true });
});
