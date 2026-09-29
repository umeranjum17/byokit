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
