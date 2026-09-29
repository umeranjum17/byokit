import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { Supervisor } from '../src/supervise.ts';
import { startFakeHerdr, writeBinShim } from '../src/testing/index.ts';
import type { HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';

const until = async (ok: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!ok()) { if (Date.now() > deadline) assert.fail('timed out'); await new Promise((r) => setTimeout(r, 10)); }
};

test('adopt bootstraps the fake and listens on a filtered status socket without spawning', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('kit-adopt') });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.equal(kit.snapshot().workspaces[0]?.tabs[0]?.panes[1]?.agent?.status, 'idle');
    await kit.call('ping', {});
    fake.setStatus('w1:p2', 'blocked');
    await until(() => kit.snapshot().workspaces[0]?.tabs[0]?.panes[1]?.agent?.status === 'blocked');
    await kit.stop();
    assert.ok(existsSync(fake.socketPath), 'adopt must not stop the server');
  } finally { await kit.stop(); await fake.stop(); }
});

test('event socket reconnect re-bootstraps a replacement fake', async () => {
  const dir = scratchDir('kit-reconnect');
  const first = await startFakeHerdr({ dir });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: first.socketPath });
  try {
    await kit.start();
    await first.stop();
    const second = await startFakeHerdr({ dir });
    try {
      await until(() => kit.state.phase === 'ready' && kit.snapshot().connected, 4000);
      second.setStatus('w1:p2', 'blocked');
      await until(() => kit.snapshot().workspaces[0]?.tabs[0]?.panes[1]?.agent?.status === 'blocked', 4000);
    } finally { await second.stop(); }
  } finally { await kit.stop(); }
});

test('event arriving during bootstrap applies after the snapshot', async () => {
  const snapshot = { snapshot: {
    workspaces: [{ workspace_id: 'w1', label: 'one' }],
    tabs: [{ tab_id: 't1', workspace_id: 'w1', label: 'main' }],
    panes: [{ pane_id: 'p1', tab_id: 't1' }],
    agents: [{ pane_id: 'p1', agent_status: 'idle', revision: 1 }],
  } };
  const transport: HerdrTransport = {
    call: async (method) => {
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      await new Promise((r) => setTimeout(r, 10));
      return snapshot;
    },
    subscribe: (subs, on) => {
      if (subs[0]?.type !== 'pane.agent_status_changed') queueMicrotask(() => on({
        type: 'pane.updated', pane: { pane_id: 'p1', agent_status: 'working', revision: 2 },
      }));
      return (() => {}) as HerdrSubscribeStop;
    },
    close() {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: '/unused', transport });
  try {
    await kit.start();
    const pane = kit.snapshot().workspaces[0]?.tabs[0]?.panes[0];
    assert.equal(pane?.agent?.status, 'working');
    assert.equal(pane?.agent?.revision, 2);
    assert.equal(kit.snapshot().workspaces[0]?.tabs[0]?.panes.length, 1);
  } finally { await kit.stop(); }
});

test('long-running agent calls extend the socket deadline', async () => {
  const seen: number[] = [];
  const transport: HerdrTransport = {
    call: async (method, _params, timeout) => {
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') return { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } };
      seen.push(timeout ?? 0);
      return {};
    }, subscribe: () => (() => {}) as HerdrSubscribeStop, close() {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/unused', socketPath: '/unused', transport });
  try {
    await kit.start();
    await kit.call('agent.wait', { target: 'p1', timeout_ms: 20_000 });
    await kit.call('agent.prompt', { target: 'p1', text: 'hi', wait: { timeout_ms: 30_000 } });
    assert.deepEqual(seen, [25_000, 35_000]);
  } finally { await kit.stop(); }
});

test('an older protocol fails closed', async () => {
  const states: string[] = [];
  const transport: HerdrTransport = {
    call: async () => ({ protocol: HERDR_PROTOCOL - 1 }), subscribe: () => (() => {}) as HerdrSubscribeStop, close() {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: '/unused', transport,
    onState: (s) => states.push(`${s.phase}/${s.why}`) });
  await assert.rejects(kit.start(), /protocol mismatch/);
  assert.ok(states.includes('needs-update/version'));
  await kit.stop();
});

test('own spawns only the task-owned fake binary with explicit isolated environment', async () => {
  const dir = scratchDir('kit-own');
  const bin = writeBinShim({ dir, socketPath: join(dir, 'unused.sock') });
  const stateDir = join(dir, 'state');
  const supervisor = new Supervisor({ mode: 'own', bin, stateDir, path: [dirname(process.execPath), '/usr/bin', '/bin'], env: { TEST_ONLY: 'yes' } }, () => {});
  try {
    const transport = await supervisor.start();
    assert.equal((await transport.call('ping', {}) as { protocol: number }).protocol, HERDR_PROTOCOL);
    assert.equal(supervisor.env().HOME, join(stateDir, 'herdr/home'));
    assert.equal(supervisor.env().TEST_ONLY, 'yes');
    const spawned = JSON.parse(readFileSync(join(stateDir, 'herdr/server.log'), 'utf8').split('\n')[0]) as {
      env: Record<string, string>;
    };
    assert.deepEqual(Object.keys(spawned.env).sort(), Object.keys(supervisor.env()).sort());
    assert.equal(spawned.env.HOME, join(stateDir, 'herdr/home'));
    assert.equal(spawned.env.TEST_ONLY, 'yes');
  } finally { await supervisor.stop(); }
  await until(() => !existsSync(join(stateDir, 'herdr/herdr.sock')));
});
