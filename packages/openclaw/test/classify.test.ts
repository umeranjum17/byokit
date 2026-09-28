// O8 acceptance (5.8): every regex branch of Crewhouse `classifyText`, the kit kind mapping, and `until` carried
// only when the message says when to come back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify } from '../src/classify.ts';

test('usage-limit and rate-limit messages rest', () => {
  for (const message of [
    'You have hit your usage limit (plus plan).',
    'rate limit exceeded', 'you hit the rate-limit', 'quota exhausted',
    'too many requests', 'HTTP 429',
  ]) assert.equal(classify(message).kind, 'resting', message);
});

test('overloaded and high-demand messages rest too', () => {
  for (const message of [
    'the model is overloaded', 'high demand right now',
    'server error 502', '503 service unavailable', '504 gateway timeout', 'temporarily unavailable',
  ]) assert.equal(classify(message).kind, 'resting', message);
});

test('sign-in failures are signed-out', () => {
  for (const message of [
    '401 Unauthorized', 'request was unauthorised', '403 forbidden', 'please sign in again',
    'your session has expired', 'invalid api token', 'authentication required',
  ]) assert.equal(classify(message).kind, 'signed-out', message);
});

test('plan exclusions map to plan', () => {
  assert.equal(classify("Your plan doesn't include this model.").kind, 'plan');
});

test('transport failures map to network', () => {
  for (const message of [
    'fetch failed', 'a network error occurred', 'getaddrinfo ENOTFOUND api.example.com',
    'EAI_AGAIN while resolving', 'ECONNRESET on write', 'socket hang up',
  ]) assert.equal(classify(message).kind, 'network', message);
});

test('anything unrecognised is other, without an until', () => {
  const end = classify('the engine caught fire');
  assert.deepEqual(end, { kind: 'other' });
});

test('a plan mention wins over later markers', () => {
  assert.equal(classify("your plan doesn't include quota extras").kind, 'plan');
});

test('until is carried, scaled from the message, only when the message says it', () => {
  const before = Date.now();
  const five = classify('usage limit, try again in 5 min');
  assert.equal(five.kind, 'resting');
  assert.ok(five.until !== undefined && Math.abs(five.until - (before + 300_000)) < 5_000, `until ${five.until}`);
  const hours = classify('overloaded, try again in 2h');
  assert.ok(hours.until !== undefined && Math.abs(hours.until - (before + 7_200_000)) < 5_000, `until ${hours.until}`);
  const tilde = classify('rate limit, try again in ~10 min');
  assert.ok(tilde.until !== undefined && Math.abs(tilde.until - (before + 600_000)) < 5_000, `until ${tilde.until}`);
  assert.equal('until' in classify('usage limit, back later'), false);
});
