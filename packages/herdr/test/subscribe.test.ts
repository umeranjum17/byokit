// K4 acceptance (docs/runtime-kits.md 6.2/6.3): `kit.subscribe` forwards `onError` and returns the
// transport's control surface; a rejected filtered subscription reports once and never retries; the
// kit's own watches report rejections to `onLog` — all against the kit fake, never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import type { HerdrSubscribeStop, HerdrSubscription, HerdrTransport } from '../src/types.ts';

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(ok: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > deadline) assert.fail('timed out');
    await settle(10);
  }
}

test('a rejected filtered subscription calls onError once and never retries', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-k4-subscribe') });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    // Deliberately schema-invalid: the pinned schema requires pane_id for this filtered kind.
    const rejected = { type: 'pane.agent_status_changed' } as unknown as HerdrSubscription;
    const errors: { code: string; message: string }[] = [];
    const stop = kit.subscribe([rejected], () => {},
      (code, message) => errors.push({ code, message }));
    assert.equal(typeof stop, 'function');
    assert.ok(stop.ready instanceof Promise, 'the stop carries the ack promise');
    assert.equal(typeof stop.onReconnect, 'function');
    assert.equal(typeof stop.onDisconnect, 'function');
    assert.equal(await stop.ready, false, 'a rejected batch resolves ready false');
    await until(() => errors.length >= 1);
    assert.deepEqual(errors.map((e) => e.code), ['invalid_subscription']);
    assert.match(errors[0].message, /pane_id/);
    await settle(1200);   // longer than the 1 s reconnect delay a retry would use
    assert.equal(errors.length, 1, 'the rejection is reported exactly once: no retry');
    stop();
    // Omitting onError keeps the old swallow: no throw, ready still resolves false.
    const quiet = kit.subscribe([rejected], () => {});
    assert.equal(await quiet.ready, false);
    quiet();
    // The kit itself stays usable: a valid subscription still receives events.
    const validErrors: string[] = [];
    const seen: unknown[] = [];
    const ok = kit.subscribe([{ type: 'pane.created' }], (e) => seen.push(e),
      (code) => validErrors.push(code));
    assert.equal(await ok.ready, true);
    await settle(100);   // the subscribe registers on its own socket; an emit before that never arrives
    fake.emit({ type: 'pane.created', pane_id: 'w9:p9' });
    await until(() => seen.length >= 1);
    assert.equal((seen[0] as Record<string, unknown>).pane_id, 'w9:p9');
    assert.deepEqual(validErrors, [], 'a valid subscription never reports an error');
    ok();
    assert.equal(kit.state.phase, 'ready', 'the rejected batch leaves the kit ready');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop().catch(() => {});
  }
});

test('the internal watches report rejections to onLog instead of swallowing them', async () => {
  const logs: string[] = [];
  const acked = (ready: boolean): HerdrSubscribeStop =>
    Object.assign(() => {}, {
      ready: Promise.resolve(ready),
      onReconnect() {},
      onDisconnect() {},
    });
  const transport: HerdrTransport = {
    call: async (method) => {
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') {
        return { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } };
      }
      return {};
    },
    subscribe: (_subs, _on, onError) => {
      onError('invalid_subscription', 'rejected by test');
      return acked(false);
    },
    close() {},
  };
  const kit = new HerdrKit({
    mode: 'adopt', bin: '/not/used', socketPath: '/not/used', transport, onLog: (m) => logs.push(m),
  });
  try {
    await assert.rejects(kit.start(), /event subscription rejected/);
    assert.equal(logs.length, 1, 'the rejected events watch logs once');
    assert.match(logs[0], /invalid_subscription/);
    assert.match(logs[0], /events/);
  } finally {
    await kit.stop().catch(() => {});
  }
});
