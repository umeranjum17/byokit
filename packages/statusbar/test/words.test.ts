// The frozen 12.7 table, plain words only (the repo's banned-jargon expression, docs/capability-kits.md D-P), and the
// state mapping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, stateWords, words, type WordKey } from '../src/words.ts';
import type { StatusState } from '../src/types.ts';

const TABLE: [WordKey, string][] = [
  ['status.on', 'Work in progress shows at the top of the screen.'],
  ['status.off', "Work in progress shows only in the notification list. Turn it on in this app's notification settings."],
  ['status.needsPermission', 'Allow notifications for this app to see work in progress.'],
  ['status.unsupported', "This device can't show work in progress at the top of the screen."],
  ['status.channel', 'Work in progress'],
];

test('words.json is the 12.7 table, verbatim and in order', () => {
  assert.deepEqual(Object.keys(WORDS), TABLE.map(([k]) => k));
  for (const [k, sentence] of TABLE) assert.equal(words(k), sentence, k);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (D-P)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
});

test('stateWords gives each state its status sentence', () => {
  const states: [StatusState, WordKey][] = [
    ['on', 'status.on'], ['off', 'status.off'], ['needs-permission', 'status.needsPermission'], ['unsupported', 'status.unsupported'],
  ];
  for (const [s, k] of states) assert.equal(stateWords(s), WORDS[k], s);
});
