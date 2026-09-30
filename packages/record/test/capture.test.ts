// BK-C2: the Capture client (docs/capability-kits.md 5.3) over the fake recorder.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Capture } from '../src/capture.ts';
import { CaptureError } from '../src/errors.ts';
import { recordGuardMs } from '../src/supervise.ts';
import { fakeRecorder, type FakeRecorderScript } from '../src/testing/index.ts';
import type { MakeOptions, RecordEvent } from '../src/types.ts';

const code = (c: string) => (e: unknown) => e instanceof CaptureError && e.code === c;

function bench(script: FakeRecorderScript = {}) {
  const dir = scratchDir('capture-client');
  const fake = fakeRecorder({ dir: join(dir, 'fake'), script });
  const root = join(dir, 'takes');
  mkdirSync(root);
  const stateDir = join(dir, 'state');
  return { dir, fake, root, stateDir, capture: new Capture({ bin: fake.bin, stateDir }) };
}

async function take(capture: Capture, root: string): Promise<string> {
  let t = '';
  for await (const e of capture.record({ source: 'x11::99', root, maxSeconds: 2 })) if (e.event === 'done') t = e.take;
  return t;
}

test('the constructor validates only: stateDir must be absolute (invalid), bin must be absolute (missing)', () => {
  assert.throws(() => new Capture({ bin: '/a/recorder', stateDir: 'state' }), code('invalid'));
  assert.throws(() => new Capture({ bin: 'recorder', stateDir: '/state' }), code('missing'));
  assert.throws(() => new Capture({ bin: '/a/recorder', stateDir: '/state', display: { DISPLAY: ':0' } as never }), code('invalid'));
  assert.throws(() => new Capture({ bin: '/a/recorder', stateDir: '/state', timeoutMs: Number.NaN }), code('invalid'));
  new Capture({ bin: '/nonexistent/recorder', stateDir: '/nonexistent/state' });
});

test('hello: missing for an absent or non-executable bin; cached after the first success; a 0700 layout', async () => {
  const dir = scratchDir('capture-hello');
  await assert.rejects(new Capture({ bin: join(dir, 'nope'), stateDir: dir }).hello(), code('missing'));
  const plain = join(dir, 'plain');
  writeFileSync(plain, '#!/bin/sh\n', { mode: 0o600 });
  await assert.rejects(new Capture({ bin: plain, stateDir: dir }).hello(), code('missing'));
  const b = bench();
  const hello = await b.capture.hello();
  assert.equal(hello.recorder.name, 'fake-recorder');
  await b.capture.hello();
  assert.equal(b.fake.invocations().length, 1);
  for (const d of ['', 'home', 'recorder', 'tmp']) assert.equal(statSync(join(b.stateDir, 'capture', d)).mode & 0o777, 0o700, d);
  assert.deepEqual(readdirSync(join(b.stateDir, 'capture')).sort(), ['home', 'recorder', 'tmp']);
});

test('hello: an out-of-range protocol is needs-update even when the rest has changed', async () => {
  const b = bench({ hello: { protocol: 2, sources: ['holo'], recorder: 'x' } as never });
  await assert.rejects(b.capture.hello(), (e: unknown) => code('needs-update')(e) && (e as CaptureError).why === 'app');
});

test('record rejects unsupported, invalid and already-recording on the first next()', async () => {
  const b = bench({ hello: { events: ['none'] }, seconds: 9999 });
  const first = (o: Parameters<Capture['record']>[0]) => b.capture.record(o).next();
  await assert.rejects(first({ source: 'android:emulator-5554', root: b.root, maxSeconds: 5 }), code('unsupported'));
  await assert.rejects(first({ source: 'x11::99', root: b.root, maxSeconds: 5, events: 'own' }), code('unsupported'));
  await assert.rejects(first({ source: 'x11:99' as never, root: b.root, maxSeconds: 5 }), code('invalid'));
  await assert.rejects(first({ source: 'x11::99', root: 'takes', maxSeconds: 5 }), code('invalid'));
  for (const maxSeconds of [0, 3601, 1.5]) await assert.rejects(first({ source: 'x11::99', root: b.root, maxSeconds }), code('invalid'));
  const ac = new AbortController();
  const running = b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 60, signal: ac.signal });
  assert.equal((await running.next()).value?.event, 'recording');
  await assert.rejects(first({ source: 'x11::99', root: b.root, maxSeconds: 5 }), code('already-recording'));
  ac.abort();
  for await (const _ of running) void _;
});

test('an abort after recording still yields done, then ends', async () => {
  const b = bench({ seconds: 9999 });
  const ac = new AbortController();
  const seen: string[] = [];
  for await (const e of b.capture.record({ source: 'screen', root: b.root, maxSeconds: 60, signal: ac.signal })) {
    seen.push(e.event);
    if (e.event === 'recording') ac.abort();
  }
  assert.deepEqual(seen, ['consent-pending', 'recording', 'done']);
  assert.ok(b.fake.invocations().some((i) => i.argv[1] === 'stop'));
});

test('an abort before recording rejects stopped', async () => {
  const b = bench({ seconds: 9999 });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects((async () => {
    for await (const _ of b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 60, signal: ac.signal })) void _;
  })(), code('stopped'));
});

test('an abort while consent is pending rejects stopped through capture stop', async () => {
  // A recorder that waits in consent until `capture stop` signals it, then answers capture-stopped (6.4 rule 4).
  const dir = scratchDir('capture-consent');
  const bin = join(dir, 'recorder');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const [, verb] = process.argv.slice(2);
const hello = { protocol: 1, recorder: { name: 'waits', version: '1' }, sources: ['screen'], android: false, events: ['none'], planner: { available: false, needsKey: false } };
const pidFile = ${JSON.stringify(join(dir, 'pid'))};
if (verb === 'hello') console.log(JSON.stringify(hello));
if (verb === 'stop') { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM'); console.log('{"stopping":true}'); }
if (verb === 'record') {
  fs.writeFileSync(pidFile, String(process.pid));
  process.on('SIGTERM', () => { console.log(JSON.stringify({ error: { code: 'capture-stopped', message: 'stopped' } })); process.exit(1); });
  console.log('{"event":"consent-pending"}');
  setInterval(() => {}, 1e6);
}
`, { mode: 0o700 });
  const capture = new Capture({ bin, stateDir: join(dir, 'state') });
  const ac = new AbortController();
  const seen: string[] = [];
  await assert.rejects((async () => {
    for await (const e of capture.record({ source: 'screen', root: join(dir, 'takes'), maxSeconds: 60, signal: ac.signal })) {
      seen.push(e.event);
      ac.abort();
    }
  })(), code('stopped'));
  assert.deepEqual(seen, ['consent-pending']);
});

test('breaking out of for await runs stop, and a record right after is not already-recording', async () => {
  const b = bench({ seconds: 9999 });
  for await (const e of b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 60 })) if (e.event === 'recording') break;
  assert.ok(b.fake.invocations().some((i) => i.argv[1] === 'stop'));
  b.fake.script({ seconds: 0 });
  const events: RecordEvent[] = [];
  for await (const e of b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 60 })) events.push(e);
  assert.deepEqual(events.map((e) => e.event), ['recording', 'done']);
});

test('a recorder error line rejects with its code; an exit without done is protocol or failed', async () => {
  const b = bench({ consent: 'timeout' });
  const run = (source: 'screen' | 'x11::99') => (async () => { for await (const _ of b.capture.record({ source, root: b.root, maxSeconds: 5 })) void _; })();
  await assert.rejects(run('screen'), code('consent-timeout'));
  b.fake.script({ corrupt: 'record' });
  await assert.rejects(run('x11::99'), code('protocol'));
});

test('stop: stopping while a recording runs, not-recording otherwise', async () => {
  const b = bench({ seconds: 9999 });
  assert.equal(await b.capture.stop(), 'not-recording');
  const it = b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 60 });
  assert.equal((await it.next()).value?.event, 'recording');
  assert.equal(await b.capture.stop(), 'stopping');
  assert.equal((await it.next()).value?.event, 'done');
  assert.deepEqual(await it.next(), { value: undefined, done: true });
});

test('the wall-clock guard: a guarded run never yields done and rejects timeout', async () => {
  const b = bench({ seconds: 9999 });
  await b.capture.hello();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const seen: string[] = [];
    const run = (async () => {
      for await (const e of b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 2 })) {
        seen.push(e.event);
        // The fake prints `done` on the guard's SIGTERM; the kit must drop it.
        if (e.event === 'recording') mock.timers.tick(recordGuardMs(2));
      }
    })();
    await assert.rejects(run, code('timeout'));
    assert.deepEqual(seen, ['recording']);
  } finally {
    mock.timers.reset();
  }
});

test('make validates before spawning: unsupported planner, relative take, NUL, maxTokens, set keys, caption start', async () => {
  const b = bench({ hello: { planner: { available: false, needsKey: true } } });
  await assert.rejects(b.capture.make({ take: '/r/t', plannerKey: 'k', maxTokens: 10 }), code('unsupported'));
  const bad: MakeOptions[] = [
    { take: 'r/t' },
    { take: '/r/t', title: 'a\0b' },
    { take: '/r/t', captions: [{ t: 0, text: '\0' }] },
    { take: '/r/t', set: { speed: 'a\0' } },
    { take: '/r/t', set: { Speed: 1 } },
    { take: '/r/t', captions: [{ t: -1, text: 'x' }] },
  ];
  const c = bench();
  for (const o of bad) await assert.rejects(c.capture.make(o), code('invalid'), JSON.stringify(o));
  for (const maxTokens of [0, 1.5, -3]) await assert.rejects(c.capture.make({ take: '/r/t', plannerKey: 'k', maxTokens }), code('invalid'));
  assert.equal(c.fake.invocations().filter((i) => i.argv[1] === 'make').length, 0);
});

test('make maps the result, passes captions through a 0600 file and deletes it after', async () => {
  const b = bench();
  const t = await take(b.capture, b.root);
  const r = await b.capture.make({ take: t, title: 'T', captions: [{ t: 0, text: 'Hi', d: 1 }], set: { speed: 2 } });
  assert.equal(r.out, join(t, 'out', 'take-1.mp4'));
  assert.deepEqual(r.planner, { plannedTokens: 0, inputTokens: 0, usd: 0, failed: false });
  const inv = b.fake.invocations().filter((i) => i.argv[1] === 'make').pop()!;
  assert.deepEqual(inv.captions, [{ t: 0, text: 'Hi', d: 1 }]);
  assert.ok(inv.argv.includes('--no-planner'));
  assert.deepEqual(readdirSync(join(b.stateDir, 'capture', 'tmp')), []);
  b.fake.script({ makeError: { code: 'render-failed', message: 'no frames' } });
  await assert.rejects(b.capture.make({ take: t, captions: [] }), code('render-failed'));
  assert.deepEqual(readdirSync(join(b.stateDir, 'capture', 'tmp')), []);
  b.fake.script({ makeError: { code: 'gpu-melted', message: 'x' } });
  await assert.rejects(b.capture.make({ take: t }), (e: unknown) =>
    code('failed')(e) && (e as CaptureError).detail?.['recorderCode'] === 'gpu-melted' && typeof (e as CaptureError).detail?.['stderrTail'] === 'string');
});

test('an abort during make rejects signal.reason, and the captions file is gone', async () => {
  const b = bench({ hang: 'make' });
  const ac = new AbortController();
  const pending = b.capture.make({ take: join(b.root, 'take-1'), captions: [{ t: 0, text: 'Hi' }], signal: ac.signal });
  for (let i = 0; i < 100 && !b.fake.invocations().some((inv) => inv.argv[1] === 'make'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(readdirSync(join(b.stateDir, 'capture', 'tmp')).length, 1);
  ac.abort();
  await assert.rejects(pending, (e: unknown) => e === ac.signal.reason && !(e instanceof CaptureError));
  assert.deepEqual(readdirSync(join(b.stateDir, 'capture', 'tmp')), []);
});

test('record passes the display session it needs, exactly, and nothing to other verbs', async () => {
  const display = {
    WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    HYPRLAND_INSTANCE_SIGNATURE: 'sig', XAUTHORITY: '/run/user/1000/xauth',
  };
  const b = bench();
  const capture = new Capture({ bin: b.fake.bin, stateDir: b.stateDir, display });
  for (const source of ['screen', 'x11::99'] as const) {
    for await (const _ of capture.record({ source, root: b.root, maxSeconds: 2 })) void _;
  }
  const home = join(b.stateDir, 'capture', 'home');
  const base = {
    HOME: home, XDG_CONFIG_HOME: `${home}/.config`, XDG_STATE_HOME: `${home}/.local/state`, XDG_CACHE_HOME: `${home}/.cache`,
    XDG_DATA_HOME: `${home}/.local/share`, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
  };
  const envs = b.fake.invocations().map((i) => [i.argv[1], i.env] as const);
  assert.deepEqual(envs, [
    ['hello', base],
    ['record', { ...base, WAYLAND_DISPLAY: 'wayland-1', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HYPRLAND_INSTANCE_SIGNATURE: 'sig' }],
    ['record', { ...base, DISPLAY: ':99', XAUTHORITY: '/run/user/1000/xauth' }],
  ]);
});

test('breaking right after done sends no capture stop that a next recording could receive', async () => {
  const b = bench();
  for await (const e of b.capture.record({ source: 'x11::99', root: b.root, maxSeconds: 2 })) if (e.event === 'done') break;
  assert.deepEqual(b.fake.invocations().map((i) => i.argv[1]), ['hello', 'record']);
});

test('an error line from a recorder that then hangs rejects the mapped code, not the guard timeout', async () => {
  const dir = scratchDir('capture-err-hang');
  const bin = join(dir, 'recorder');
  writeFileSync(bin, `#!${process.execPath}
const verb = process.argv[3];
if (verb === 'hello') console.log(JSON.stringify({ protocol: 1, recorder: { name: 'stuck', version: '1' }, sources: ['android'], android: true, events: ['none'], planner: { available: false, needsKey: false } }));
if (verb === 'record') { console.log(JSON.stringify({ error: { code: 'unsupported-source', message: 'no device' } })); setInterval(() => {}, 1e6); }
`, { mode: 0o700 });
  const capture = new Capture({ bin, stateDir: join(dir, 'state') });
  const started = Date.now();
  await assert.rejects((async () => {
    for await (const _ of capture.record({ source: 'android:emulator-5554', root: join(dir, 'takes'), maxSeconds: 3600 })) void _;
  })(), code('unsupported'));
  assert.ok(Date.now() - started < 12_000);
});
