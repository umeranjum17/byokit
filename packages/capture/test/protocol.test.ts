// BK-C1: wire parsers for recorder protocol v1 (docs/capability-kits.md 6.3–6.7, 9.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureError } from '../src/errors.ts';
import { parseError, parseEvent, parseHello, parseMake, toCaptureError } from '../src/protocol.ts';

const HELLO = JSON.stringify({
  protocol: 1,
  recorder: { name: 'example-recorder', version: '2.3.0' },
  sources: ['screen', 'x11'],
  android: false,
  events: ['own', 'none'],
  planner: { available: true, needsKey: true },
});

test('parseHello accepts the 6.3 example', () => {
  const hello = parseHello(HELLO);
  assert.equal(hello.protocol, 1);
  assert.deepEqual(hello.recorder, { name: 'example-recorder', version: '2.3.0' });
  assert.deepEqual(hello.sources, ['screen', 'x11']);
  assert.equal(hello.android, false);
  assert.deepEqual(hello.events, ['own', 'none']);
  assert.deepEqual(hello.planner, { available: true, needsKey: true });
});

test('parseHello checks the protocol range before any other field', () => {
  const changed = JSON.stringify({ protocol: 2, recorder: 42, sources: 'nope' });
  assert.throws(() => parseHello(changed), (error: unknown) => {
    assert.ok(error instanceof CaptureError);
    assert.equal(error.code, 'needs-update');
    assert.equal(error.why, 'app');
    return true;
  });
  const old = JSON.stringify({ protocol: 0 });
  assert.throws(() => parseHello(old), (error: unknown) => {
    assert.ok(error instanceof CaptureError);
    assert.equal(error.code, 'needs-update');
    assert.equal(error.why, 'recorder');
    return true;
  });
});

test('parseHello rejects shape violations with protocol', () => {
  const bad = [
    'not json',
    '{}',
    JSON.stringify({ protocol: '1' }),
    JSON.stringify({ protocol: 1.5, recorder: { name: 'a', version: 'v' }, sources: ['screen'], android: false, events: ['none'], planner: { available: true, needsKey: true } }),
    HELLO.replace('example-recorder', 'Bad Name!'),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: '' }, sources: ['screen'], android: false, events: ['none'], planner: { available: true, needsKey: true } }),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: 'v' }, sources: [], android: false, events: ['none'], planner: { available: true, needsKey: true } }),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: 'v' }, sources: ['screen', 'screen'], android: false, events: ['none'], planner: { available: true, needsKey: true } }),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: 'v' }, sources: ['screen', 'android'], android: false, events: ['none'], planner: { available: true, needsKey: true } }),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: 'v' }, sources: ['screen'], android: false, events: ['own'], planner: { available: true, needsKey: true } }),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: 'v' }, sources: ['screen'], android: false, events: [], planner: { available: true, needsKey: true } }),
    JSON.stringify({ protocol: 1, recorder: { name: 'a', version: 'v' }, sources: ['screen'], android: false, events: ['none'], planner: { available: true } }),
  ];
  for (const line of bad) {
    assert.throws(() => parseHello(line), (error: unknown) => {
      assert.ok(error instanceof CaptureError);
      assert.equal((error as CaptureError).code, 'protocol');
      return true;
    }, line);
  }
});

test('parseEvent reads the 6.4 events and drops unknown ones', () => {
  assert.deepEqual(parseEvent('{"event":"consent-pending"}'), { event: 'consent-pending' });
  assert.deepEqual(parseEvent('{"event":"recording","take":"/r/take-1"}'), { event: 'recording', take: '/r/take-1' });
  assert.deepEqual(parseEvent('{"event":"done","take":"/r/take-1","seconds":12.4,"warnings":["w"]}'), {
    event: 'done', take: '/r/take-1', seconds: 12.4, warnings: ['w'],
  });
  assert.equal(parseEvent('{"event":"future-new","take":"/r/t"}'), null);
  assert.equal(parseEvent('{"error":{"code":"internal","message":"x"}}'), null);
  assert.throws(() => parseEvent('not json'), (e: unknown) => (e as CaptureError).code === 'protocol');
  assert.throws(() => parseEvent('{"event":"recording"}'), (e: unknown) => (e as CaptureError).code === 'protocol');
  assert.throws(() => parseEvent('{"event":"recording","take":"relative"}'), (e: unknown) => (e as CaptureError).code === 'protocol');
  assert.throws(() => parseEvent('{"event":"done","take":"/r/t","seconds":"x","warnings":[]}'), (e: unknown) => (e as CaptureError).code === 'protocol');
});

test('parseMake maps the 6.6 snake_case planner fields', () => {
  const line = JSON.stringify({
    out: '/r/take-7/out/take-7.mp4', seconds: 12.4, beats: 6,
    planner: { planned_tokens: 0, input_tokens: 0, usd: 0, failed: false }, warnings: [],
  });
  assert.deepEqual(parseMake(line), {
    out: '/r/take-7/out/take-7.mp4', seconds: 12.4, beats: 6,
    planner: { plannedTokens: 0, inputTokens: 0, usd: 0, failed: false }, warnings: [],
  });
  const planOnly = JSON.stringify({
    out: null, seconds: 1, beats: 1,
    planner: { planned_tokens: 1000, input_tokens: 0, usd: 0, failed: false }, warnings: [],
  });
  assert.equal(parseMake(planOnly).out, null);
  for (const bad of ['not json', '{}', JSON.stringify({ out: 'relative', seconds: 1, beats: 1, planner: { planned_tokens: 0, input_tokens: 0, usd: 0, failed: false }, warnings: [] })]) {
    assert.throws(() => parseMake(bad), (e: unknown) => (e as CaptureError).code === 'protocol');
  }
});

test('parseError reads the 6.7 envelope and returns null otherwise', () => {
  const parsed = parseError('{"error":{"code":"preflight-refused","message":"planned 48000 tokens, cap 40000","hint":"raise --max-tokens","planned":48000,"cap":40000}}');
  assert.deepEqual(parsed, {
    code: 'preflight-refused', message: 'planned 48000 tokens, cap 40000', hint: 'raise --max-tokens',
    extra: { planned: 48000, cap: 40000 },
  });
  assert.equal(parseError('{"event":"done","take":"/r/t","seconds":1,"warnings":[]}'), null);
  assert.equal(parseError('not json'), null);
  assert.equal(parseError('{"error":{"code":42}}'), null);
});

test('toCaptureError covers the whole 6.7 table', () => {
  const cases: Array<[string, string]> = [
    ['invalid-arguments', 'protocol'],
    ['unsupported-source', 'unsupported'],
    ['consent-cancelled', 'consent-cancelled'],
    ['consent-timeout', 'consent-timeout'],
    ['capture-stopped', 'stopped'],
    ['already-recording', 'already-recording'],
    ['preflight-refused', 'preflight-refused'],
    ['take-input', 'take-input'],
    ['render-failed', 'render-failed'],
    ['internal', 'failed'],
    ['something-new', 'failed'],
  ];
  for (const [wire, kit] of cases) {
    const error = toCaptureError({ code: wire, message: wire, extra: {} });
    assert.ok(error instanceof CaptureError);
    assert.equal(error.code, kit, wire);
  }
  const preflight = toCaptureError({ code: 'preflight-refused', message: 'm', extra: { planned: 48_000, cap: 40_000 } });
  assert.deepEqual(preflight.detail, { planned: 48_000, cap: 40_000 });
  const failed = toCaptureError({ code: 'internal', message: 'm', hint: 'h', extra: {} });
  assert.equal(failed.hint, 'h');
  assert.deepEqual(failed.detail, { recorderCode: 'internal' });
});
