// The JS core over a fake NativeStatus (docs/capability-kits.md 12.3): show checks before any native call, the channel
// name from words, listener sets fed by one native listener, and createStatus(null) unsupported everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStatus } from '../src/status.ts';
import { words } from '../src/words.ts';
import type { NativeStatus, ShowOptions, StatusEvent } from '../src/types.ts';

function fakeNative() {
  const calls: [string, ...unknown[]][] = [];
  const listeners = new Set<(e: StatusEvent) => void>();
  const native: NativeStatus = {
    show: (o) => { calls.push(['show', o]); },
    clear: () => { calls.push(['clear']); },
    state: async () => { calls.push(['state']); return 'on'; },
    openSettings: async () => { calls.push(['openSettings']); },
    addListener: (event, fn) => {
      calls.push(['addListener', event]);
      listeners.add(fn);
      return { remove: () => { listeners.delete(fn); } };
    },
  };
  return { native, calls, emit: (e: StatusEvent) => { for (const fn of listeners) fn(e); } };
}

const ok: ShowOptions = {
  title: 'Scribe is working', text: '2 need you', chip: '2 busy', publicText: '2 working · 2 need you', promote: true,
  actions: [{ id: 'needs', label: 'See what needs you' }, { id: 'ask', label: 'Ask Chief' }, { id: 'open', label: 'Open' }],
  timeoutMs: 900_000, icon: 'ic_crew',
};

const bad: [Partial<ShowOptions>, RegExp][] = [
  [{ title: '' }, /title/],
  [{ title: '  ' }, /title/],
  [{ chip: '12345678' }, /chip/],
  [{ chip: '😀'.repeat(8) }, /chip/],
  [{ timeoutMs: 999 }, /timeoutMs/],
  [{ timeoutMs: 1000.5 }, /timeoutMs/],
  [{ timeoutMs: Number.NaN }, /timeoutMs/],
  [{ icon: 'Crew' }, /icon/],
  [{ actions: [...ok.actions!, { id: 'more', label: 'More' }] }, /at most 3/],
  [{ actions: [{ id: 'Open', label: 'Open' }] }, /action id/],
  [{ actions: [{ id: `a${'b'.repeat(32)}`, label: 'Open' }] }, /action id/],
  [{ actions: [{ id: 'open', label: ' ' }] }, /label/],
  [{ actions: [{ id: 'open', label: 'Open' }, { id: 'open', label: 'Again' }] }, /unique/],
];

test('show rejects bad options before any native call, on every platform', () => {
  const { native, calls } = fakeNative();
  for (const s of [createStatus(native), createStatus(null)]) {
    for (const [change, why] of bad) {
      assert.throws(() => s.show({ ...ok, ...change }), (e: Error) => /^status: /.test(e.message) && why.test(e.message), JSON.stringify(change));
    }
  }
  assert.deepEqual(calls, []);
});

test('show passes the options with the channel name from words; the rest map straight through', async () => {
  const { native, calls } = fakeNative();
  const s = createStatus(native);
  const good: ShowOptions[] = [
    ok,
    { title: 'Working', text: '', chip: '', publicText: '1 working', promote: false, timeoutMs: 1000 },
    { ...ok, chip: '😀'.repeat(7), actions: [{ id: `a${'b'.repeat(31)}`, label: 'x' }] },
  ];
  for (const o of good) s.show(o);
  s.clear();
  assert.equal(await s.state(), 'on');
  await s.openSettings();
  assert.deepEqual(calls, [
    ...good.map((o) => ['show', { ...o, channel: words('status.channel') }]),
    ['clear'], ['state'], ['openSettings'],
  ]);
});

test('listener sets: one native listener, each event to its own type, a throwing listener never stops the rest', () => {
  const { native, calls, emit } = fakeNative();
  const s = createStatus(native);
  const got: string[] = [];
  s.on('action', () => { throw new Error('boom'); });
  const offA = s.on('action', (e) => got.push(`a:${e.id}`));
  s.on('action', (e) => got.push(`b:${e.id}`));
  s.on('dismissed', (e) => got.push(e.type));
  assert.deepEqual(calls, [['addListener', 'status']]);
  emit({ type: 'action', id: 'needs' });
  emit({ type: 'dismissed' });
  offA();
  emit({ type: 'action', id: 'ask' });
  assert.deepEqual(got, ['a:needs', 'b:needs', 'dismissed', 'b:ask']);
});

test('the same function added twice is removed once per remover', () => {
  const { native, emit } = fakeNative();
  const s = createStatus(native);
  let n = 0;
  const fn = () => { n++; };
  const off1 = s.on('dismissed', fn);
  s.on('dismissed', fn);
  emit({ type: 'dismissed' });
  off1();
  emit({ type: 'dismissed' });
  assert.equal(n, 3);
});

test('createStatus(null) is unsupported everywhere', async () => {
  const s = createStatus(null);
  assert.equal(await s.state(), 'unsupported');
  s.show(ok);
  s.clear();
  await s.openSettings();
  const off = s.on('action', () => assert.fail('no events'));
  off();
});
