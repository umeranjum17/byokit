// Consumer journeys for the published @byokit/record surface, driven the way an app uses it: a `Capture` over a
// recorder bin, exactly as the README shows. The built package (`@byokit/record`, `@byokit/record/testing`) is
// imported, never `../src`. Every security and correctness contract the old unit and mock-heavy cases held survives
// as an assertion inside a journey: version skew is refused on the right side, the recorder never sees an ambient
// variable or key, nothing is kept on a refusal, and every failure maps to the typed error and plain sentence the
// app shows. No network, no display, no owner's files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../../test-support.ts';
import { Capture, CaptureError, errorWords, eventWords, words } from '@byokit/record';
import { captureContract, fakeRecorder } from '@byokit/record/testing';
import type { CaptureErrorCode, RecordEvent, WordKey } from '@byokit/record';

const code = (c: string) => (e: unknown) => e instanceof CaptureError && e.code === c;

function bench(script = {}) {
  const dir = scratchDir('record-journey');
  const fake = fakeRecorder({ dir: join(dir, 'recorder'), script });
  const root = join(dir, 'takes');
  mkdirSync(root);
  const stateDir = join(dir, 'state');
  return { dir, fake, root, stateDir, capture: new Capture({ bin: fake.bin, stateDir }) };
}

async function record(capture: Capture, o: Parameters<Capture['record']>[0]): Promise<RecordEvent[]> {
  const events: RecordEvent[] = [];
  for await (const e of capture.record(o)) events.push(e);
  return events;
}

async function take(capture: Capture, root: string): Promise<string> {
  let t = '';
  for await (const e of capture.record({ source: 'x11::99', root, maxSeconds: 2 })) if (e.event === 'done') t = e.take;
  return t;
}

test('an external recorder passes the published conformance suite, driven through the built package', async () => {
  const cases: Array<{ name: string; run: (t: { skip(message?: string): void }) => void | Promise<void> }> = [];
  captureContract(async () => {
    const b = bench();
    return { capture: b.capture, source: 'x11::99', root: b.root, fake: b.fake };
  }, (name, run) => { cases.push({ name, run }); });
  assert.equal(cases.length, 15, 'the whole BK-C2 contract registers');
  for (const c of cases) {
    await c.run({ skip: (message?: string) => { throw new Error(`unexpected skip ${c.name}: ${message ?? ''}`); } });
  }
});

test('stopping, aborting and breaking out of a recording leave the app with clean, private state', async () => {
  // Constructor and hello fail early and cheaply: relative state, unknown display, absent or plain bin.
  assert.throws(() => new Capture({ bin: '/a/recorder', stateDir: 'state' }), code('invalid'));
  assert.throws(() => new Capture({ bin: 'recorder', stateDir: '/state' }), code('missing'));
  assert.throws(() => new Capture({ bin: '/a/recorder', stateDir: '/state', display: { DISPLAY: ':0' } as never }), code('invalid'));
  assert.throws(() => new Capture({ bin: '/a/recorder', stateDir: '/state', timeoutMs: Number.NaN }), code('invalid'));
  const absent = bench();
  await assert.rejects(new Capture({ bin: join(absent.dir, 'nope'), stateDir: absent.stateDir }).hello(), code('missing'));

  // hello is cached: a second call spawns nothing.
  const b = bench();
  assert.equal((await b.capture.hello()).recorder.name, 'fake-recorder');
  await b.capture.hello();
  assert.equal(b.fake.invocations().filter((i) => i.argv[1] === 'hello').length, 1);

  // abort before frames: stopped, and the take and captions working files are private and cleared.
  const pre = bench({ seconds: 9999 });
  const preAc = new AbortController();
  preAc.abort();
  await assert.rejects(record(pre.capture, { source: 'x11::99', root: pre.root, maxSeconds: 60, signal: preAc.signal }), code('stopped'));

  // stop() toggles; an overlapping record is refused; breaking out runs a capture stop and the next record starts.
  const c = bench({ seconds: 9999 });
  assert.equal(await c.capture.stop(), 'not-recording');
  const it = c.capture.record({ source: 'x11::99', root: c.root, maxSeconds: 60 });
  assert.equal((await it.next()).value?.event, 'recording');
  await assert.rejects(c.capture.record({ source: 'x11::99', root: c.root, maxSeconds: 5 }).next(), code('already-recording'));
  assert.equal(await c.capture.stop(), 'stopping');
  assert.equal((await it.next()).value?.event, 'done');
  assert.deepEqual(await it.next(), { value: undefined, done: true });
  for (const d of ['', 'home', 'recorder', 'tmp']) assert.equal(statSync(join(c.stateDir, 'capture', d)).mode & 0o777, 0o700, d);

  const d = bench({ seconds: 9999 });
  for await (const e of d.capture.record({ source: 'x11::99', root: d.root, maxSeconds: 60 })) if (e.event === 'recording') break;
  assert.ok(d.fake.invocations().some((i) => i.argv[1] === 'stop'));
  d.fake.script({ seconds: 0 });
  assert.deepEqual((await record(d.capture, { source: 'x11::99', root: d.root, maxSeconds: 60 })).map((e) => e.event), ['recording', 'done']);

  // make passes captions through a private working file it deletes afterwards; an abort settles with the signal.
  const made = await d.capture.make({ take: await take(d.capture, d.root), title: 'Umer', captions: [{ t: 0, text: 'Hi', d: 1 }], set: { speed: 2 } });
  assert.ok(made.out?.endsWith('.mp4'));
  assert.deepEqual(readdirSync(join(d.stateDir, 'capture', 'tmp')), []);

  const hang = bench({ hang: 'make' });
  const ac = new AbortController();
  const pending = hang.capture.make({ take: join(hang.root, 'take-1'), captions: [{ t: 0, text: 'Hi' }], signal: ac.signal });
  for (let i = 0; i < 100 && !hang.fake.invocations().some((inv) => inv.argv[1] === 'make'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(readdirSync(join(hang.stateDir, 'capture', 'tmp')).length, 1);
  ac.abort();
  await assert.rejects(pending, (e: unknown) => e === ac.signal.reason && !(e instanceof CaptureError));
  assert.deepEqual(readdirSync(join(hang.stateDir, 'capture', 'tmp')), []);
});

test('version skew and every misbehaving recorder become the typed error and plain sentence an app shows', async () => {
  // Version skew is decided before any other field, and names the older side.
  await assert.rejects(bench({ hello: { protocol: 0 } }).capture.hello(), (e: unknown) => code('needs-update')(e) && (e as CaptureError).why === 'recorder');
  await assert.rejects(bench({ hello: { protocol: 2 } }).capture.hello(), (e: unknown) => code('needs-update')(e) && (e as CaptureError).why === 'app');

  // Shape and source-grammar violations are refused before anything runs; a bad source or event mode is typed.
  await assert.rejects(bench({ corrupt: 'hello' }).capture.hello(), code('protocol'));
  const grammar = bench({ hello: { events: ['none'] } });
  await assert.rejects(record(grammar.capture, { source: 'android:emulator-5554', root: grammar.root, maxSeconds: 5 }), code('unsupported'));
  await assert.rejects(record(grammar.capture, { source: 'x11::99', root: grammar.root, maxSeconds: 5, events: 'own' }), code('unsupported'));
  await assert.rejects(record(grammar.capture, { source: 'x11:99' as never, root: grammar.root, maxSeconds: 5 }), code('invalid'));
  await assert.rejects(record(grammar.capture, { source: 'x11::99', root: 'relative', maxSeconds: 5 }), code('invalid'));
  await assert.rejects(record(grammar.capture, { source: 'x11::99', root: grammar.root, maxSeconds: 1.5 }), code('invalid'));

  // Consent outcomes keep nothing, a corrupt record line is protocol, a stall is timeout.
  const refused = bench({ consent: 'no' });
  await assert.rejects(record(refused.capture, { source: 'screen', root: refused.root, maxSeconds: 2 }), code('consent-cancelled'));
  assert.deepEqual(readdirSync(refused.root), []);
  const timedOut = bench({ consent: 'timeout' });
  await assert.rejects(record(timedOut.capture, { source: 'screen', root: timedOut.root, maxSeconds: 2 }), code('consent-timeout'));
  const corrupt = bench({ corrupt: 'record' });
  await assert.rejects(record(corrupt.capture, { source: 'x11::99', root: corrupt.root, maxSeconds: 2 }), code('protocol'));
  await assert.rejects(bench({ hang: 'hello' }).capture.hello(), code('timeout'));

  // A cap below the estimate carries the numbers; a render failure and an unknown code map as typed.
  const cap = bench();
  const capTake = await take(cap.capture, cap.root);
  await assert.rejects(cap.capture.make({ take: capTake, plannerKey: 'k', maxTokens: 1 }), (e: unknown) =>
    code('preflight-refused')(e) && typeof (e as CaptureError).detail?.['planned'] === 'number' && typeof (e as CaptureError).detail?.['cap'] === 'number');
  cap.fake.script({ makeError: { code: 'render-failed', message: 'no frames' } });
  await assert.rejects(cap.capture.make({ take: capTake }), code('render-failed'));
  cap.fake.script({ makeError: { code: 'gpu-melted', message: 'x' } });
  await assert.rejects(cap.capture.make({ take: capTake }), (e: unknown) => code('failed')(e) && (e as CaptureError).detail?.['recorderCode'] === 'gpu-melted');

  // Every sentence a person can read is plain, and every code maps to its sentence without leaking the log-only text.
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  const keys: WordKey[] = ['capture.missing', 'capture.needsUpdate.recorder', 'capture.needsUpdate.app', 'capture.unsupported', 'capture.consentPending', 'capture.recording', 'capture.done', 'capture.consentCancelled', 'capture.consentTimeout', 'capture.stopped', 'capture.busy', 'capture.making', 'capture.made', 'capture.overLimit', 'capture.takeMissing', 'capture.renderFailed', 'capture.timeout', 'capture.failed'];
  for (const k of keys) assert.doesNotMatch(words(k).replace(/\{\w+\}/g, 'X'), banned, k);
  const expected: Record<CaptureErrorCode, WordKey> = {
    missing: 'capture.missing', 'needs-update': 'capture.needsUpdate.recorder', unsupported: 'capture.unsupported',
    'consent-cancelled': 'capture.consentCancelled', 'consent-timeout': 'capture.consentTimeout', stopped: 'capture.stopped',
    'already-recording': 'capture.busy', 'preflight-refused': 'capture.overLimit', 'take-input': 'capture.takeMissing',
    'render-failed': 'capture.renderFailed', timeout: 'capture.timeout', invalid: 'capture.failed',
    'too-much-output': 'capture.failed', protocol: 'capture.failed', failed: 'capture.failed',
  };
  for (const [c, key] of Object.entries(expected)) {
    const sentence = errorWords(new CaptureError(c as CaptureErrorCode, 'log only', { hint: 'log only' }));
    assert.equal(sentence, words(key as WordKey), c);
    assert.equal(sentence.includes('log only'), false, c);
  }
  assert.equal(errorWords(new CaptureError('needs-update', '', { why: 'app' })), words('capture.needsUpdate.app'));
  assert.equal(eventWords({ event: 'consent-pending' }), words('capture.consentPending'));
  assert.equal(eventWords({ event: 'recording', take: '/r/t' }), words('capture.recording'));
  assert.equal(eventWords({ event: 'done', take: '/r/t', seconds: 1, warnings: [] }), words('capture.done'));

  // The shipped protocol schema is still the pinned wire contract external recorders read.
  const entry = fileURLToPath(import.meta.resolve('@byokit/record'));
  const schema = readFileSync(join(dirname(entry), '..', 'schema', 'recorder-protocol-1.json'));
  assert.equal(createHash('sha256').update(schema).digest('hex'), 'be4c63efb56bca64ce3b6a7fa9a32535c7ba6e5b965518ae025f4524f18647f0');
});
