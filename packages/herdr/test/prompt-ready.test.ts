// Regression: `prompt` reaches an idle agent that was already running when the app connected.
// The snapshot read catches the agent at `unknown` (detection still pending); its move to `idle`
// must land in the kit's tree whether it arrives as a live push or in the gap before the per-pane
// status watch acks — otherwise the readiness gate refuses the prompt forever. Fake only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { socketTransport } from '../src/socket.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import type { HerdrTransport } from '../src/types.ts';

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(ok: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await settle(10);
  }
}

const statusOf = (kit: HerdrKit) => kit.snapshot().workspaces[0]?.tabs[0]?.panes.find((p) => p.id === 'w1:p2')?.agent?.status;

test('a live status push carrying the agent kind reaches the tree and opens the prompt', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-prompt-push') });
  fake.world.agents[0].agent_status = 'unknown';   // running, detection still pending at connect
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    assert.equal(statusOf(kit), 'unknown');
    await assert.rejects(kit.prompt({ paneId: 'w1:p2', name: 'pi' }, 'hi'), { code: 'agent-not-ready' });
    fake.setStatus('w1:p2', 'idle');   // the schema-shaped frame carries `agent: 'pi'` beside the status
    await until(() => statusOf(kit) === 'idle', 'the push lands in the tree');
    const receipt = await kit.prompt({ paneId: 'w1:p2', name: 'pi' }, 'hi');
    assert.equal(receipt.paneId, 'w1:p2');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a status change between the snapshot read and the watch ack is caught up', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-prompt-gap') });
  fake.world.agents[0].agent_status = 'unknown';
  const real = socketTransport(fake.socketPath);
  // The agent settles after the snapshot read but before its watch is registered: no socket sees it.
  const transport: HerdrTransport = {
    call: (method, params, timeoutMs) => real.call(method, params, timeoutMs),
    subscribe: (subs, on, onError) => {
      if (subs.some((s) => s.type === 'pane.agent_status_changed')) fake.setStatus('w1:p2', 'idle');
      return real.subscribe(subs, on, onError);
    },
    close: () => real.close(),
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport });
  try {
    await kit.start();
    await kit.statusWatchReady();
    assert.equal(statusOf(kit), 'idle', 'the watch ack re-reads the status it could have missed');
    const receipt = await kit.prompt({ paneId: 'w1:p2', name: 'pi' }, 'hi');
    assert.equal(receipt.paneId, 'w1:p2');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

// Regression (0.1.2): real Herdr v0.9.1 reports `interactive_ready: true` only for an agent its own
// `agent.start` launched and settled; an agent already running in a pane the app adopts (started by
// hand, or by another client) reads `interactive_ready: false, launch_pending: false` for its whole
// life, and Herdr's own `agent.prompt` accepts it. `launch_pending` rides reads only — never a status
// push — so a snapshot taken mid-launch stays `true` in the tree after the launch settles.
const pane = { paneId: 'w1:p2', name: 'pi' };

test('an agent already running and idle before connect takes a prompt', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-prompt-adopted') });
  Object.assign(fake.world.agents[0], { agent_status: 'idle', interactive_ready: false, launch_pending: false });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    const receipt = await kit.prompt(pane, 'hi');
    assert.equal(receipt.paneId, 'w1:p2');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a launch still pending at the snapshot read opens once it settles, with no push', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-prompt-pending') });
  const agent = fake.world.agents[0];
  Object.assign(agent, { agent_status: 'idle', interactive_ready: false, launch_pending: true });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    await assert.rejects(kit.prompt(pane, 'hi'), { code: 'agent-not-ready' }, 'still pending: refused');
    assert.equal(agent.agent_status, 'idle', 'the refusal queued nothing');
    Object.assign(agent, { interactive_ready: true, launch_pending: false });   // Herdr settles silently
    const receipt = await kit.prompt(pane, 'hi');
    assert.equal(receipt.paneId, 'w1:p2');
    const cached = kit.snapshot().workspaces[0]?.tabs[0]?.panes.find((p) => p.id === 'w1:p2')?.agent;
    assert.equal(cached?.launchPending, false, 'the fresh read replaces the stale flag in the tree');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a reconnect snapshot taken mid-launch does not stick the prompt gate', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-prompt-reconnect') });
  const agent = fake.world.agents[0];
  const real = socketTransport(fake.socketPath);
  const reconnects: (() => void)[] = [];
  const transport: HerdrTransport = {
    call: (method, params, timeoutMs) => real.call(method, params, timeoutMs),
    subscribe: (subs, on, onError) => {
      const stop = real.subscribe(subs, on, onError);
      const onReconnect = (fn: () => void) => { reconnects.push(fn); };
      return Object.assign(stop, { onReconnect });
    },
    close: () => real.close(),
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, transport });
  try {
    await kit.start();
    await kit.statusWatchReady();
    Object.assign(agent, { interactive_ready: false, launch_pending: true });
    const before = fake.snapshotCount();
    for (const fn of reconnects) fn();
    await until(() => fake.snapshotCount() > before, 'the reconnect re-reads the snapshot');
    await until(() => kit.snapshot().workspaces[0]?.tabs[0]?.panes.find((p) => p.id === 'w1:p2')?.agent?.launchPending === true,
      'the mid-launch snapshot lands');
    Object.assign(agent, { interactive_ready: true, launch_pending: false });
    const receipt = await kit.prompt(pane, 'hi');
    assert.equal(receipt.paneId, 'w1:p2');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a snapshot at unknown whose idle reached no socket is re-read before refusing', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-prompt-unknown') });
  const agent = fake.world.agents[0];
  agent.agent_status = 'unknown';
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    await kit.statusWatchReady();
    assert.equal(statusOf(kit), 'unknown');
    agent.agent_status = 'idle';   // the push was lost: only a read sees it
    const receipt = await kit.prompt(pane, 'hi');
    assert.equal(receipt.paneId, 'w1:p2');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});
