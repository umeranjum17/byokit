// Per-app visibility (docs/capability-kits.md 7.3): every shownFor branch, both setApp directions, and resetApp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetApp, setApp, shownFor } from '../src/rules.ts';
import type { AppRules } from '../src/types.ts';

const rules: AppRules = { paused: false, on: ['com.shown'], off: ['com.hidden'], defaults: ['com.default', 'com.hidden'] };

test('shownFor: paused, no app, off, on, defaults, and neither', () => {
  assert.equal(shownFor({ ...rules, paused: true }, 'com.shown'), false, 'paused hides everywhere');
  assert.equal(shownFor(rules, null), false, 'no foreground app');
  assert.equal(shownFor(rules, 'com.hidden'), false, 'off wins over defaults');
  assert.equal(shownFor({ ...rules, on: ['com.hidden'] }, 'com.hidden'), false, 'off wins over on');
  assert.equal(shownFor(rules, 'com.shown'), true, 'on');
  assert.equal(shownFor(rules, 'com.default'), true, 'defaults');
  assert.equal(shownFor(rules, 'com.other'), false, 'in no list');
});

test('setApp moves an app into on or off and out of the other, without touching the input', () => {
  const shown = setApp(rules, 'com.hidden', true);
  assert.deepEqual([shown.on, shown.off], [['com.shown', 'com.hidden'], []]);
  assert.equal(shownFor(shown, 'com.hidden'), true);
  const hidden = setApp(rules, 'com.shown', false);
  assert.deepEqual([hidden.on, hidden.off], [[], ['com.hidden', 'com.shown']]);
  assert.equal(shownFor(hidden, 'com.shown'), false);
  assert.deepEqual(setApp(rules, 'com.shown', true).on, ['com.shown'], 'no duplicate');
  assert.deepEqual(rules, { paused: false, on: ['com.shown'], off: ['com.hidden'], defaults: ['com.default', 'com.hidden'] });
  assert.deepEqual([shown.paused, shown.defaults], [rules.paused, rules.defaults]);
});

test('resetApp removes an app from on and off, so defaults decide again', () => {
  const reset = resetApp(setApp(rules, 'com.default', false), 'com.default');
  assert.deepEqual([reset.on, reset.off], [['com.shown'], ['com.hidden']]);
  assert.equal(shownFor(reset, 'com.default'), true);
  assert.equal(shownFor(resetApp(rules, 'com.shown'), 'com.shown'), false);
});
