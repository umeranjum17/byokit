// The JS core over a fake NativeOverlay (docs/capability-kits.md 7.3): start checks before any native call, argument
// mapping, listener sets fed by one native listener, and createOverlay(null) unsupported everywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverlay } from '../src/overlay.ts';
import type { NativeOverlay, OverlayEvent, StartOptions, TapEntry } from '../src/types.ts';

function fakeNative() {
  const calls: [string, ...unknown[]][] = [];
  const listeners = new Set<(e: OverlayEvent) => void>();
  const taps: TapEntry[] = [{ app: 'com.example', at: 5, action: 'tap' }];
  const native: NativeOverlay = {
    state: async () => { calls.push(['state']); return 'off'; },
    openPermission: async () => { calls.push(['openPermission']); },
    start: async (o) => { calls.push(['start', o]); return 'on'; },
    stop: async () => { calls.push(['stop']); },
    say: (text, mood, ms) => { calls.push(['say', text, mood, ms]); },
    setMood: (mood) => { calls.push(['setMood', mood]); },
    setRules: (rules) => { calls.push(['setRules', rules]); },
    openPanel: async (props) => { calls.push(['openPanel', props]); },
    closePanel: async () => { calls.push(['closePanel']); },
    logTap: async (app, action) => { calls.push(['logTap', app, action]); },
    taps: async (since) => { calls.push(['taps', since]); return taps; },
    clearTaps: async () => { calls.push(['clearTaps']); },
    addListener: (event, fn) => {
      calls.push(['addListener', event]);
      listeners.add(fn);
      return { remove: () => { listeners.delete(fn); } };
    },
  };
  return { native, calls, emit: (e: OverlayEvent) => { for (const fn of listeners) fn(e); } };
}

const notice = { channel: 'bubble', title: 'Bubble', text: 'On', icon: 'ic_bubble' };
const rules = { paused: false, on: [], off: [], defaults: ['com.example'] };

test('start rejects bad options before any native call', async () => {
  const { native, calls } = fakeNative();
  const o = createOverlay(native);
  const bad: [StartOptions, RegExp][] = [
    [{ host: 'window', mood: 'calm' }, /^overlay: .*notice/],
    [{ host: 'window', mood: 'calm', notice, rules }, /^overlay: .*rules/],
    [{ host: 'window', mood: 'calm', notice, spots: 'per-app' }, /^overlay: .*per-app/],
    [{ host: 'accessibility', mood: 'Calm' }, /^overlay: .*mood/],
    [{ host: 'accessibility', mood: '1calm' }, /^overlay: .*mood/],
    [{ host: 'accessibility', mood: 'calm-face' }, /^overlay: .*mood/],
    [{ host: 'accessibility', mood: '' }, /^overlay: .*mood/],
    [{ host: 'accessibility', mood: `a${'b'.repeat(64)}` }, /^overlay: .*mood/],
  ];
  for (const [opts, why] of bad) await assert.rejects(o.start(opts), (e: Error) => e instanceof Error && why.test(e.message), JSON.stringify(opts));
  assert.deepEqual(calls, []);
  const good: StartOptions[] = [
    { host: 'window', mood: 'calm', notice, spots: 'global', panel: 'Panel', hideWhilePanelOpen: false },
    { host: 'accessibility', mood: `a${'b'.repeat(63)}`, rules, spots: 'per-app' },
    { host: 'accessibility', mood: 'calm_2' },
  ];
  for (const opts of good) assert.equal(await o.start(opts), 'on');
  assert.deepEqual(calls, good.map((opts) => ['start', opts]));
});

test('every method reaches the native module, with the documented defaults', async () => {
  const { native, calls } = fakeNative();
  const o = createOverlay(native);
  assert.equal(await o.state(), 'off');
  await o.openPermission();
  await o.stop();
  o.say('Hi');
  o.say('Done', 'happy', 900);
  o.setMood('calm');
  o.setRules(rules);
  await o.openPanel();
  await o.openPanel({ draft: 'x' });
  await o.closePanel();
  await o.logTap({ app: 'com.example', action: 'tap' });
  assert.deepEqual(await o.taps(), [{ app: 'com.example', at: 5, action: 'tap' }]);
  await o.taps({ since: 42 });
  await o.clearTaps();
  assert.deepEqual(calls, [
    ['state'], ['openPermission'], ['stop'], ['say', 'Hi', null, 2500], ['say', 'Done', 'happy', 900],
    ['setMood', 'calm'], ['setRules', rules], ['openPanel', {}], ['openPanel', { draft: 'x' }], ['closePanel'],
    ['logTap', 'com.example', 'tap'], ['taps', 0], ['taps', 42], ['clearTaps'],
  ]);
});

test('listener sets: one native listener, both listeners fire, a throwing one stops nothing, removers work', () => {
  const { native, calls, emit } = fakeNative();
  const o = createOverlay(native);
  const seen: string[] = [];
  const offA = o.on('tap', () => { seen.push('a'); });
  o.on('tap', () => { throw new Error('boom'); });
  const offB = o.on('tap', () => { seen.push('b'); });
  const moved: OverlayEvent[] = [];
  o.on('moved', (e) => { moved.push(e); assert.equal(e.edge, 'right'); });
  o.on('state', (e) => { seen.push(e.state); });
  assert.deepEqual(calls, [['addListener', 'overlay']], 'one native listener for every type');
  emit({ type: 'tap' });
  assert.deepEqual(seen, ['a', 'b']);
  emit({ type: 'moved', edge: 'right', y: 0.4 });
  emit({ type: 'state', state: 'stuck' });
  emit({ type: 'longPress' });
  assert.deepEqual(moved, [{ type: 'moved', edge: 'right', y: 0.4 }]);
  assert.deepEqual(seen, ['a', 'b', 'stuck']);
  offA();
  emit({ type: 'tap' });
  assert.deepEqual(seen, ['a', 'b', 'stuck', 'b']);
  offB();
  offB();
  emit({ type: 'tap' });
  assert.deepEqual(seen, ['a', 'b', 'stuck', 'b'], 'removed twice is still removed once');
});

test('the same function added twice fires twice, and each remover takes one away', () => {
  const { native, emit } = fakeNative();
  const o = createOverlay(native);
  let n = 0;
  const fn = () => { n++; };
  const off1 = o.on('panel', fn);
  o.on('panel', fn);
  emit({ type: 'panel', open: true });
  assert.equal(n, 2);
  off1();
  emit({ type: 'panel', open: false });
  assert.equal(n, 3);
});

test('createOverlay(null) is unsupported everywhere and does nothing', async () => {
  const o = createOverlay(null);
  assert.equal(await o.state(), 'unsupported');
  assert.equal(await o.start({ host: 'window', mood: 'calm', notice }), 'unsupported');
  assert.equal(await o.start({ host: 'window', mood: 'BAD' }), 'unsupported', 'no module, nothing to check against');
  for (const p of [o.openPermission(), o.stop(), o.openPanel(), o.openPanel({ a: 'b' }), o.closePanel(), o.logTap({ app: 'a', action: 'b' }), o.clearTaps()]) {
    assert.equal(await p, undefined);
  }
  assert.deepEqual(await o.taps(), []);
  assert.deepEqual(await o.taps({ since: 1 }), []);
  assert.equal(o.say('Hi'), undefined);
  assert.equal(o.setMood('calm'), undefined);
  assert.equal(o.setRules(rules), undefined);
  const off = o.on('tap', () => assert.fail('never fires'));
  assert.equal(typeof off, 'function');
  off();
});
