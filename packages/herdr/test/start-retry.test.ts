// K5 acceptance: `start()` is non-fatal — a failed start may be retried, so the host comes up
// while Herdr is down by wrapping `start()` in a backoff loop. Against the kit fake; never a
// real Herdr.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr } from '../src/testing/index.ts';

const until = async (ok: () => boolean, ms: number, what: string) => {
  const deadline = Date.now() + ms;
  while (!ok()) { if (Date.now() > deadline) assert.fail(`not reached within ${ms}ms: ${what}`); await new Promise((r) => setTimeout(r, 10)); }
};

test('K5: start against a missing socket reports failed; a retry after Herdr appears reaches ready within 5 s', async () => {
  const dir = scratchDir('herdr-start-retry');
  const socketPath = join(dir, 'herdr.sock');
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath });
  try {
    await assert.rejects(kit.start(), /socket unavailable/);
    assert.ok(kit.state.phase === 'failed' || kit.state.phase === 'reconnecting',
      `a missing socket reports failed or reconnecting, not ${kit.state.phase}`);
    const fake = await startFakeHerdr({ dir: scratchDir('herdr-start-retry-late'), socketPath });
    try {
      const started = Date.now();
      await kit.start();
      assert.ok(Date.now() - started < 5000, 'the retry reaches ready within 5 s');
      assert.equal(kit.state.phase, 'ready');
      await kit.call('ping', {});
    } finally {
      await fake.stop();
    }
  } finally {
    await kit.stop().catch(() => {});
  }
});

test('K5: a failed start cleans up so stop then start still dials', async () => {
  const dir = scratchDir('herdr-start-retry-stop');
  const socketPath = join(dir, 'herdr.sock');
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath });
  try {
    await assert.rejects(kit.start(), /socket unavailable/);
    await kit.stop();
    const fake = await startFakeHerdr({ dir: scratchDir('herdr-start-retry-stop-late'), socketPath });
    try {
      await kit.start();
      assert.equal(kit.state.phase, 'ready');
    } finally {
      await fake.stop();
    }
  } finally {
    await kit.stop().catch(() => {});
  }
});

test('K5: stop then start restarts on the same socket', async () => {
  const fake = await startFakeHerdr({ dir: scratchDir('herdr-restart') });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await kit.stop();
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await until(() => kit.snapshot().connected, 2000, 'the restarted kit bootstraps');
  } finally {
    await kit.stop().catch(() => {});
    await fake.stop();
  }
});
