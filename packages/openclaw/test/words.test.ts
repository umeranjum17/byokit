// O10 acceptance (docs/runtime-kits.md 5.14, O10): the 5.14 table verbatim, plain words only (4.3), every
// KitState.phase covered, and toAccountView flowing through ui-core's phaseOf unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseOf, type AccountView as UiCoreAccountView } from '@byokit/ui-core';
import { stateWords, toAccountView, words, type WordKey } from '../src/words.ts';
import type { KitState, SignInView } from '../src/types.ts';
import wordsJson from '../src/words.json' with { type: 'json' };

// 5.14's table, verbatim — the data file and this copy must stay identical.
const TABLE: Record<string, string> = {
  'engine.installing': 'Getting things ready on this computer. The first time takes a few minutes.',
  'engine.starting': 'Starting up…',
  'engine.repairing': 'Fixing a small problem with the setup. This takes a moment.',
  'engine.locked': 'Your saved sign-in is locked. Unlock your password storage, then try again.',
  'engine.ready': 'Ready.',
  'engine.restarting': 'Something stopped. Starting it again by itself.',
  'engine.failed': "This computer couldn't start the helper. Restart the app to try again.",
  'engine.needsUpdate': 'This app needs an update to keep working.',
  'member.signedOut': 'Sign in with {name} to start.',
  'member.resting': '{name} needs a break until {time}.',
  'member.plan': "Your {name} plan doesn't include this.",
  'member.network': "Can't reach {name} right now. This keeps trying by itself.",
  'signin.returned': 'Thanks. Finishing the sign-in — you can go back to the app now.',
  'signin.busy': 'Another sign-in is already in progress. Finish or cancel it, then try again.',
  'signin.cancelled': 'Sign-in cancelled. You can start again whenever you are ready.',
  'signin.expired': 'The sign-in took too long. Start it again.',
  'approval.ask': '{helper} wants to {summary}. Allow it?',
  'approval.expired': "Nobody answered in time, so this wasn't allowed.",
  'approval.notice': 'Something is waiting for your yes.',
  'link.notAllowed': "This device can't do that. Ask the person at the computer.",
};

test('every 5.14 key is present with the exact sentence, and nothing else', () => {
  assert.deepEqual(Object.keys(wordsJson).sort(), Object.keys(TABLE).sort());
  for (const [key, sentence] of Object.entries(TABLE)) assert.equal(words(key as WordKey), sentence, key);
});

test('plain words only: no codes, commands, paths, model ids or jargon a person would have to look up (4.3)', () => {
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [key, sentence] of Object.entries(TABLE)) assert.doesNotMatch(sentence.replace(/\{\w+\}/g, 'X'), banned, key);
});

test('words fills {name}, {time}, {helper}, {summary} and leaves placeholders it is not given', () => {
  assert.equal(words('member.signedOut', { name: 'ChatGPT' }), 'Sign in with ChatGPT to start.');
  assert.equal(words('member.resting', { name: 'Claude', time: '3 pm' }), 'Claude needs a break until 3 pm.');
  assert.equal(words('approval.ask', { helper: 'The helper', summary: 'read a file' }), 'The helper wants to read a file. Allow it?');
  assert.equal(words('member.network', {}), "Can't reach {name} right now. This keeps trying by itself.");
});

test('every KitState.phase a person can see has its sentence; stopped is never on screen', () => {
  const at = (phase: KitState['phase']): string => stateWords({ phase });
  assert.equal(at('installing'), TABLE['engine.installing']);
  assert.equal(at('starting'), TABLE['engine.starting']);
  assert.equal(at('repairing'), TABLE['engine.repairing']);
  assert.equal(at('ready'), TABLE['engine.ready']);
  assert.equal(at('restarting'), TABLE['engine.restarting']);
  assert.equal(at('failed'), TABLE['engine.failed']);
  assert.equal(at('needs-update'), TABLE['engine.needsUpdate']);
  assert.equal(at('locked'), TABLE['engine.locked']);
  assert.equal(at('stopped'), '');
});

test('toAccountView is assignable to ui-core AccountView and phaseOf reads it unchanged (5.14)', () => {
  const view = (v: SignInView | null, ready = false): UiCoreAccountView => toAccountView(v, ready); // the type test
  assert.equal(phaseOf(view({ state: 'waiting', via: 'browser', url: 'https://example/yes' })), 'waiting');
  assert.equal(phaseOf(view({ state: 'waiting', via: 'code', code: 'ABCD-1234' })), 'code');
  assert.equal(phaseOf(view({ state: 'waiting', via: 'code' })), 'opening');
  assert.equal(phaseOf(view(null, true)), 'done');
  assert.equal(phaseOf(view({ state: 'done', via: 'browser' }, true)), 'done');
  assert.equal(phaseOf(view(null, false)), 'opening');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'busy' })), 'busy');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'declined' })), 'cancelled');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'expired' })), 'expired');
  assert.equal(phaseOf(view({ state: 'failed', via: 'code', why: 'failed', error: 'no' })), 'failed');
});
