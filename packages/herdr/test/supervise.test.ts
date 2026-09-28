import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { HerdrKit } from '../src/kit.ts';
import { Supervisor } from '../src/supervise.ts';
import { startFakeHerdr, writeBinShim } from '../src/testing/index.ts';
import type { HerdrTransport } from '../src/types.ts';

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

test('protocol mismatch fails closed', async () => {
  const states: string[] = [];
  const transport: HerdrTransport = {
    call: async () => ({ protocol: HERDR_PROTOCOL + 1 }), subscribe: () => () => {}, close() {},
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
  const supervisor = new Supervisor({ mode: 'own', bin, stateDir, path: ['/usr/bin', '/bin'], env: { TEST_ONLY: 'yes' } }, () => {});
  const transport = await supervisor.start();
  try {
    assert.equal((await transport.call('ping', {}) as { protocol: number }).protocol, HERDR_PROTOCOL);
    assert.equal(supervisor.env().HOME, join(stateDir, 'herdr/home'));
    assert.equal(supervisor.env().TEST_ONLY, 'yes');
  } finally { await supervisor.stop(); }
  await until(() => !existsSync(join(stateDir, 'herdr/herdr.sock')));
});
