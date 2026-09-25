import { test } from 'node:test';
import assert from 'node:assert/strict';
import { phaseOf, stepOf, type Phase } from '../src/phase.ts';

test('the sign-in phases, from what the back end says', () => {
  assert.equal(phaseOf(null), 'opening');
  assert.equal(phaseOf({ signIn: { state: 'waiting' } }), 'opening');
  assert.equal(phaseOf({ signIn: { state: 'waiting', via: 'browser', url: 'https://example.test/authorize' } }), 'waiting');
  assert.equal(phaseOf({ signIn: { state: 'waiting', via: 'code', code: 'CREW-2026', url: 'https://example.test/device' } }), 'code');
  assert.equal(phaseOf({ ready: true, signIn: { state: 'done' } }), 'done');
  assert.equal(phaseOf({ ready: true, work: 'sara@acme.com' }), 'work');
  assert.equal(phaseOf({ ready: true, work: 'sara@acme.com' }, { keepWork: true }), 'done');
  assert.equal(phaseOf({ signIn: { state: 'failed', why: 'declined' } }), 'cancelled');
  assert.equal(phaseOf({ signIn: { state: 'failed', why: 'busy' } }), 'busy');
  assert.equal(phaseOf({ signIn: { state: 'failed', why: 'expired' } }), 'expired');
  assert.equal(phaseOf({ signIn: { state: 'failed', why: 'tooLong' } }), 'expired');
  assert.equal(phaseOf({ signIn: { state: 'failed', why: 'offline' } }), 'failed');
  assert.equal(phaseOf({ ready: true }, { cancelled: true }), 'cancelled');
  assert.equal(phaseOf({ ready: true }, { offline: true }), 'offline');
  assert.deepEqual((['opening', 'waiting', 'code', 'done', 'work'] as Phase[]).map(stepOf), [0, 1, 1, 3, 3]);
});
