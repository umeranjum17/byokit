import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORDS, words, errorWords, ShareError } from '../src/words.ts';

test('plain words cover each code, with no provider/URI details', () => {
  const jargon = /\b(oauth|pkce|jwt|token|socket|handshake|nonce|encrypt|decrypt|cipher|ratchet|websocket|tls|fingerprint|discovery|daemon|protocol|gateway|backend|endpoint|provider|payload|foreground|notification|activity|intent|error)\b|\/|`|\d{3}/i;
  for (const text of Object.values(WORDS)) assert.doesNotMatch(text, jargon);
  for (const [code, key] of [['unreadable', 'share.unreadable'], ['partial', 'share.partial'], ['failed', 'share.failed'], ['invalid_share_url', 'share.invalid_link']] as const) {
    const error = new ShareError(code, 'developer detail', { cause: new Error('original'), detail: { stage: 'read' } });
    assert.equal(errorWords(error), words(key)); assert.equal(error.message, 'developer detail');
    assert.deepEqual(error.detail, { stage: 'read' }); assert.ok(error.cause instanceof Error);
  }
  const hook = readFileSync(new URL('../src/hook.ts', import.meta.url), 'utf8');
  for (const match of hook.matchAll(/['"](share\.[a-z_]+)['"]/g)) assert.ok(match[1] in WORDS, match[1]);
});
