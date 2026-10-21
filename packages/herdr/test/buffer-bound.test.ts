// The kit's readiness settles and its bootstrap buffer is bounded: a status watch refused with
// Herdr's own probe id (`<id>:sub:0:probe`), a subscription that is stopped, and a watch that is
// never acknowledged while events keep arriving (the growing backlog on muxr's host) — all against
// the kit fake, never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';

// The kit's own caps (packages/herdr/src/kit.ts `BUFFER_LIMITS`): the test names them so a cap
// that grows past the bound this journey proved fails here instead of passing quietly.
const BUFFER_CAP = { events: 512, bytes: 2 * 1024 * 1024 };

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(ok: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail('condition not reached in time');
    await settle(10);
  }
}

function agentPaneId(kit: HerdrKit): string {
  const pane = kit.snapshot().workspaces.flatMap((w) => w.tabs).flatMap((t) => t.panes).find((p) => p.agent !== undefined);
  assert.ok(pane, 'the fake seeds an agent pane');
  return pane.id;
}

test("a status watch refused with Herdr's probe id settles the readiness and the refresh finishes", async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-probe-refusal') });
  const logs: string[] = [];
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath, onLog: (line) => logs.push(line) });
  try {
    await kit.start();
    // Herdr answers a refused per-subscription probe with the request id plus its own suffix.
    fake.rejectWatch(agentPaneId(kit), 'probe');
    await Promise.race([
      kit.refresh(),
      settle(3000).then(() => assert.fail('the refresh waits on the refused status watch')),
    ]);
    assert.ok(logs.some((line) => line.includes('pane_not_found')), 'the refusal is logged with its code');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a subscription refused with the probe id settles its ready promise false', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-probe-ready') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    fake.rejectWatch('w1:p2', 'probe');
    const errors: { code: string; message: string }[] = [];
    const stop = kit.subscribe([{ type: 'pane.agent_status_changed', pane_id: 'w1:p2' }], () => {},
      (code, message) => errors.push({ code, message }));
    const ready = await Promise.race([stop.ready, settle(3000).then(() => undefined)]);
    assert.equal(ready, false, 'the refused subscription settles its readiness');
    assert.deepEqual(errors.map((e) => e.code), ['pane_not_found'], 'the refusal reaches the subscriber');
    stop();
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('a stopped subscription settles its ready promise false', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-stop-ready') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    // The server takes the subscription and never answers it; the caller stops it instead.
    fake.holdAck();
    const stop = kit.subscribe([{ type: 'pane.created' }], () => {});
    stop();
    const ready = await Promise.race([stop.ready, settle(3000).then(() => undefined)]);
    assert.equal(ready, false, 'a stopped subscription settles its readiness');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

// A status watch the server never acknowledges, with events arriving all the time: the kit must
// not retain the whole backlog, and it must come back on its own.
for (const shape of ['count', 'bytes'] as const) {
  test(`a watch that is never acknowledged keeps the bootstrap buffer bounded (${shape}) and the kit recovers`, async () => {
    const fake = await startFakeHerdr({ dir: scratchDir(`herdr-buffer-${shape}`) });
    const logs: string[] = [];
    const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath,
      ackTimeoutMs: 500, onLog: (line) => logs.push(line) });
    try {
      await kit.start();
      const reads = fake.snapshotCount();
      // The next status watch is taken and never answered: the bootstrap's barrier waits for it.
      fake.holdAck();
      const refresh = kit.refresh();
      void refresh.catch(() => {});   // a failed run leaves it pending; the assertions below say so
      await until(() => fake.snapshotCount() > reads);
      // Events keep arriving while the bootstrap is parked: the buffer must stay bounded.
      const label = shape === 'count' ? 'pane' : 'p'.repeat(400 * 1024);
      const total = shape === 'count' ? BUFFER_CAP.events + 200 : 12;
      for (let i = 0; i < total; i++) {
        fake.emit({ type: 'pane.updated', pane: { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1',
          label: `${label} ${i}`, revision: i } });
      }
      // The overflow is reported through the kit's log channel, with what the buffer held.
      await until(() => logs.some((line) => line.includes('the bootstrap buffer hit its cap')));
      const reported = logs.find((line) => line.includes('the bootstrap buffer hit its cap'))!;
      const held = /hit its cap \((\d+) events, (\d+) bytes held\)/.exec(reported);
      assert.ok(held, `the overflow names what the buffer held: ${reported}`);
      const events = Number(held![1]);
      const bytes = Number(held![2]);
      const biggest = Buffer.byteLength(JSON.stringify({ type: 'pane.updated', pane: { pane_id: 'w1:p1',
        tab_id: 'w1:t1', workspace_id: 'w1', label: `${label} 0`, revision: 0 } }));
      assert.ok(events <= BUFFER_CAP.events + 1, `the kit held ${events} events, at most ${BUFFER_CAP.events + 1}`);
      assert.ok(bytes <= BUFFER_CAP.bytes + biggest, `the kit held ${bytes} bytes, at most ${BUFFER_CAP.bytes + biggest}`);
      assert.ok(total > events, `the fake sent ${total} events; the kit kept ${events}`);
      // The kit comes back: the refresh finishes and the tree is read again from Herdr.
      await Promise.race([
        refresh,
        settle(5000).then(() => assert.fail('the refresh waits on the unacknowledged status watch')),
      ]);
      await until(() => fake.snapshotCount() > reads + 1);
      assert.ok(fake.snapshotCount() > reads + 1, 'the tree is re-read from Herdr after the overflow');
      // And it still works: a later refresh answers with a fresh tree.
      await Promise.race([
        kit.refresh(),
        settle(5000).then(() => assert.fail('the kit does not recover after the overflow')),
      ]);
      assert.equal(kit.snapshot().workspaces.length, 1, 'the tree is intact after the recovery');
    } finally {
      await kit.stop().catch(() => {});
      await fake.stop().catch(() => {});
    }
  });
}
