// What waits for a yes: the approvals list's state machine (listed, added, resolved, expired), its question in the
// OpenClaw kit's own words, and the live store through the kit's real device client, across a dropped link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openclawDevice } from '../../openclaw/src/device.ts';
import { words } from '../../openclaw/src/words.ts';
import { approvalsStep, approvalsStore, approvalWords, type Approval } from '../src/kits.ts';
import { stubLink, until } from './stub-link.ts';

const ask = (id: string, expires = 10_000, summary = 'save a note'): Approval =>
  ({ id, source: 'gate', member: 'me', tool: 'demo_note', summary, at: 1_000, expires });
const added = (a: Approval) => ({ event: 'approval', change: 'added' as const, approval: a });
const resolved = (a: Approval) => ({ event: 'approval', change: 'resolved' as const, approval: a });

test('approvals are listed, added, resolved and expire; other events change nothing', () => {
  const a = ask('a'), b = ask('b', 5_000);
  let list = approvalsStep([], { type: 'set', list: [a] });
  assert.deepEqual(list, [a]);
  list = approvalsStep(list, added(b));
  assert.deepEqual(list.map((x) => x.id), ['a', 'b']);
  const again = { ...b, summary: 'save another note' };
  list = approvalsStep(list, added(again));
  assert.deepEqual(list, [a, again], 'the same id again replaces it in place');
  for (const other of [{ event: 'agent' }, { event: 'approval' }, { event: 'approval', change: 'moved' as never, approval: a }]) {
    assert.equal(approvalsStep(list, other), list, JSON.stringify(other));
  }
  assert.equal(approvalsStep(list, resolved(ask('gone'))), list, 'resolving one not listed changes nothing');
  list = approvalsStep(list, resolved(a));
  assert.deepEqual(list, [again]);
  assert.equal(approvalsStep(list, { type: 'tick', now: 4_999 }), list, 'still waiting before it expires');
  assert.deepEqual(approvalsStep(list, { type: 'tick', now: 5_000 }), [], 'gone the moment it expires');
});

test('an approval asks in the kit\'s own words', () => {
  assert.equal(approvalWords(ask('a'), words, 'Your helper'), 'Your helper wants to save a note. Allow it?');
});

test('the store lists once the stream is open, keeps up with its frames, drops the expired, and reopens after a drop', async () => {
  let clock = 1_000;
  let listing: Approval[] = [ask('a', 60_000)];
  const asked: string[] = [];
  const net = stubLink((op, args) => {
    asked.push(op);
    if (op === 'oc.approvals') return listing;
    if (op === 'oc.decide') return (args as { id: string }).id;
    return null;
  });
  const oc = openclawDevice(net.link);
  const approvals = approvalsStore(oc, { retryMs: 10, now: () => clock });
  const seen: Approval[][] = [];
  const off = approvals.subscribe((l) => seen.push(l));
  const events = await net.next();
  assert.equal(events.op, 'oc.events');
  await until(() => approvals.get().length === 1);
  assert.deepEqual(asked, ['oc.approvals'], 'listed after the stream opened');

  events.line({ event: 'agent', payload: { runId: 'r' } });
  events.line(added(ask('b', 1_050)));
  await until(() => approvals.get().length === 2);
  events.line(resolved(ask('a')));
  await until(() => approvals.get().length === 1);
  assert.equal(approvals.get()[0].id, 'b');

  // Nobody answers: it leaves the list by itself when it expires.
  clock = 1_050;
  await until(() => approvals.get().length === 0);

  // The link drops: the stream ends, then reopens and lists again, keeping the list meanwhile.
  events.line(added(ask('c', 60_000)));
  await until(() => approvals.get().length === 1);
  listing = [ask('c', 60_000), ask('d', 60_000)];
  events.end('unreachable');
  const reopened = await net.next();
  assert.equal(reopened.op, 'oc.events');
  await until(() => approvals.get().length === 2);
  assert.deepEqual(approvals.get().map((x) => x.id), ['c', 'd']);

  // Stopping closes the stream and the expiry timer; a later subscriber starts it again.
  off();
  await until(() => reopened.ended);
  const back = approvals.subscribe(() => {});
  const third = await net.next();
  await until(() => asked.filter((op) => op === 'oc.approvals').length === 3);
  back();
  await until(() => third.ended);
  assert.ok(seen.length >= 5);
});

test('coming back to the list drops what expired while nobody watched', async () => {
  let clock = 0;
  const net = stubLink((op) => (op === 'oc.approvals' ? [ask('a', 100)] : null));
  const approvals = approvalsStore(openclawDevice(net.link), { now: () => clock });
  const off = approvals.subscribe(() => {});
  await net.next();
  await until(() => approvals.get().length === 1);
  off();
  clock = 500;
  net.refuse(Object.assign(new Error('not now'), { code: 'unreachable' }));
  const back = approvals.subscribe(() => {});
  assert.deepEqual(approvals.get(), [], 'gone before the stream is back');
  back();
});

test('frames that race the listing are applied after it', async () => {
  let release!: (list: Approval[]) => void;
  const listed = new Promise<Approval[]>((r) => { release = r; });
  const net = stubLink((op) => (op === 'oc.approvals' ? listed : null));
  const approvals = approvalsStore(openclawDevice(net.link), { now: () => 0 });
  const off = approvals.subscribe(() => {});
  const events = await net.next();
  // While the list is still on its way: one resolves (it was on the list), another is added (and listed too).
  events.line(resolved(ask('old')));
  events.line(added(ask('new')));
  release([ask('old'), ask('new')]);
  await until(() => approvals.get().length > 0);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(approvals.get().map((x) => x.id), ['new']);
  off();
});

test('an unreachable or stopped link is tried again; a pairing that is gone is not', async () => {
  for (const code of ['unreachable', 'stopped']) {
    const away = stubLink(() => []);
    away.refuse(Object.assign(new Error('not now'), { code }));
    const offAway = approvalsStore(openclawDevice(away.link), { retryMs: 5 }).subscribe(() => {});
    await until(() => away.tries.count >= 3);
    away.refuse(undefined); // the link came back (its retry())
    await away.next();
    offAway();
  }

  const gone = stubLink(() => []);
  gone.refuse(Object.assign(new Error('This device was removed.'), { code: 'removed' }));
  const approvals = approvalsStore(openclawDevice(gone.link), { retryMs: 5 });
  const off = approvals.subscribe(() => {});
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(gone.tries.count, 1);
  assert.deepEqual(approvals.get(), []);
  off();
});
