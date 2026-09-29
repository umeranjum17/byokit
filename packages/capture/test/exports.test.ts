// BK-0 acceptance: every frozen name exists — the `.` entry (5.2–5.3), `./testing` (5.5) and the internal seams
// (5.4, BK-C1's protocol.ts) — and every stub names the work package that fills it (docs/capability-kits.md §9.3).
import { test, todo } from 'node:test';
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
  assert.throws(() => c.hello(), /BK-C2/);
  assert.throws(() => c.record({ source: 'x11:99', root: '/tmp/takes', maxSeconds: 5 }), /BK-C2/);
  assert.throws(() => c.stop(), /BK-C2/);
  assert.throws(() => c.make({ take: '/tmp/takes/take-1', planOnly: true }), /BK-C2/);
  assert.throws(() => kit.eventWords({ event: 'recording', take: '/tmp/takes/take-1' }), /BK-C2/);
  assert.throws(() => kit.errorWords(new kit.CaptureError('missing', '')), /BK-C2/);
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

test('the internal seams are in place; bodies land with their work packages', () => {
  assert.throws(() => recorderEnv({ stateDir: '/s', source: 'screen' }), /BK-C2/);
  assert.throws(() => recorderArgv('/s', { verb: 'hello' }), /BK-C2/);
  assert.throws(() => runRecorder('/a/recorder', {}, ['capture', 'hello'], { timeoutMs: 10_000 }), /BK-C2/);
  assert.throws(() => streamRecorder('/a/recorder', {}, ['capture', 'record'], { guardMs: 1000 }), /BK-C2/);
  assert.throws(() => recordGuardMs(5), /BK-C2/);
  for (const parse of [parseHello, parseEvent, parseMake, parseError]) assert.throws(() => parse('{}'), /BK-C1/);
  assert.throws(() => toCaptureError({ code: 'internal', message: '', extra: {} }), /BK-C1/);
  assert.throws(() => testing.fakeRecorder({ dir: '/tmp/fake' }), /BK-C1/);
  assert.throws(() => testing.captureContract(async () => ({ capture: new kit.Capture({ bin: '/a', stateDir: '/s' }), source: 'x11:99', root: '/r' })), /BK-C1/);
});

// BK-C1 commits schema/recorder-protocol-1.json and pins its sha256.
todo('PROTOCOL_SCHEMA_SHA256 pins the committed protocol schema, not the placeholder', () => {
  assert.match(PROTOCOL_SCHEMA_SHA256, /^[0-9a-f]{64}$/);
});
