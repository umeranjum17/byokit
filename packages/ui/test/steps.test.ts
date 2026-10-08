import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stepsText, stepsView } from '../src/steps.ts';

test('every state passes through with the caller-chosen id', () => {
  const rows = stepsView([
    { id: 'runner', state: 'ok', label: 'Agent runner', detail: 'ready' },
    { id: 'lookup', state: 'checking', label: 'Agents', detail: 'looking' },
    { id: 'tailscale', state: 'todo', label: 'Tailscale', detail: 'not installed on this computer' },
    { id: 'wifi', state: 'failed', label: 'Wi-Fi', detail: 'no address found', fix: 'Connect this computer to your Wi-Fi, then press r.' },
  ]);
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [
    ['runner', 'ok'], ['lookup', 'checking'], ['tailscale', 'todo'], ['wifi', 'failed'],
  ]);
});

test('words are the label, with the detail after it', () => {
  assert.equal(stepsView([{ id: 'a', state: 'ok', label: 'Agent runner', detail: 'ready' }])[0].words, 'Agent runner: ready');
  assert.equal(stepsView([{ id: 'a', state: 'ok', label: 'Agent runner ready' }])[0].words, 'Agent runner ready');
  assert.equal(
    stepsView([{ id: 'a', state: 'ok', label: 'Tailscale', detail: 'signed in as Umer' }])[0].words,
    'Tailscale: signed in as Umer',
  );
});

test('only failed rows carry a fix, defaulting to trying again', () => {
  assert.equal(stepsView([{ id: 'a', state: 'failed', label: 'Route', detail: 'unreachable', fix: 'Use Same Wi-Fi now.' }])[0].fix, 'Use Same Wi-Fi now.');
  assert.equal(stepsView([{ id: 'a', state: 'failed', label: 'Route' }])[0].fix, 'Try again.');
  for (const state of ['todo', 'checking', 'ok'] as const) {
    assert.equal(stepsView([{ id: 'a', state, label: 'Route', fix: 'Use Same Wi-Fi now.' }])[0].fix, '');
  }
});

test('the terminal draws the same rows, failed with its fix', () => {
  const text = stepsText(stepsView([
    { id: 'runner', state: 'ok', label: 'Agent runner', detail: 'ready' },
    { id: 'lookup', state: 'checking', label: 'Agents', detail: 'looking' },
    { id: 'tailscale', state: 'todo', label: 'Tailscale', detail: 'not installed on this computer' },
    { id: 'wifi', state: 'failed', label: 'Wi-Fi', detail: 'no address found', fix: 'Connect this computer to your Wi-Fi, then press r.' },
  ]), { title: 'Checking this computer' });
  assert.equal(text, [
    'Checking this computer',
    '  ✓ Agent runner: ready',
    '  … Agents: looking',
    '  ○ Tailscale: not installed on this computer',
    '  ✗ Wi-Fi: no address found Connect this computer to your Wi-Fi, then press r.',
  ].join('\n'));
});
