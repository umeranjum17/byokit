// M1 acceptance: errorWords returns a filled sentence for every MachineErrorCode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MachineError, type MachineErrorCode } from '../src/errors.ts';
import { errorWords, keyWords } from '../src/words.ts';

const CODES: readonly MachineErrorCode[] = [
  'no-machine', 'exists', 'wrong-account', 'unsupported', 'confirm', 'bad-recipe', 'not-linux',
  'linger', 'host-key', 'unauthorized', 'balance', 'unreachable', 'provider', 'needs-root', 'timeout',
];

test('errorWords returns a filled sentence for every MachineErrorCode', () => {
  const vars = { app: 'App', label: 'Label' };
  for (const code of CODES) {
    const w = errorWords(new MachineError(code, 'detail'), vars);
    assert.ok(w.length > 0, code);
    assert.doesNotMatch(w, /\{|\}/, code);
  }
  // Spot checks against the section 12 table.
  assert.equal(errorWords(new MachineError('unauthorized', 'x'), vars), "Label didn't accept your key. Make a new one and try again.");
  assert.equal(errorWords(new MachineError('timeout', 'x'), vars), 'Your cloud computer took too long to answer. Try again.');
  assert.equal(errorWords(new MachineError('unreachable', 'x'), vars), "Can't reach your cloud computer right now.");
  assert.equal(
    errorWords(new MachineError('needs-root', 'x', { command: 'sudo a\nsudo b' }), vars),
    "App needs a few setup steps that only your cloud computer's owner can run. Run the lines below on it once, then try again.",
  );
  assert.equal(
    errorWords(new MachineError('needs-root', 'x'), vars),
    'App needs admin rights on your cloud computer. Sign in to it with a login that has them.',
  );
});

test('keyWords warns within days, else null (11.3)', () => {
  const now = new Date('2026-09-29T00:00:00.000Z');
  assert.equal(keyWords({ expires: null, scopes: [] }, { label: 'L', now }), null);
  assert.equal(
    keyWords({ expires: '2026-10-05T00:00:00.000Z', scopes: [] }, { label: 'L', now }),
    'Your L key expires on 2026-10-05. Make a new one to keep your cloud computer working.',
  );
  assert.equal(keyWords({ expires: '2027-01-01T00:00:00.000Z', scopes: [] }, { label: 'L', now }), null);
  assert.equal(
    keyWords({ expires: '2026-10-20T00:00:00.000Z', scopes: [] }, { label: 'L', now, days: 30 }),
    'Your L key expires on 2026-10-20. Make a new one to keep your cloud computer working.',
  );
});
