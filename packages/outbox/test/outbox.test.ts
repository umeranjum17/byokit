// The outbox contract: durable persistence, revision-bound mutations, and cancellation arbitration up to the
// irreversible boundary. Every send goes through a fake sender; nothing here touches a network or account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Outbox, OutboxError, WORDS, errorWords, cancelWords, stateWords } from '../src/index.ts';
import type { OutboxEntry, OutboxSendJob, OutboxSender } from '../src/index.ts';

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

test('enqueue persists a queued entry with 0700/0600 store; reopen sees it byte for byte', async () => {
  const dir = scratchDir('outbox');
  const { sender } = fakeSender();
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'email-reply', payload: { to: 'a@example.org', body: 'hi' } });
  assert.equal(entry.state, 'queued');
  assert.equal(entry.revision, 1);
  assert.equal(entry.seq, 1);
  const store = join(dir, 'outbox', 'entries.json');
  assert.equal(statSync(join(dir, 'outbox')).mode & 0o777, 0o700);
  assert.equal(statSync(store).mode & 0o777, 0o600);
  assert.ok(JSON.parse(readFileSync(store, 'utf8')).entries[0].id === entry.id);
  await outbox.close();
  const reopened = await open(dir, sender);
  const again = reopened.get(entry.id);
  assert.deepEqual(again, entry);
  assert.equal(reopened.list().length, 1);
  await reopened.close();
});

test('stale revisions reject: older, reused, and pre-check of the too-late path', async () => {
  const dir = scratchDir('outbox');
  const { sender } = fakeSender();
  const outbox = await open(dir, sender);
  const a = await outbox.enqueue({ kind: 'note', payload: 1 });
  const first = await outbox.cancel(a.id, { revision: a.revision });
  assert.equal(first.ok, true);
  assert.equal(first.entry.state, 'cancelled');
  assert.equal(first.entry.revision, 2);
  // The same revision again is now stale: the entry moved on.
  await assert.rejects(outbox.cancel(a.id, { revision: a.revision }), code('stale-revision'));
  const b = await outbox.enqueue({ kind: 'note', payload: 2 });
  await assert.rejects(outbox.cancel(b.id, { revision: 0 }), code('stale-revision'));
  // A stale view loses to the revision guard even when the message already sent.
  await outbox.flush();
  await assert.rejects(outbox.cancel(b.id, { revision: 1 }), code('stale-revision'));
  const fresh = outbox.get(b.id)!;
  const late = await outbox.cancel(b.id, { revision: fresh.revision });
  assert.deepEqual(late, { ok: false, code: 'too-late', entry: fresh });
  await outbox.close();
});

test('a cancel accepted while queued wins: flush never invokes the sender for it', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'take me back' } });
  const result = await outbox.cancel(entry.id, { revision: entry.revision });
  assert.equal(result.ok, true);
  const drained = await outbox.flush();
  assert.deepEqual(drained, { sent: [], failed: [] });
  assert.equal(calls.length, 0);
  assert.equal(outbox.get(entry.id)!.state, 'cancelled');
  await outbox.close();
});

test('cancel loses at the boundary: claim is durable before the sender runs, and it says too-late', async () => {
  const dir = scratchDir('outbox');
  const entered = deferred();
  const gate = deferred();
  const { sender, calls } = fakeSender(() => { entered.resolve(); return gate.promise.then(() => ({ queued: true })); });
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'racing' } });
  const flushing = outbox.flush();
  await entered.promise; // the sender was invoked: the irreversible boundary was crossed.
  assert.equal(calls.length, 1);
  assert.equal(outbox.get(entry.id)!.state, 'sending');
  assert.equal(outbox.get(entry.id)!.revision, 2);
  const late = await outbox.cancel(entry.id, { revision: 2 });
  assert.deepEqual(late, { ok: false, code: 'too-late', entry: outbox.get(entry.id) });
  await assert.rejects(outbox.cancel(entry.id, { revision: 1 }), code('stale-revision'));
  gate.resolve();
  const drained = await flushing;
  assert.equal(drained.sent.length, 1);
  assert.equal(drained.sent[0].state, 'sent');
  assert.equal(drained.sent[0].revision, 3);
  assert.ok(drained.sent[0].sentAt !== undefined);
  assert.deepEqual(drained.sent[0].receipt, { queued: true });
  assert.deepEqual(calls[0].payload, { body: 'racing' });
  await outbox.close();
});

test('same-tick race, cancel registered first: the cancel wins and nothing is sent', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'note', payload: 0 });
  const cancelling = outbox.cancel(entry.id, { revision: 1 });
  const flushing = outbox.flush();
  const [result, drained] = await Promise.all([cancelling, flushing]);
  assert.equal(result.ok, true);
  assert.deepEqual(drained, { sent: [], failed: [] });
  assert.equal(calls.length, 0);
  assert.equal(outbox.get(entry.id)!.state, 'cancelled');
  await outbox.close();
});

test('same-tick race, flush registered first: the claim moves the revision and the stale cancel rejects', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender();
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'note', payload: 0 });
  const flushing = outbox.flush();
  const cancelling = outbox.cancel(entry.id, { revision: 1 });
  await assert.rejects(cancelling, code('stale-revision'));
  const drained = await flushing;
  assert.equal(drained.sent.length, 1);
  assert.equal(calls.length, 1);
  const fresh = outbox.get(entry.id)!;
  assert.equal(fresh.state, 'sent');
  const late = await outbox.cancel(entry.id, { revision: fresh.revision });
  assert.equal(late.ok, false);
  await outbox.close();
});

test('a sender that rejects is recorded failed with its text; it is never retried by flush', async () => {
  const dir = scratchDir('outbox');
  const { sender, calls } = fakeSender(() => Promise.reject(new Error('mailbox refused')));
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'email-reply', payload: { body: 'x' } });
  const drained = await outbox.flush();
  assert.equal(drained.failed.length, 1);
  assert.equal(drained.failed[0].failure, 'mailbox refused');
  assert.equal(drained.failed[0].state, 'failed');
  const again = await outbox.flush();
  assert.deepEqual(again, { sent: [], failed: [] });
  assert.equal(calls.length, 1); // no silent retry
  const fresh = outbox.get(entry.id)!;
  assert.equal(fresh.revision, 3);
  assert.equal((await outbox.cancel(entry.id, { revision: fresh.revision })).ok, false); // already dispatched
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

test('resolve is guarded: only interrupted sends, only at the current revision', async () => {
  const dir = scratchDir('outbox');
  const { sender } = fakeSender();
  const outbox = await open(dir, sender);
  const queued = await outbox.enqueue({ kind: 'note', payload: 1 });
  await assert.rejects(outbox.resolve(queued.id, { revision: 1, outcome: 'sent' }), code('invalid'));
  await assert.rejects(outbox.resolve('00000000-0000-4000-8000-000000000000', { revision: 1, outcome: 'sent' }), code('not-found'));
  const sent = await outbox.flush();
  await assert.rejects(outbox.resolve(queued.id, { revision: 1, outcome: 'failed' }), code('stale-revision'));
  await assert.rejects(outbox.resolve(queued.id, { revision: 3, outcome: 'failed' }), code('invalid'));
  assert.equal(sent.sent.length, 1);
  await outbox.close();
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

test('concurrent enqueues get distinct sequence numbers and a clean store', async () => {
  const dir = scratchDir('outbox');
  const { sender } = fakeSender();
  const outbox = await open(dir, sender);
  const made = await Promise.all([
    outbox.enqueue({ kind: 'a', payload: 1 }),
    outbox.enqueue({ kind: 'b', payload: 2 }),
    outbox.enqueue({ kind: 'c', payload: 3 }),
  ]);
  assert.deepEqual(new Set(made.map((e) => e.seq)).size, 3);
  await outbox.close();
  const reopened = await open(dir, sender);
  assert.deepEqual(reopened.list().map((e) => e.seq).sort(), [1, 2, 3]);
  await reopened.close();
});

test('abort stops further claims; an in-flight send still records its outcome', async () => {
  const dir = scratchDir('outbox');
  const entered = deferred();
  const gate = deferred();
  const { sender, calls } = fakeSender(() => { entered.resolve(); return gate.promise.then(() => ({ ok: true })); });
  const outbox = await open(dir, sender);
  const first = await outbox.enqueue({ kind: 'note', payload: 1 });
  const second = await outbox.enqueue({ kind: 'note', payload: 2 });
  const signal = AbortSignal.abort();
  await assert.rejects(outbox.flush({ signal }), signal.reason); // aborted before any claim
  assert.equal(calls.length, 0);
  const controller = new AbortController();
  const flushing = outbox.flush({ signal: controller.signal });
  await entered.promise;
  controller.abort();
  gate.resolve();
  await assert.rejects(flushing, controller.signal.reason);
  assert.equal(outbox.get(first.id)!.state, 'sent'); // recorded even though the drain rejected
  assert.equal(outbox.get(second.id)!.state, 'queued'); // never claimed
  await outbox.close();
});

test('a parked queue (no sender) enqueues and cancels; flush refuses unavailable', async () => {
  const dir = scratchDir('outbox');
  const outbox = await open(dir);
  const entry = await outbox.enqueue({ kind: 'draft', payload: { body: 'later' } });
  assert.equal((await outbox.cancel(entry.id, { revision: 1 })).ok, true);
  await assert.rejects(outbox.flush(), code('unavailable'));
  await outbox.close();
});

test('after close every mutation refuses unavailable', async () => {
  const dir = scratchDir('outbox');
  const { sender } = fakeSender();
  const outbox = await open(dir, sender);
  const entry = await outbox.enqueue({ kind: 'note', payload: 1 });
  await outbox.close();
  await assert.rejects(outbox.enqueue({ kind: 'note', payload: 2 }), code('unavailable'));
  await assert.rejects(outbox.cancel(entry.id, { revision: 1 }), code('unavailable'));
  await assert.rejects(outbox.flush(), code('unavailable'));
});

test('bad calls are TypeErrors; bad payloads are the kit error; malformed stores refuse to open', async () => {
  const dir = scratchDir('outbox');
  const { sender } = fakeSender();
  await assert.rejects(Outbox.open({ stateDir: 'relative/path', sender }), TypeError);
  await assert.rejects(Outbox.open({ stateDir: dir, sender: {} as never }), TypeError);
  const outbox = await open(dir, sender);
  await assert.rejects(outbox.enqueue({ kind: '', payload: 1 }), TypeError);
  await assert.rejects(outbox.enqueue({ kind: 'note', payload: undefined }), code('invalid'));
  await assert.rejects(outbox.enqueue({ kind: 'note', payload: () => 1 }), code('invalid'));
  await assert.rejects(outbox.enqueue({ kind: 'note', payload: Symbol('x') }), code('invalid'));
  assert.throws(() => outbox.get(5 as never), TypeError);
  await outbox.close();

  const broken = scratchDir('outbox');
  mkdirSync(join(broken, 'outbox'), { recursive: true });
  writeFileSync(join(broken, 'outbox', 'entries.json'), '{not json', { flag: 'w' });
  await assert.rejects(Outbox.open({ stateDir: broken }), code('invalid'));

  const dup = scratchDir('outbox');
  const good = await open(dup, sender);
  const one = await good.enqueue({ kind: 'note', payload: 1 });
  await good.close();
  const raw = JSON.parse(readFileSync(join(dup, 'outbox', 'entries.json'), 'utf8'));
  raw.entries.push({ ...raw.entries[0] }); // duplicate id and seq
  writeFileSync(join(dup, 'outbox', 'entries.json'), JSON.stringify(raw));
  await assert.rejects(Outbox.open({ stateDir: dup }), code('invalid'));
  assert.ok(one.id.length > 0);
});

test('words: plain sentences only, every code and result has one, slots stay visible', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [key, sentence] of Object.entries(WORDS)) {
    assert.doesNotMatch(sentence.replace(/\{\w+\}/g, 'X'), banned, key);
    assert.match(key, /^outbox\.[a-z]/, key);
  }
  for (const c of ['invalid', 'io', 'not-found', 'stale-revision', 'unavailable'] as const) {
    assert.ok(errorWords(new OutboxError(c, 'log text')).length > 0, c);
  }
  const dir = scratchDir('outbox');
  const entry: OutboxEntry = { id: 'x', kind: 'k', payload: 1, state: 'queued', revision: 1, seq: 1, createdAt: 0, updatedAt: 0 };
  assert.equal(cancelWords({ ok: false, code: 'too-late', entry }), WORDS['outbox.tooLate']);
  assert.equal(cancelWords({ ok: true, entry }), WORDS['outbox.cancelled']);
  assert.equal(stateWords('queued'), '');
  assert.equal(stateWords('sent'), WORDS['outbox.sent']);
});
