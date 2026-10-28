// The outbox contract: durable persistence, revision-bound mutations, and cancellation arbitration up to the
// irreversible boundary. Every send goes through a fake sender; nothing here touches a network or account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Outbox, OutboxError } from '../src/index.ts';
import type { OutboxSendJob, OutboxSender } from '../src/index.ts';

const code = (want: string) => (e: unknown) => {
  assert.ok(e instanceof OutboxError, `expected OutboxError, got ${e}`);
  assert.equal((e as OutboxError).code, want);
  return true;
};
const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

/** A fake sender that records every job; optional behavior scripts the outcome of each call. */
function fakeSender(behavior?: (job: OutboxSendJob, count: number) => Promise<unknown>):
  { calls: OutboxSendJob[]; sender: OutboxSender } {
  const calls: OutboxSendJob[] = [];
  return {
    calls,
    sender: {
      send(job: OutboxSendJob): Promise<unknown> {
        calls.push(job);
        return behavior ? behavior(job, calls.length) : Promise.resolve({ accepted: calls.length });
      },
    },
  };
}

async function open(dir: string, sender?: OutboxSender): Promise<Outbox> {
  return Outbox.open({ stateDir: dir, ...(sender ? { sender } : {}) });
}

test('duplicate enqueue with the same requestId then flush invokes the sender once', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const outbox = await open(dir, sender);
  const first = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'once' }, requestId: 'reply-1' });
  const second = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'retry' }, requestId: 'reply-1' });
  assert.equal(second.id, first.id);
  assert.equal(second.requestId, 'reply-1');
  assert.equal(outbox.list().length, 1);
  const drained = await outbox.flush();
  assert.equal(calls.length, 1);
  assert.equal(drained.sent.length, 1);
  assert.deepEqual(calls[0].payload, { body: 'once' });
  await outbox.close();
});

test('requestId dedupe survives reopen on the same stateDir', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const firstLife = await open(dir, sender);
  const first = await firstLife.enqueue({ kind: 'email-reply', payload: { body: 'keep' }, requestId: 'phone-42' });
  await firstLife.close();
  const reopened = await open(dir, sender);
  const again = await reopened.enqueue({ kind: 'email-reply', payload: { body: 'retry after restart' }, requestId: 'phone-42' });
  assert.equal(again.id, first.id);
  assert.equal(again.requestId, 'phone-42');
  assert.equal(reopened.list().length, 1);
  const drained = await reopened.flush();
  assert.equal(calls.length, 1);
  assert.equal(drained.sent.length, 1);
  assert.deepEqual(calls[0].payload, { body: 'keep' });
  await reopened.close();
});

test('a cancel accepted while queued wins: flush never invokes the sender for it', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'take me back' } });
  const result = await outbox.cancel(entry.id, { revision: entry.revision });
  assert.equal(result.ok, true);
  const again = await outbox.cancel(entry.id, { revision: result.entry.revision });
  assert.equal(again.ok, true); // already taken back: still true that it will not be sent
  assert.equal(again.entry.revision, result.entry.revision); // idempotent: no further change
  const drained = await outbox.flush();
  assert.deepEqual(drained, { sent: [], failed: [] });
  assert.equal(calls.length, 0);
  assert.equal(outbox.get(entry.id)!.state, 'cancelled');
  await outbox.close();
});

test('an interrupted send reopens as sending with an unknown outcome: never redispatched, resolvable', async () => {
  const dir = scratchDir('outbox');
  const entered = deferred();
  const gate = deferred(); // never released: the first queue is abandoned mid-send, like a crash.
  const stuck = fakeSender(() => { entered.resolve(); return gate.promise; });
  const crashed = await open(dir, stuck.sender);
  const entry = await crashed.enqueue({ kind: 'email-reply', payload: { body: 'did it land?' } });
  const abandoned = crashed.flush(); // claim persisted, sender invoked, never settles in this test
  await entered.promise;
  assert.equal(crashed.get(entry.id)!.state, 'sending');

  const { sender: freshSender, calls: freshCalls } = fakeSender();
  const reopened = await open(dir, freshSender);
  assert.equal(reopened.get(entry.id)!.state, 'sending'); // unknown, not "queued" again
  // This instance never claimed it: whether the abandoned send was invoked is unknowable, so a cancel
  // refuses with the unknown answer rather than too-late or a false win.
  const refused = await reopened.cancel(entry.id, { revision: 2 });
  assert.deepEqual(refused, { ok: false, code: 'unknown', entry: reopened.get(entry.id) });
  const drained = await reopened.flush();
  assert.deepEqual(drained, { sent: [], failed: [] }); // no invented redelivery
  assert.equal(freshCalls.length, 0);
  assert.equal(reopened.get(entry.id)!.state, 'sending');
  const resolved = await reopened.resolve(entry.id, { revision: 2, outcome: 'sent', receipt: { checked: 'the mailbox' } });
  assert.equal(resolved.state, 'sent');
  assert.deepEqual(resolved.receipt, { checked: 'the mailbox' });
  await reopened.close();
  await crashed.close(); // the abandoned drain is still parked on the gate; nothing else may record it

  const final = await open(dir, freshSender);
  assert.equal(final.get(entry.id)!.state, 'sent');
  assert.equal(final.get(entry.id)!.revision, 3);
  await final.close();
  void abandoned;
});

test('drain leaves in enqueue order and passes exactly what was enqueued', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const outbox = await open(dir, sender);
  for (const body of ['one', 'two', 'three']) await outbox.enqueue({ kind: 'email-reply', payload: { body } });
  const drained = await outbox.flush();
  assert.deepEqual(drained.sent.map((e) => e.seq), [1, 2, 3]);
  assert.deepEqual(calls.map((job) => (job.payload as { body: string }).body), ['one', 'two', 'three']);
  assert.ok(calls.every((job) => Object.keys(job).length === 4)); // exactly id, kind, payload, seq
  await outbox.close();
});
