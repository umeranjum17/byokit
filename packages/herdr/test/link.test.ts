// H7 acceptance (docs/runtime-kits.md 11.3, behavior 7.1-7.3) for src/link.ts: every hd.* op round-trips over a
// real Host + DeviceLink pair on loopback against startFakeHerdr; view grants are refused on non-view ops with the
// link.notAllowed sentence; scope is enforced per workspace list; hd.call is default-denied; hd.terminal
// round-trips frames both ways against the fake bin; a blocked agent produces a sealed notice; serve() binds per
// the reach result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  DeviceLink, Host, keyPair, pairWithOffer,
  type DeviceGrant, type Grant,
} from '@byokit/link';
import type { RelayClient } from '@byokit/relay';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL, HERDR_VERSION } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { herdrLink, serve, type HerdrScope } from '../src/link.ts';
import { herdrDevice } from '../src/device.ts';
import { openNotice } from '../src/notices.ts';
import { words } from '../src/words.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';

const NOT_ALLOWED = words('link.notAllowed');

const until = async <T>(probe: () => T | Promise<T>, ok: (value: T) => boolean, ms = 5000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (ok(value)) return value;
    if (Date.now() > deadline) assert.fail('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const scopeOf = (grant: Grant): HerdrScope =>
  (grant.meta as { scope?: HerdrScope } | undefined)?.scope ?? { workspaces: [] };

type Bench = {
  kit: HerdrKit; fake: FakeHerdr; host: Host; url: string;
  pair: (role: 'control' | 'view', scope: HerdrScope, name: string) =>
    Promise<{ hd: ReturnType<typeof herdrDevice>; link: DeviceLink; grant: DeviceGrant }>;
};

async function withBench(o: {
  passThrough?: (method: string, grant: Grant) => boolean;
  relay?: RelayClient;
  run: (b: Bench) => Promise<void>;
}): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir('h7-link') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  const links: DeviceLink[] = [];
  let saved: Grant[] = [];
  let host: Host | undefined;
  let server: ReturnType<typeof createServer> | undefined;
  let wss: WebSocketServer | undefined;
  const sockets = new Set<WsSocket>();
  try {
    await kit.start();
    host = await Host.open({
      keys: keyPair(), name: 'H7 bench',
      grants: { load: () => saved, save: (g) => { saved = g; } },
      confirm: () => true,
      ...herdrLink(kit, { scopeOf, ...(o.passThrough ? { passThrough: o.passThrough } : {}), ...(o.relay ? { relay: o.relay } : {}) }),
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
      await until(() => link.status, (s) => s === 'online');
      return { hd: herdrDevice(link), link, grant };
    };
    await o.run({ kit, fake, host, url, pair });
  } finally {
    for (const link of links) link.stop();
    host?.close();
    for (const s of sockets) s.terminate();
    if (wss) await new Promise<void>((r) => wss!.close(() => r()));
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await kit.stop().catch(() => {});
    await fake.stop();
  }
}

const ALL: HerdrScope = { workspaces: 'all' };

test('every op round-trips for a control device with full scope', async () => {
  await withBench({ run: async ({ kit, fake, pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    const state = await hd.state();
    assert.equal(state.state.phase, 'ready');
    assert.equal(state.words, 'Connected to Herdr.');
    const tree = await hd.tree();
    assert.deepEqual(tree.workspaces.map((w) => w.id), ['w1']);
    assert.deepEqual(tree.workspaces[0].tabs[0].panes.map((p) => p.id), ['w1:p1', 'w1:p2']);
    const read = await hd.read('w1:p1');
    assert.equal(typeof read.text, 'string');
    assert.equal(typeof read.truncated, 'boolean');
    const receipt = await hd.prompt('w1:p2', 'hello link');
    assert.equal(receipt.paneId, 'w1:p2');
    assert.equal(typeof receipt.revision, 'number');
    await hd.keys('w1:p2', ['x']);
    assert.deepEqual(await hd.blocked(), []);
    // A stuck agent is a question; the answer is keys to that exact revision.
    await hd.prompt('w1:p2', 'ask permission');
    const [entry] = await until(() => hd.blocked(), (list) => list.length === 1);
    assert.equal(entry.paneId, 'w1:p2');
    assert.match(entry.prompt, /Allow this/);
    await assert.rejects(hd.answer('w1:p2', ['y'], entry.revision + 1000), /That question already changed/);
    await hd.answer('w1:p2', ['y'], entry.revision);
    await until(() => hd.blocked(), (list) => list.length === 0);
    // New workspaces are creatable; the only tab refuses a widening close.
    const placed = await hd.startAgent({ kind: 'pi', cwd: '/tmp', place: { workspace: 'new', label: 'side' } });
    assert.match(placed.paneId, /^w2:/);
    // The fake does not broadcast creates, so surface the new workspace the way a live
    // server would, then wait for the kit's refresh to publish it.
    fake.emit({ type: 'workspace.created', workspace_id: 'w2' });
    const grown = await until(() => hd.tree(), (t) => t.workspaces.length === 2);
    assert.deepEqual(grown.workspaces.map((w) => w.id).sort(), ['w1', 'w2']);
    await assert.rejects(hd.close({ tab: 'w1:t1' }));
    assert.equal(kit.snapshot().workspaces.length, 2, 'the refused close changed nothing');
    // Pass-through is denied by default (D8).
    await assert.rejects(hd.call('ping', {}), (e: Error) => e.message === NOT_ALLOWED);
  } });
});

test('hd.call opens when the pass-through predicate allows it', async () => {
  await withBench({
    passThrough: (method) => method === 'ping',
    run: async ({ pair }) => {
      const { hd } = await pair('control', ALL, 'desk');
      assert.deepEqual(await hd.call('ping', {}), { protocol: HERDR_PROTOCOL, version: HERDR_VERSION });
      await assert.rejects(hd.call('session.snapshot', {}), (e: Error) => e.message === NOT_ALLOWED);
    },
  });
});

test('a view grant reads and observes but cannot prompt, keys, answer or close', async () => {
  await withBench({ run: async ({ pair }) => {
    const { hd } = await pair('view', ALL, 'phone');
    assert.equal((await hd.state()).state.phase, 'ready');
    assert.deepEqual((await hd.tree()).workspaces.map((w) => w.id), ['w1']);
    assert.equal(typeof (await hd.read('w1:p1')).text, 'string');
    assert.deepEqual(await hd.blocked(), []);
    await assert.rejects(hd.prompt('w1:p2', 'hi'), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(hd.keys('w1:p2', ['y']), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(hd.answer('w1:p2', ['y'], 1), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(hd.close({ pane: 'w1:p1' }), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(hd.startAgent({ kind: 'pi', cwd: '/tmp', place: { workspace: 'new' } }),
      (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(hd.registerNotices(new Uint8Array(32).fill(1)), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(hd.call('ping', {}), (e: Error) => e.message === NOT_ALLOWED);
    // The events stream still opens for a viewer.
    const frames: unknown[] = [];
    for await (const frame of hd.events()) {
      frames.push(frame);
      break;
    }
    assert.equal((frames[0] as { type: string }).type, 'snapshot');
    // A viewer asking for control gets observe only.
    const t = hd.terminal('w1:p1', { mode: 'control', cols: 80, rows: 24 });
    const lines: string[] = [];
    t.onFrame((line) => { lines.push(line); });
    const [ready] = await until(() => lines, (got) => got.length > 0);
    assert.equal((JSON.parse(ready) as { mode: string }).mode, 'observe');
    t.close();
  } });
});

test('scope is enforced per workspace list', async () => {
  await withBench({ run: async ({ fake, pair }) => {
    const narrow = await pair('control', { workspaces: ['w1'] }, 'narrow');
    const wide = await pair('control', ALL, 'wide');
    const placed = await wide.hd.startAgent({ kind: 'pi', cwd: '/tmp', place: { workspace: 'new', label: 'other' } });
    const outside = placed.paneId;
    // The fake does not broadcast creates, so surface the new workspace the way a live
    // server would, then wait for the kit's refresh to publish it.
    fake.emit({ type: 'workspace.created', workspace_id: outside.split(':')[0] });
    await until(() => wide.hd.tree(), (t) => t.workspaces.some((w) =>
      w.tabs.some((tab) => tab.panes.some((p) => p.id === outside))));
    assert.deepEqual((await narrow.hd.tree()).workspaces.map((w) => w.id), ['w1']);
    await assert.rejects(narrow.hd.prompt(outside, 'hi'), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(narrow.hd.read(outside), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(narrow.hd.keys(outside, ['y']), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(narrow.hd.answer(outside, ['y'], 1), (e: Error) => e.message === NOT_ALLOWED);
    // Blocked entries outside scope stay hidden.
    await wide.hd.prompt(outside, 'ask permission');
    await until(() => wide.hd.blocked(), (list) => list.length === 1);
    assert.deepEqual(await narrow.hd.blocked(), []);
    const [entry] = await wide.hd.blocked();
    await assert.rejects(narrow.hd.answer(outside, ['y'], entry.revision), (e: Error) => e.message === NOT_ALLOWED);
    await wide.hd.answer(outside, ['y'], entry.revision);
    await until(() => wide.hd.blocked(), (list) => list.length === 0);
  } });
});

test('hd.terminal round-trips frames both ways against the fake bin', async () => {
  await withBench({ run: async ({ pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    const t = hd.terminal('w1:p1', { mode: 'control', cols: 80, rows: 24 });
    const lines: string[] = [];
    t.onFrame((line) => { lines.push(line); });
    const frames = await until(() => lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }), (got) => got.length > 0 && got[0] !== null);
    assert.equal(frames[0].type, 'terminal.ready');
    assert.equal(frames[0].mode, 'control');
    t.send('hello-terminal');
    await until(() => lines.map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }), (got) => got.some((f) => f?.type === 'terminal.frame' && f?.data === 'hello-terminal'));
    t.close();
  } });
});

test('a prompt to a pane with no ready agent says so in the kit\'s words', async () => {
  await withBench({ run: async ({ pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    await assert.rejects(hd.prompt('w1:p1', 'hi'), (e: Error) => e.message === words('agent.notReady'));
  } });
});

test('a blocked agent produces a sealed notice the relay carries blind', async () => {
  const sent: { n: Record<string, unknown> }[] = [];
  const relay = { notify: async (n: Record<string, unknown>) => { sent.push({ n }); return { sent: 1 }; } } as unknown as RelayClient;
  await withBench({ relay, run: async ({ pair }) => {
    const seed = new Uint8Array(32).fill(3);
    const { hd } = await pair('control', ALL, 'desk');
    await hd.registerNotices(seed);
    await hd.prompt('w1:p2', 'ask permission');
    const [note] = await until(() => sent, (got) => got.length === 1);
    assert.equal(note.n.title, words('agent.blocked'), 'the relay reads only the generic title');
    const data = note.n.data as Record<string, unknown>;
    assert.equal(data.v, 1);
    assert.equal(typeof data.sealed, 'string');
    const opened = openNotice(data, seed);
    assert.equal(opened?.paneId, 'w1:p2');
    assert.equal(opened?.workspaceId, 'w1');
    assert.match(opened?.prompt ?? '', /Allow this/);
    assert.equal(openNotice(data, new Uint8Array(32).fill(9)), null, 'a wrong seed opens nothing');
    assert.ok(Array.isArray(note.n.to) && (note.n.to as unknown[]).length === 1, 'the push names its device');
  } });
});

test('hd.events streams snapshot deltas and blocked add/resolve', async () => {
  await withBench({ run: async ({ pair }) => {
    const { hd } = await pair('control', ALL, 'desk');
    const seen: { type: string; change?: string }[] = [];
    const done = (async () => {
      for await (const frame of hd.events()) {
        const f = frame as { type: string; change?: string };
        seen.push({ type: f.type, ...(f.change ? { change: f.change } : {}) });
        if (seen.some((s) => s.type === 'blocked' && s.change === 'added') &&
            seen.some((s) => s.type === 'blocked' && s.change === 'resolved')) break;
      }
    })();
    await until(() => seen, (got) => got.some((s) => s.type === 'snapshot'));
    await hd.prompt('w1:p2', 'ask permission');
    const [entry] = await until(() => hd.blocked(), (list) => list.length === 1);
    await hd.answer('w1:p2', ['n'], entry.revision);
    await done;
    assert.ok(seen.some((s) => s.type === 'blocked' && s.change === 'added'));
    assert.ok(seen.some((s) => s.type === 'blocked' && s.change === 'resolved'));
  } });
});

test('hd.kinds, hd.wait and hd.subscribe round-trip with view/control and scope rules', async () => {
  await withBench({ run: async ({ kit, fake, pair }) => {
    const narrow = await pair('control', { workspaces: ['w1'] }, 'narrow');
    const wide = await pair('control', ALL, 'wide');
    const viewer = await pair('view', { workspaces: ['w1'] }, 'viewer');
    // Kinds are a view op with no scope: the kind picker's list (8).
    const kinds = await kit.agentKinds();
    assert.ok(kinds.length > 0);
    assert.deepEqual(await viewer.hd.agentKinds(), kinds);
    // Wait needs control and an in-scope pane.
    const status = await narrow.hd.wait('w1:p2', { until: ['idle', 'working', 'blocked', 'done', 'unknown'], timeoutMs: 2000 });
    assert.ok(['idle', 'working', 'blocked', 'done', 'unknown'].includes(status));
    await assert.rejects(viewer.hd.wait('w1:p2', { timeoutMs: 100 }), (e: Error) => e.message === NOT_ALLOWED);
    await assert.rejects(narrow.hd.wait('w1:p2', { timeoutMs: 0 }));
    await assert.rejects(narrow.hd.wait('w1:p2', { until: ['nope' as never], timeoutMs: 100 }));
    const placed = await wide.hd.startAgent({ kind: 'pi', cwd: '/tmp', place: { workspace: 'new', label: 'other' } });
    const outside = placed.paneId;
    const other = outside.split(':')[0];
    fake.emit({ type: 'workspace.created', workspace_id: other });
    await until(() => wide.hd.tree(), (t) => t.workspaces.some((w) => w.id === other));
    await assert.rejects(narrow.hd.wait(outside, { timeoutMs: 100 }), (e: Error) => e.message === NOT_ALLOWED);
    // A subscribe filter naming an out-of-scope pane is refused with the kit's sentence.
    const refused: string[] = [];
    narrow.hd.subscribe([{ type: 'pane.scroll_changed', pane_id: outside }], () => {}, (m) => { refused.push(m); });
    await until(() => refused, (got) => got.length === 1);
    assert.deepEqual(refused, [NOT_ALLOWED]);
    // A viewer may subscribe; a scoped grant sees only events whose every workspace is in scope.
    const narrowSeen: string[] = [];
    const wideSeen: string[] = [];
    const stopNarrow = viewer.hd.subscribe([{ type: 'workspace.renamed' }], (e) => { narrowSeen.push(e.workspace_id); });
    const stopWide = wide.hd.subscribe([{ type: 'workspace.renamed' }], (e) => { wideSeen.push(e.workspace_id); });
    await until(() => {
      fake.emit({ type: 'workspace.renamed', workspace_id: other, label: 'x' });
      fake.emit({ type: 'workspace.renamed', workspace_id: 'w1', label: 'y' });
      return narrowSeen.length > 0 && wideSeen.includes(other);
    }, (ok) => ok);
    assert.ok(narrowSeen.every((id) => id === 'w1'), 'no out-of-scope workspace reaches a scoped grant');
    stopNarrow();
    stopWide();
    // A batch Herdr rejects ends the stream, so the device hears it instead of waiting forever.
    const rejected: string[] = [];
    viewer.hd.subscribe([{ type: 'pane.agent_status_changed' } as never], () => {}, (m) => { rejected.push(m); });
    await until(() => rejected, (got) => got.length === 1);
    assert.match(rejected[0], /subscription rejected/);
    // Pass-through stays default-denied (D8).
    await assert.rejects(viewer.hd.call('server.agent_manifests', {}), (e: Error) => e.message === NOT_ALLOWED);
  } });
});

test('hd.subscribe ends when the kit stops, so the device can subscribe again', async () => {
  await withBench({ run: async ({ kit, pair }) => {
    const { hd } = await pair('view', ALL, 'viewer');
    const ended: string[] = [];
    hd.subscribe([{ type: 'workspace.renamed' }], () => {}, (m) => { ended.push(m); });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(ended, []);
    await kit.stop();
    await until(() => ended, (got) => got.length === 1);
    assert.match(ended[0], /disconnected/);
  } });
});

test('serve() binds per the reach result and pairs a device through it', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('h7-serve') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  let saved: Grant[] = [];
  const host = await Host.open({
    keys: keyPair(), name: 'Served',
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
    assert.equal(served.ingress, undefined, 'a LAN serve sets no ingress');
    // Plain HTTP on the same port answers 404 when no handler is given.
    assert.equal(await fetch(`http://127.0.0.1:${port}/`).then((r) => r.status), 404);
    // The printed urls name the LAN, but the loopback route reaches the same server (and keeps
    // the isolated test run off non-loopback connects).
    const { text } = host.offer({ role: 'control', urls: [`ws://127.0.0.1:${port}/link`, ...served.urls], meta: { scope: ALL } });
    const grant = await pairWithOffer(text, { name: 'LAN phone', onWords: () => {} });
    const store = { g: grant as DeviceGrant | null, save(g: DeviceGrant) { this.g = g; }, clear() { this.g = null; } };
    link = new DeviceLink(grant, { store });
    await until(() => link!.status, (s) => s === 'online');
    assert.equal((await herdrDevice(link).state()).words, 'Connected to Herdr.');
  } finally {
    link?.stop();
    host.close();
    await served?.close();
    await kit.stop().catch(() => {});
    await fake.stop();
  }
});
