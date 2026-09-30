import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, cleanName, decodeOffer, encodeOffer, offerText, parseOffer, type PairOffer } from '../src/index.ts';

const offer: PairOffer = { v: 1, host: b64url(new Uint8Array(32).fill(3)), ticket: b64url(new Uint8Array(16).fill(7)),
  name: 'Kitchen 🥣', urls: ['ws://127.0.0.1:7300/link', 'wss://relay.example/link/v1/abc'], expires: 1_900_000_000_123,
  role: 'view', lifetime: 60_000 };

test('offline envelope round-trips all offer fields and optional terms through the public entry', () => {
  for (const o of [offer, { ...offer, role: 'control' as const }, { ...offer, role: undefined, lifetime: undefined }]) {
    assert.deepEqual(decodeOffer(encodeOffer(o), 0), parseOffer(offerText(o), 0));
  }
  assert.equal(cleanName(' \u0007Kitchen\u202e ', 'home'), 'Kitchen');
  assert.equal(cleanName(null, 'home'), 'home');
});

test('offline envelope forgives grouping, case and ambiguous glyphs, but detects other typos', () => {
  const code = encodeOffer(offer);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{1,5})+$/);
  const typed = code.toLowerCase().replace(/-/g, ' \n').replace(/0/g, 'o').replace(/1/g, 'l');
  assert.deepEqual(decodeOffer(typed, 0), offer);
  assert.deepEqual(decodeOffer(code.replace(/1/g, 'I'), 0), offer);
  const compact = code.replace(/-/g, '');
  for (let i = 0; i < compact.length; i++) {
    const changed = compact.slice(0, i) + (compact[i] === '2' ? '3' : '2') + compact.slice(i + 1);
    assert.throws(() => decodeOffer(changed, 0), /didn't match/);
  }
  for (const bad of ['', '!', '0'.repeat(14_001), compact.slice(1), compact + '0', compact.slice(0, -1)]) {
    assert.throws(() => decodeOffer(bad, 0));
  }
});

test('offline decoding checks expiry; inspecting with zero does not change the expired ticket', () => {
  const code = encodeOffer(offer);
  assert.deepEqual(decodeOffer(code, offer.expires), offer);
  assert.throws(() => decodeOffer(code, offer.expires + 1), /run out/);
  assert.deepEqual(decodeOffer(code, 0), parseOffer(offerText(offer), 0));
});

test('offline encoding applies the QR parser address, key, ticket and name rules', () => {
  for (const patch of [{ urls: ['https://example.com'] }, { urls: ['ws://u:p@home/link'] }, { urls: [] },
    { urls: Array(9).fill('ws://home/link') }, { host: 'short' }, { ticket: 'short' }, { expires: NaN }]) {
    assert.throws(() => encodeOffer({ ...offer, ...patch }), /isn't a pairing code/);
  }
  assert.equal(decodeOffer(encodeOffer({ ...offer, name: '\u202eKitchen\u0007' }), 0).name, 'Kitchen');
});
