// DeviceLink.ping with controlled time: a frozen device clock (an app in the background, a hidden tab)
// must not drop a healthy link, while a host that is really silent still drops after missing the
// pings that follow. Drives the private ping directly with stubbed Date.now/setTimeout: fully
// synchronous, so no test timer ever fires while the globals are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceLink } from '../src/index.ts';

const every = 1000;

function rig() {
  let now = 1_000_000;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const ticks: (() => void)[] = [];
  Date.now = () => now;
  (globalThis as any).setTimeout = (fn: () => void) => { ticks.push(fn); return { unref() {} }; };
  const link: any = Object.create(DeviceLink.prototype);
  const sent: unknown[] = [];
  let closed = 0, lost = 0;
  const conn = { send: (m: unknown) => { sent.push(m); }, close: () => { closed++; } };
  link.o = { pingMs: every };
  link.conn = conn;
  link.pingId = 0;
  link.heard = now;
  link.lost = () => { lost++; };
  return {
    link, conn, sent, ticks,
    state: () => ({ closed, lost }),
    setNow: (t: number) => { now = t; },
    run: (i: number) => ticks[i](),
    restore: () => { Date.now = realNow; (globalThis as any).setTimeout = realSetTimeout; },
  };
}

test('C2: a tick that fires more than every/2 late resets heard and does not close', () => {
  const r = rig();
  try {
    r.link.heard = 1_000_000 - 3 * every; // silent long enough that an on-time tick would close
    r.link.ping(r.conn); // due = now + every
    assert.equal(r.ticks.length, 1);
    r.setNow(1_000_000 + every + every / 2 + 1); // the device's timers were frozen past the tick
    r.run(0);
    assert.deepEqual(r.state(), { closed: 0, lost: 0 }, 'frozen timers are not host silence');
    assert.equal(r.link.heard, 1_000_000 + every + every / 2 + 1, 'the silence is counted from now');
    assert.equal(r.sent.length, 1, 'a ping still goes out');
    assert.equal(r.ticks.length, 2, 'the watch continues');
  } finally { r.restore(); }
});

test('C2: a really silent host still closes after 2*every of on-time ticks', () => {
  const r = rig();
  try {
    r.link.ping(r.conn); // due = now + every
    r.setNow(1_000_000 + every);
    r.run(0); // heard one round ago: alive
    assert.deepEqual(r.state(), { closed: 0, lost: 0 });
    r.setNow(1_000_000 + 2 * every);
    r.run(1); // exactly two silent rounds: still alive, the check is strict
    assert.deepEqual(r.state(), { closed: 0, lost: 0 });
    assert.equal(r.sent.length, 2);
    r.setNow(1_000_000 + 2 * every + 1);
    r.run(2); // past two silent rounds of on-time ticks: the socket is dead
    assert.deepEqual(r.state(), { closed: 1, lost: 1 });
    assert.equal(r.sent.length, 2, 'nothing goes out after the close');
    assert.equal(r.ticks.length, 3, 'the watch stops');
  } finally { r.restore(); }
});

test('C2: after a frozen tick, continued silence still closes', () => {
  const r = rig();
  try {
    r.link.ping(r.conn); // due = now + every
    r.setNow(1_000_000 + 3 * every); // frozen long past the tick: resets, does not close
    r.run(0);
    assert.deepEqual(r.state(), { closed: 0, lost: 0 });
    assert.equal(r.link.heard, 1_000_000 + 3 * every);
    r.setNow(1_000_000 + 4 * every);
    r.run(1); // one silent round after the thaw
    assert.deepEqual(r.state(), { closed: 0, lost: 0 });
    r.setNow(1_000_000 + 5 * every);
    r.run(2); // two silent rounds: still alive, the check is strict
    assert.deepEqual(r.state(), { closed: 0, lost: 0 });
    r.setNow(1_000_000 + 5 * every + 1);
    r.run(3); // past two silent rounds of on-time ticks: the socket is dead
    assert.deepEqual(r.state(), { closed: 1, lost: 1 });
  } finally { r.restore(); }
});

test('C2: a tick due exactly every/2 late still counts as on time', () => {
  const r = rig();
  try {
    r.link.heard = 1_000_000 - 2 * every - 1; // one millisecond past silent: an on-time tick closes
    r.link.ping(r.conn);
    r.setNow(1_000_000 + every + every / 2); // late by exactly every/2: not frozen (the check is strict)
    r.run(0);
    assert.deepEqual(r.state(), { closed: 1, lost: 1 });
  } finally { r.restore(); }
});
