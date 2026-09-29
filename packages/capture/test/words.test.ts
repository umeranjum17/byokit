// BK-0: the frozen 5.6 table and plain words only (the repo's banned-jargon expression, docs/capability-kits.md
// D-P). BK-C2 adds the eventWords/errorWords mapping cases here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, type WordKey } from '../src/words.ts';

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
