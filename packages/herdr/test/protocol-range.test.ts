// K11 acceptance: a declared protocol range, and `needs-update` as a steady state — not a
// throw — for newer servers, so a Herdr protocol bump does not take the host down before the
// kit's pin moves. Against transport doubles; never a real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import type { HerdrProtocolRange, HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';

const snapshot = (protocol: number) => ({
  protocol,
  snapshot: {
    protocol,
    workspaces: [{ workspace_id: 'w1', label: 'x' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', label: 'main' }],
    panes: [{ pane_id: 'w1:p2', tab_id: 'w1:t1', workspace_id: 'w1' }],
    agents: [{ pane_id: 'w1:p2', agent_status: 'idle', revision: 1 }],
  },
});

function double(protocol: number, snapshotProtocol?: number): HerdrTransport {
  return {
    call: async (method) =>
      method === 'session.snapshot' ? snapshot(snapshotProtocol ?? protocol) : { protocol },
    subscribe: () => (() => {}) as HerdrSubscribeStop,
    close() {},
  };
}

async function started(protocolRange: HerdrProtocolRange | undefined, protocol: number, snapshotProtocol?: number) {
  const states: string[] = [];
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/unused',
    transport: double(protocol, snapshotProtocol),
    ...(protocolRange ? { protocolRange } : {}),
    onState: (s) => states.push(`${s.phase}${s.why ? `/${s.why}` : ''}`) });
  await kit.start();
  return { kit, states };
}

test('K11: a newer ping is steady needs-update, not a throw — the kit stays usable', async () => {
  const { kit, states } = await started(undefined, HERDR_PROTOCOL + 1);
  try {
    assert.equal(kit.state.phase, 'needs-update');
    assert.equal(kit.state.why, 'version');
    assert.ok(states.includes('needs-update/version'));
    assert.ok(kit.snapshot().connected, 'the snapshot installs and the kit stays connected');
    assert.equal(kit.snapshot().workspaces.length, 1);
    await kit.call('ping', {});
  } finally {
    await kit.stop();
  }
});

test('K11: a newer snapshot protocol is steady needs-update, not a throw', async () => {
  const { kit } = await started(undefined, HERDR_PROTOCOL, HERDR_PROTOCOL + 1);
  try {
    assert.equal(kit.state.phase, 'needs-update');
    assert.equal(kit.state.why, 'version');
    assert.equal(kit.snapshot().workspaces.length, 1);
  } finally {
    await kit.stop();
  }
});

test('K11: the declared range accepts a newer server as ready', async () => {
  const { kit } = await started({ min: HERDR_PROTOCOL, max: HERDR_PROTOCOL + 2 }, HERDR_PROTOCOL + 2);
  try {
    assert.equal(kit.state.phase, 'ready');
    assert.equal(kit.snapshot().workspaces.length, 1);
  } finally {
    await kit.stop();
  }
});

test('K11: the declared range still fails closed below its floor', async () => {
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/unused',
    transport: double(HERDR_PROTOCOL - 5), protocolRange: { min: HERDR_PROTOCOL - 2 } });
  await assert.rejects(kit.start(), /protocol mismatch/);
  assert.equal(kit.state.phase, 'needs-update');
  await kit.stop();
});

test('K11: a newer server above a declared max stays needs-update, not ready', async () => {
  const { kit } = await started({ max: HERDR_PROTOCOL + 1 }, HERDR_PROTOCOL + 2);
  try {
    assert.equal(kit.state.phase, 'needs-update');
    assert.ok(kit.snapshot().connected);
  } finally {
    await kit.stop();
  }
});

test('K11: the pin itself still reaches ready with no range declared', async () => {
  const { kit } = await started(undefined, HERDR_PROTOCOL);
  try {
    assert.equal(kit.state.phase, 'ready');
  } finally {
    await kit.stop();
  }
});
