// H5 acceptance (docs/runtime-kits.md 11.2, behavior 6.4) for src/agents.ts: startAgent in all four
// placements plus worktree takes the served pane id, the schema's exact agent.start params ride the
// call, prompt receipt validation (each malformed field variant from muxr's check rejected), a
// not-promptable agent refused without a socket call, `agent_blocked` mapped, wait/read/sendKeys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import type { HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';

const until = async <T>(probe: () => T, ok: (value: T) => boolean, ms = 3000): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (ok(value)) return value;
    if (Date.now() > deadline) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function withKit(run: (kit: HerdrKit, fake: FakeHerdr) => Promise<void>, name = 'h5-agents'): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir(name) });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try { await kit.start(); await run(kit, fake); }
  finally { await kit.stop(); await fake.stop(); }
}

type Call = { method: string; params: Record<string, unknown>; timeoutMs?: number };

/** A scripted transport over a snapshot with one pane (`w1:p2`), recording every call. */
function doubleKit(o: { agents?: unknown[]; answer: (method: string, params: Record<string, unknown>) => unknown }): {
  kit: HerdrKit; calls: Call[];
} {
  const calls: Call[] = [];
  const transport: HerdrTransport = {
    call: async (method, params, timeoutMs) => {
      calls.push({ method, params, timeoutMs });
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') {
        return { snapshot: {
          workspaces: [{ workspace_id: 'w1', label: 'x' }],
          tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
          panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }],
          agents: o.agents ?? [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1 }],
        } };
      }
      return o.answer(method, params);
    },
    subscribe: () => (() => {}) as HerdrSubscribeStop,
    close: () => {},
  };
  return { kit: new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/not/used', transport }), calls };
}

test('startAgent returns the served pane id in every placement, worktree included', async () => {
  await withKit(async (kit) => {
    const start = (place: Parameters<HerdrKit['startAgent']>[0]['place'],
      extra: Partial<Parameters<HerdrKit['startAgent']>[0]> = {}) =>
      kit.startAgent({ kind: 'pi', cwd: '/tmp/h5', place, ...extra } as Parameters<HerdrKit['startAgent']>[0]);
    const taken = new Set(['w1:p1', 'w1:p2']);
    const ws = await start({ workspace: 'new' });
    const tab = await start({ tab: 'new', workspaceId: 'w1' });
    const split = await start({ split: 'w1:p1', direction: 'right' });
    const pane = await start({ pane: 'w1:p1' });
    const tree = await start({ workspace: 'new' }, { worktree: { branch: 'h5' } });
    for (const [label, ref] of [['workspace', ws], ['tab', tab], ['split', split], ['worktree', tree]] as const) {
      assert.match(ref.paneId, /^w\d+:p\d+$/, `${label} placement gets a live-shaped pane id`);
      assert.ok(!taken.has(ref.paneId), `${label} placement never predicts an existing pane id`);
      taken.add(ref.paneId);
    }
    assert.equal(pane.paneId, 'w1:p1', 'the pane placement uses the pane as given');
    assert.equal(typeof ws.name, 'string');
    // the worktree agent lands in the linked checkout, not the source cwd
    const paneInfo = (await kit.call('pane.get', { pane_id: tree.paneId })) as { pane?: { cwd?: string; workspace_id?: string } };
    const workspaceId = paneInfo.pane?.workspace_id;
    assert.equal(typeof workspaceId, 'string');
    const wsInfo = (await kit.call('workspace.get', { workspace_id: workspaceId! })) as
      { workspace?: { worktree?: { checkout_path?: string } } };
    assert.equal(paneInfo.pane?.cwd, wsInfo.workspace?.worktree?.checkout_path);
  }, 'h5-place');
});

test('agent.start carries the schema params; env belongs to the placement, the timeout rides the call', async () => {
  const { kit, calls } = doubleKit({
    answer: (method) => (method === 'workspace.create' ? { workspace: {}, root_pane: { pane_id: 'w9:p1' } } : { agent: {} }),
  });
  try {
    await kit.start();
    await kit.startAgent({ kind: 'pi', cwd: '/repo', place: { workspace: 'new' },
      args: ['--demo'], env: { K: 'v' }, timeoutMs: 30_000 });
    const start = calls.filter((c) => c.method === 'agent.start');
    assert.equal(start.length, 1);
    assert.deepEqual(start[0].params, { pane_id: 'w9:p1', kind: 'pi', name: 'pi', args: ['--demo'], timeout_ms: 30_000 });
    assert.equal(start[0].timeoutMs, 35_000, 'the start call gets timeoutMs + 5 s');
    assert.deepEqual(calls.find((c) => c.method === 'workspace.create')?.params,
      { cwd: '/repo', focus: false, env: { K: 'v' } });
    // a missing name derives one from the kind
    await kit.startAgent({ kind: 'Codex CLI', cwd: '/repo', place: { pane: 'w9:p1' } });
    assert.deepEqual(calls.filter((c) => c.method === 'agent.start')[1]?.params,
      { pane_id: 'w9:p1', kind: 'Codex CLI', name: 'codex-cli', timeout_ms: 60_000 });
  } finally { await kit.stop(); }
});

const goodReceipt = { type: 'agent_prompted', agent: {
  terminal_id: 't1', agent_status: 'working', workspace_id: 'w1', tab_id: 'w1:t1',
  pane_id: 'w1:p2', focused: false, revision: 1 } };

test('prompt maps a good receipt to the kit shape', async () => {
  const { kit } = doubleKit({ answer: (method) => (method === 'agent.prompt' ? goodReceipt : {}) });
  try {
    await kit.start();
    const receipt = await kit.prompt({ paneId: 'w1:p2' }, 'hi');
    assert.deepEqual(receipt, { paneId: 'w1:p2', terminalId: 't1', revision: 1, status: 'working' });
  } finally { await kit.stop(); }
});

test('prompt rejects every malformed receipt field variant', async () => {
  const agent = goodReceipt.agent as Record<string, unknown>;
  const variants: unknown[] = [
    { type: 'nonsense', agent: { ...agent } },      // wrong result type
    { type: 'agent_prompted' },                     // agent missing
    { type: 'agent_prompted', agent: { ...agent, terminal_id: 9 } },
    { type: 'agent_prompted', agent: { ...agent, agent_status: 9 } },
    { type: 'agent_prompted', agent: { ...agent, workspace_id: undefined } },
    { type: 'agent_prompted', agent: { ...agent, tab_id: 9 } },
    { type: 'agent_prompted', agent: { ...agent, pane_id: 'w1:p1' } },   // not the target
    { type: 'agent_prompted', agent: { ...agent, focused: 'no' } },
    { type: 'agent_prompted', agent: { ...agent, revision: '1' } },
    { type: 'agent_prompted', agent: { ...agent, revision: -1 } },
    { type: 'agent_prompted', agent: { ...agent, revision: 1.5 } },
  ];
  for (const [i, answer] of variants.entries()) {
    const { kit } = doubleKit({ answer: (method) => (method === 'agent.prompt' ? answer : {}) });
    try {
      await kit.start();
      await assert.rejects(kit.prompt({ paneId: 'w1:p2' }, 'x'), /did not queue/, `variant ${i}`);
    } finally { await kit.stop(); }
  }
});

test('a not-promptable agent is refused with no agent.prompt call', async () => {
  for (const agents of [
    [],                                                                   // no agent at all
    [{ pane_id: 'w1:p2', agent_status: 'unknown', revision: 1 }],         // unknown status
    [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1, launch_pending: true }],
    [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1, interactive_ready: false }],
  ]) {
    const { kit, calls } = doubleKit({ agents, answer: () => ({}) });
    try {
      await kit.start();
      await assert.rejects(kit.prompt({ paneId: 'w1:p2' }, 'x'),
        (e: { code?: string }) => e.code === 'agent-not-ready');
      assert.equal(calls.some((c) => c.method === 'agent.prompt'), false, 'no socket call for the refusal');
    } finally { await kit.stop(); }
  }
});

test('a server agent_blocked refusal maps to agent-blocked', async () => {
  const { kit } = doubleKit({ answer: (method) => {
    if (method === 'agent.prompt') throw Object.assign(new Error('herdr: agent_blocked: no'), { code: 'agent_blocked' });
    return {};
  } });
  try {
    await kit.start();
    await assert.rejects(kit.prompt({ paneId: 'w1:p2' }, 'x'), (e: { code?: string }) => e.code === 'agent-blocked');
  } finally { await kit.stop(); }
});

test('prompt queues, appends the reply and waits; reads unwrap and keys land', async () => {
  await withKit(async (kit) => {
    const receipt = await kit.prompt({ paneId: 'w1:p2' }, 'hello world');
    // ponytail note: the fake's two world panes share one `text` array (world.ts shallow spread), so
    // p1's exact text is only asserted before any prompt; H9's fake pass should give agentPane its own.
    assert.deepEqual(await kit.read('w1:p1'), { text: 'ready.', truncated: false });
    assert.equal(receipt.paneId, 'w1:p2');
    assert.equal(typeof receipt.terminalId, 'string');
    assert.equal(receipt.status, 'working');
    assert.ok(receipt.revision >= 1);
    assert.equal(await kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 }), 'idle');
    assert.match((await kit.read('w1:p2')).text, /fake pi: hello world/);
    assert.equal((await kit.read('w1:p2', { source: 'detection' })).text, '', 'an unblocked agent has no detection text');
    await kit.sendKeys({ paneId: 'w1:p2' }, ['ok']);
    assert.match((await kit.read('w1:p2')).text, /ok/);
    const started = Date.now();
    assert.equal(await kit.wait({ paneId: 'w1:p2' }, { until: ['done'], timeoutMs: 60 }), 'idle',
      'the deadline returns the current status');
    assert.ok(Date.now() - started < 2000, 'the wait honors its timeout instead of hanging');
  }, 'h5-prompt');
});

test('agentKinds reads the manifests and installedAgentKinds checks the given dirs', async () => {
  await withKit(async (kit) => {
    assert.deepEqual(await kit.agentKinds(), ['pi']);
    const dir = scratchDir('h5-bin');
    writeFileSync(join(dir, 'pi'), '#!/bin/sh\n');
    chmodSync(join(dir, 'pi'), 0o700);
    writeFileSync(join(dir, 'plain'), 'x');                  // present but not executable
    chmodSync(join(dir, 'plain'), 0o600);
    assert.deepEqual(kit.installedAgentKinds(['pi', 'plain', 'missing'], { path: [dir] }), ['pi']);
  }, 'h5-kinds');
});

test('installedAgentKinds counts a kind installed when only its alias is on the path', async () => {
  await withKit(async (kit) => {
    const dir = scratchDir('k9-bin');
    writeFileSync(join(dir, 'cursor-agent'), '#!/bin/sh\n');
    chmodSync(join(dir, 'cursor-agent'), 0o700);
    // acceptance: kind `cursor` with `{ cursor: ['cursor-agent'] }` and only `cursor-agent` on the
    // path returns `['cursor']`
    assert.deepEqual(kit.installedAgentKinds(['cursor'], { path: [dir], aliases: { cursor: ['cursor-agent'] } }), ['cursor']);
    // no aliases passed: the bare kind name still decides, as before
    assert.deepEqual(kit.installedAgentKinds(['cursor'], { path: [dir] }), []);
    // an alias listed under another kind does not leak across kinds
    assert.deepEqual(kit.installedAgentKinds(['cursor', 'other'], { path: [dir], aliases: { other: ['cursor-agent'] } }), ['other']);
  }, 'k9-aliases');
});
