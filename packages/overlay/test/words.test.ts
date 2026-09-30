// The frozen 7.7 table, plain words only (the repo's banned-jargon expression, docs/capability-kits.md D-P), and the
// state mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, stateWords, words, type WordKey } from '../src/words.ts';
import type { OverlayState } from '../src/types.ts';

const TABLE: [WordKey, string][] = [
  ['overlay.on', 'The bubble is on.'],
  ['overlay.off', 'The bubble is off.'],
  ['overlay.stuck', 'The bubble stopped. Turn it off and on again.'],
  ['overlay.needsPermission', 'Allow this app to show over other apps to see the bubble.'],
  ['overlay.restricted', "If that switch is greyed out, open this app's info, tap the menu, and allow restricted settings first."],
  ['overlay.unsupported', "This device can't show a bubble over other apps."],
  ['field.copied', "Couldn't type it in, so it's copied. Paste it where you want it."],
  ['field.failed', "Couldn't type it in. Try again."],
  ['screen.taking', 'Taking one picture of your screen'],
];

test('words.json is the 7.7 table, verbatim and in order', () => {
  assert.deepEqual(Object.keys(WORDS), TABLE.map(([k]) => k));
  for (const [k, sentence] of TABLE) assert.equal(words(k), sentence, k);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (D-P)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
});

test('stateWords gives each state its overlay sentence', () => {
  const states: [OverlayState, WordKey][] = [
    ['on', 'overlay.on'], ['off', 'overlay.off'], ['stuck', 'overlay.stuck'],
    ['needs-permission', 'overlay.needsPermission'], ['unsupported', 'overlay.unsupported'],
  ];
  for (const [s, k] of states) assert.equal(stateWords(s), WORDS[k], s);
});
