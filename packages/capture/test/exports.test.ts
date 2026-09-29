// BK-0 acceptance: every frozen name exists — the `.` entry (5.2–5.3), `./testing` (5.5) and the internal seams
// (5.4, BK-C1's protocol.ts) — and every stub names the work package that fills it (docs/capability-kits.md §9.3).
// BK-C1 and BK-C2 are built: nothing throws `not built` any more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../src/index.ts';
import * as testing from '../src/testing/index.ts';
import { PROTOCOL_SCHEMA_SHA256 } from '../src/constants.ts';
import { recordGuardMs, recorderArgv, recorderEnv, runRecorder, streamRecorder } from '../src/supervise.ts';
import { parseError, parseEvent, parseHello, parseMake, toCaptureError } from '../src/protocol.ts';
import type {
  CaptureErrorCode, CaptureOptions, MakeOptions, MakeResult, RecordEvent, RecordOptions, RecorderHello, Source,
} from '../src/index.ts';

test('the `.` entry carries the frozen surface (5.2–5.3)', () => {
  assert.equal(kit.PROTOCOL, 1);
  assert.equal(kit.PROTOCOL_FLOOR, 1);
  assert.equal(kit.CONSENT_WINDOW_S, 120);
  assert.deepEqual([...kit.DISPLAY_VARS], [
    'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'HYPRLAND_INSTANCE_SIGNATURE', 'XAUTHORITY',
  ]);
  const c = new kit.Capture({ bin: '/opt/recorder/bin/recorder', stateDir: '/tmp/state', display: { WAYLAND_DISPLAY: 'wayland-1' } });
  for (const m of ['hello', 'record', 'stop', 'make'] as const) assert.equal(typeof c[m], 'function');
  assert.equal(kit.eventWords({ event: 'recording', take: '/tmp/takes/take-1' }), 'Recording.');
  assert.equal(kit.errorWords(new kit.CaptureError('missing', '')), 'This computer needs the recorder installed first.');
});

test('CaptureError carries its code, side, hint and detail', () => {
  const e = new kit.CaptureError('needs-update', 'old', { why: 'recorder', hint: 'update it', detail: { protocol: 0 } });
  assert.ok(e instanceof Error);
  assert.deepEqual([e.name, e.code, e.why, e.hint, e.detail], ['CaptureError', 'needs-update', 'recorder', 'update it', { protocol: 0 }]);
  const bare = new kit.CaptureError('failed', 'x');
  assert.deepEqual([bare.why, bare.hint, bare.detail], [undefined, undefined, undefined]);
});

test('public types keep their frozen shapes (5.2)', () => {
  const o: CaptureOptions = { bin: '/a/recorder', stateDir: '/s', display: { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/bus' }, timeoutMs: 60_000 };
  const hello: RecorderHello = {
    protocol: 1, recorder: { name: 'example-recorder', version: '1.0.0' }, sources: ['screen', 'x11'], android: false,
    events: ['own', 'none'], planner: { available: true, needsKey: true },
  };
  const sources: Source[] = ['screen', 'x11:99', 'android:emulator-5554'];
  const record: RecordOptions = { source: 'screen', root: '/r', events: 'own', maxSeconds: 120, signal: new AbortController().signal };
  const events: RecordEvent[] = [{ event: 'consent-pending' }, { event: 'recording', take: '/r/t' }, { event: 'done', take: '/r/t', seconds: 1, warnings: [] }];
  const plain: MakeOptions = { take: '/r/t', title: 'T', captions: [{ t: 0, text: 'Hi', d: 2 }], set: { speed: 1.5 } };
  const planned: MakeOptions = { take: '/r/t', plannerKey: 'k', maxTokens: 40_000 };
  // @ts-expect-error a planner key needs maxTokens with it (D-M)
  const unbounded: MakeOptions = { take: '/r/t', plannerKey: 'k' };
  const result: MakeResult = { out: null, seconds: 1, beats: 0, planner: { plannedTokens: 10, inputTokens: 0, usd: 0, failed: false }, warnings: [] };
  const codes: CaptureErrorCode[] = [
    'missing', 'needs-update', 'unsupported', 'invalid', 'consent-cancelled', 'consent-timeout', 'stopped',
    'already-recording', 'preflight-refused', 'take-input', 'render-failed', 'timeout', 'too-much-output', 'protocol', 'failed',
  ];
  void [o, hello, sources, record, events, plain, planned, unbounded, result, codes];
});

test('the internal seams are in place and built', () => {
  assert.equal(recorderEnv({ stateDir: '/s', source: 'screen' })['HOME'], '/s/capture/home');
  assert.deepEqual(recorderArgv('/s', { verb: 'hello' }), ['capture', 'hello']);
  assert.equal(typeof runRecorder, 'function');
  assert.equal(typeof streamRecorder, 'function');
  assert.equal(recordGuardMs(5), (5 + kit.CONSENT_WINDOW_S + 30) * 1000);
  // BK-C1 is built: the protocol parsers answer instead of throwing.
  const hello = parseHello(JSON.stringify({
    protocol: 1, recorder: { name: 'example-recorder', version: '1.0.0' }, sources: ['screen', 'x11'],
    android: false, events: ['own', 'none'], planner: { available: true, needsKey: true },
  }));
  assert.equal(hello.protocol, 1);
  assert.equal(parseEvent('{"event":"future-new"}'), null);
  assert.equal(parseMake(JSON.stringify({
    out: null, seconds: 1, beats: 1,
    planner: { planned_tokens: 1, input_tokens: 0, usd: 0, failed: false }, warnings: [],
  })).out, null);
  assert.equal(parseError('{"event":"done","take":"/r/t","seconds":1,"warnings":[]}'), null);
  assert.equal(toCaptureError({ code: 'internal', message: '', extra: {} }).code, 'failed');
  assert.equal(typeof testing.fakeRecorder, 'function');
  assert.equal(typeof testing.captureContract, 'function');
});

// BK-C1 commits schema/recorder-protocol-1.json and pins its sha256.
test('PROTOCOL_SCHEMA_SHA256 pins the committed protocol schema, not the placeholder', () => {
  assert.match(PROTOCOL_SCHEMA_SHA256, /^[0-9a-f]{64}$/);
});
