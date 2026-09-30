// The frozen 5.6 table, plain words only (the repo's banned-jargon expression, docs/capability-kits.md D-P), and the
// eventWords/errorWords mapping (BK-C2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureError } from '../src/errors.ts';
import { WORDS, errorWords, eventWords, type WordKey } from '../src/words.ts';
import type { CaptureErrorCode } from '../src/types.ts';

const TABLE: [WordKey, string][] = [
  ['capture.missing', 'This computer needs the recorder installed first.'],
  ['capture.needsUpdate.recorder', 'The recorder on this computer needs an update.'],
  ['capture.needsUpdate.app', 'This app needs an update to work with the recorder on this computer.'],
  ['capture.unsupported', "The recorder on this computer can't record that yet."],
  ['capture.consentPending', 'Say yes in the window that just opened to start recording.'],
  ['capture.recording', 'Recording.'],
  ['capture.done', 'Recording finished.'],
  ['capture.consentCancelled', 'You said no to the recording. Nothing was kept.'],
  ['capture.consentTimeout', 'Nobody said yes in time, so nothing was recorded.'],
  ['capture.stopped', 'Stopped before anything was recorded.'],
  ['capture.busy', 'Another recording is already running. Stop it first.'],
  ['capture.making', 'Making the video…'],
  ['capture.made', 'The video is ready.'],
  ['capture.overLimit', 'Planning this video would go over its limit, so nothing was spent.'],
  ['capture.takeMissing', "That recording can't be opened. Record it again."],
  ['capture.renderFailed', "The video couldn't be made from this recording. Try again."],
  ['capture.timeout', 'The recorder took too long to answer. Try again.'],
  ['capture.failed', 'The recorder stopped with a problem. Try again.'],
];

test('words.json is the 5.6 table, verbatim and in order', () => {
  assert.deepEqual(Object.keys(WORDS), TABLE.map(([k]) => k));
  for (const [k, sentence] of TABLE) assert.equal(WORDS[k], sentence, k);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (D-P)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
});

test('eventWords maps every event', () => {
  assert.equal(eventWords({ event: 'consent-pending' }), WORDS['capture.consentPending']);
  assert.equal(eventWords({ event: 'recording', take: '/r/t' }), WORDS['capture.recording']);
  assert.equal(eventWords({ event: 'done', take: '/r/t', seconds: 1, warnings: [] }), WORDS['capture.done']);
});

test('errorWords maps every CaptureErrorCode to a non-empty sentence (5.6)', () => {
  const expected: Record<CaptureErrorCode, WordKey> = {
    missing: 'capture.missing',
    'needs-update': 'capture.needsUpdate.recorder',
    unsupported: 'capture.unsupported',
    'consent-cancelled': 'capture.consentCancelled',
    'consent-timeout': 'capture.consentTimeout',
    stopped: 'capture.stopped',
    'already-recording': 'capture.busy',
    'preflight-refused': 'capture.overLimit',
    'take-input': 'capture.takeMissing',
    'render-failed': 'capture.renderFailed',
    timeout: 'capture.timeout',
    invalid: 'capture.failed',
    'too-much-output': 'capture.failed',
    protocol: 'capture.failed',
    failed: 'capture.failed',
  };
  for (const [c, key] of Object.entries(expected)) {
    const sentence = errorWords(new CaptureError(c as CaptureErrorCode, 'log only', { hint: 'log only' }));
    assert.equal(sentence, WORDS[key], c);
    assert.ok(sentence.length > 0 && !sentence.includes('log only'), c);
  }
  assert.equal(errorWords(new CaptureError('needs-update', '', { why: 'recorder' })), WORDS['capture.needsUpdate.recorder']);
  assert.equal(errorWords(new CaptureError('needs-update', '', { why: 'app' })), WORDS['capture.needsUpdate.app']);
});
