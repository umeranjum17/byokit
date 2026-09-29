// BK-0: the frozen 4.8 table, plain words only (the repo's banned-jargon expression, docs/capability-kits.md D-P),
// and no claim about where a draft goes. BK-P1 adds checkLines cases here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WORDS, words, type WordKey } from '../src/words.ts';

const TABLE: [WordKey, string][] = [
  ['compose.missing', "The writing checker isn't installed yet."],
  ['compose.needsUpdate', 'This app needs an update to check drafts.'],
  ['compose.failed', 'The writing checker stopped with a problem. Try again.'],
  ['check.fits', 'Fits on {platform}.'],
  ['check.tooLong', 'Too long for {platform}: {length} characters, and the most is {limit}.'],
  ['check.voice', 'Goes against your voice: {list}.'],
  ['check.stock', 'Sounds stock: {list}.'],
  ['check.added', "Adds numbers or times the original doesn't have: {list}."],
  ['check.dropped', 'Drops numbers or times from the original: {list}.'],
  ['check.layout', 'The lists or paragraphs changed from the original.'],
  ['check.keptFacts', 'Kept the facts: every number and time from the original is still there.'],
  ['check.pass', 'Ready for you to look over.'],
  ['check.fail', 'Needs another pass.'],
  ['split.posts', 'Split into {count} posts.'],
];

test('words.json is the 4.8 table, verbatim and in order', () => {
  assert.deepEqual(Object.keys(WORDS), TABLE.map(([k]) => k));
  for (const [k, sentence] of TABLE) assert.equal(WORDS[k], sentence, k);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (D-P)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
  assert.equal(words('check.tooLong', { platform: 'X', length: '301', limit: '280' }), 'Too long for X: 301 characters, and the most is 280.');
  assert.equal(words('check.fits', {}), 'Fits on {platform}.', 'unfilled slots stay visible');
});

test('no claim about where a draft goes (D-P)', () => {
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w, /this phone|\bleaves?\b|never sent/i, k);
});
