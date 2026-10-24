// H5 acceptance (docs/runtime-kits.md 11.2, behavior 6.4) for src/agents.ts: startAgent in all four
// placements plus worktree takes the served pane id, the receipt carries the responding conversation,
// `agent_blocked` mapped, wait/read/sendKeys.
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
      kit.startAgent({ kind: 'codex', cwd: '/tmp/h5', place, ...extra } as Parameters<HerdrKit['startAgent']>[0]);
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

const goodReceipt = { type: 'agent_prompted', agent: {
  terminal_id: 't1', agent_status: 'working', workspace_id: 'w1', tab_id: 'w1:t1',
  pane_id: 'w1:p2', focused: false, revision: 1 } };

test('prompt carries the responding conversation without another read', async () => {
  for (const agentSession of [
    { source: 'herdr', agent: 'codex', kind: 'id', value: 'new-generation' },
    { source: 'herdr', agent: 'pi', kind: 'path', value: '/conversation.jsonl' },
    null, undefined,
  ]) {
    const { kit, calls } = doubleKit({ answer: (method) => method === 'agent.prompt'
      ? { ...goodReceipt, agent: { ...goodReceipt.agent, agent_session: agentSession } } : {} });
    try {
      await kit.start();
      const before = calls.length;
      const receipt = await kit.prompt({ paneId: 'w1:p2' }, 'hi');
      assert.deepEqual(receipt, { paneId: 'w1:p2', terminalId: 't1', revision: 1, status: 'working',
        ...(agentSession == null ? {} : { agentSession }) });
      assert.deepEqual(calls.slice(before).map((call) => call.method), ['agent.prompt']);
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

test('sendKeys reaches a shell pane through pane.send_keys', async () => {
  await withKit(async (kit, fake) => {
    // w1:p1 is the world's plain shell: no agent record, so agent.send_keys refuses and the
    // kit falls back to the pane's own key path (muxr's abort route).
    await kit.sendKeys({ paneId: 'w1:p1' }, ['ls\r']);
    assert.equal(fake.world.panes.find((p) => p.pane_id === 'w1:p1')?.text.at(-1), 'ls\r');
    // An agent pane still rides agent.send_keys.
    await kit.sendKeys({ paneId: 'w1:p2' }, ['ok']);
    assert.equal(fake.world.panes.find((p) => p.pane_id === 'w1:p2')?.text.at(-1), 'ok');
    // A gone pane surfaces the pane error instead of pretending to deliver.
    await assert.rejects(kit.sendKeys({ paneId: 'w9:p9' }, ['x']), (e: { code?: string }) => e.code === 'pane_not_found');
  }, 'h5-keys-shell');
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
