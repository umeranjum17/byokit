// H5 acceptance (docs/runtime-kits.md 11.2, behavior 6.4) for src/approvals.ts: blocked adds the
// question with detection text and revision, a stale answer is refused (`approval-stale`), the
// current revision sends keys and the agent resolves, and leaving/closing resolves the question.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scratchDir } from '../../test-support.ts';
import { HerdrKit } from '../src/kit.ts';
import { startFakeHerdr, type FakeHerdr } from '../src/testing/index.ts';
import type { BlockedAgent } from '../src/types.ts';

const until = async (probe: () => BlockedAgent[], ok: (value: BlockedAgent[]) => boolean, ms = 3000): Promise<BlockedAgent[]> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (ok(value)) return value;
    if (Date.now() > deadline) assert.fail('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function withKit(run: (kit: HerdrKit, fake: FakeHerdr) => Promise<void>, name: string): Promise<void> {
  const fake = await startFakeHerdr({ dir: scratchDir(name) });
  const kit = new HerdrKit({ mode: 'adopt', bin: '/not/used', socketPath: fake.socketPath });
  try { await kit.start(); await run(kit, fake); }
  finally { await kit.stop(); await fake.stop(); }
}

test('blocked becomes a question; stale refused, current revision answers and resolves', async () => {
  await withKit(async (kit) => {
    const seen: { change: string; paneId: string }[] = [];
    const stopWatching = kit.onBlocked((b, change) => seen.push({ change, paneId: b.paneId }));
    await kit.prompt({ paneId: 'w1:p2' }, 'ask permission');
    const [entry] = await until(() => kit.blocked(), (list) => list.length === 1);
    assert.ok(entry);
    assert.equal(entry.paneId, 'w1:p2');
    assert.equal(entry.prompt, 'Allow this? (y/n)');
    assert.equal(entry.kind, 'pi');
    assert.ok(entry.revision >= 1);

    await assert.rejects(kit.answer('w1:p2', ['y'], { revision: entry.revision - 1 }),
      (e: { code?: string }) => e.code === 'approval-stale', 'a stale revision is refused');
    assert.equal(kit.blocked().length, 1, 'the refusal leaves the question open');

    await kit.answer('w1:p2', ['y'], { revision: entry.revision });
    await until(() => kit.blocked(), (list) => list.length === 0);
    assert.equal(await kit.wait({ paneId: 'w1:p2' }, { until: ['idle'], timeoutMs: 2000 }), 'idle');
    assert.deepEqual(seen, [{ change: 'added', paneId: 'w1:p2' }, { change: 'resolved', paneId: 'w1:p2' }]);
    stopWatching();
  }, 'h5-approve');
});

test('leaving blocked resolves the question', async () => {
  await withKit(async (kit, fake) => {
    await kit.prompt({ paneId: 'w1:p2' }, 'ask permission');
    await until(() => kit.blocked(), (list) => list.length === 1);
    fake.setStatus('w1:p2', 'idle');
    await until(() => kit.blocked(), (list) => list.length === 0);
  }, 'h5-approve-resolve');
});

test('answering a pane that is not blocked is stale', async () => {
  await withKit(async (kit) => {
    await assert.rejects(kit.answer('w1:p1', ['y'], { revision: 1 }),
      (e: { code?: string }) => e.code === 'approval-stale');
  }, 'h5-approve-stale');
});

test('a closed pane resolves its question', async () => {
  await withKit(async (kit, fake) => {
    await kit.prompt({ paneId: 'w1:p2' }, 'ask permission');
    await until(() => kit.blocked(), (list) => list.length === 1);
    fake.emit({ type: 'pane.closed', pane_id: 'w1:p2' });
    await until(() => kit.blocked(), (list) => list.length === 0);
  }, 'h5-approve-closed');
});
