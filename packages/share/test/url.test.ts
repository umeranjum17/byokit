import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidShareUrl } from '../src/url.ts';

test('accept only the four extension formats, with optional query', () => {
  for (const kind of ['media', 'text', 'weburl', 'file']) for (const query of ['', '?v=1']) {
    assert.equal(isValidShareUrl(`demo://dataUrl=demoShareKey${query}#${kind}`, 'demo'), true);
  }
});
test('reject malformed, forged, foreign and missing-scheme links', () => {
  for (const url of ['demo://dataUrl=demoShareKey', 'demo://dataUrl=demoShareKey#unknown',
    'demo://dataUrl=foreign#text', 'other://dataUrl=demoShareKey#text',
    'demo://dataUrl=demoShareKey#text\n', 'demo://dataUrl=demoShareKey?x=#text#file']) {
    assert.equal(isValidShareUrl(url, 'demo'), false, url);
  }
  assert.equal(isValidShareUrl('demo://dataUrl=demoShareKey#text', null), false);
});
test('scheme metacharacters are literal, never regex syntax', () => {
  assert.equal(isValidShareUrl('a.b+://dataUrl=a.b+ShareKey#text', 'a.b+'), true);
  assert.equal(isValidShareUrl('axb://dataUrl=axbShareKey#text', 'a.b'), false);
});
