// What a person scans, opens or types, and the words they read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_WORDS, b64url, keyPair } from '../src/index.ts';
import { CODE_ALPHABET, newCode, normalizeCode, offerText, parseOffer, type PairOffer } from '../src/pairing.ts';
import { CONFIRM_WORDS } from '../src/confirm-words.ts';

const offer = (o: Partial<PairOffer> = {}): PairOffer => ({
  v: 1, host: b64url(keyPair().publicKey), name: 'Kitchen computer', urls: ['ws://192.168.1.20:7300/link', 'wss://relay.example/link/v1/abc'],
  ticket: b64url(new Uint8Array(16).fill(7)), expires: Date.now() + 60_000, ...o,
});

test('an offer survives the QR and a browser link; the link keeps it after #, which never reaches a server', () => {
  const o = offer();
  assert.deepEqual(parseOffer(offerText(o)), o);
  const link = offerText(o, 'https://app.example/pair');
  assert.match(link, /^https:\/\/app\.example\/pair#byokit-link:1:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseOffer(link), o);
});

test('anything else is refused in plain words, before any connection', () => {
  const junk = ['', 'WIFI:S:home;;', 'https://example.com', 'byokit-link:1:%%%', 'byokit-link:1:' + b64url(new TextEncoder().encode('{"v":2}'))];
  for (const j of junk) assert.throws(() => parseOffer(j), /isn't a pairing code/, j);
  const bad: Partial<PairOffer>[] = [
    { host: 'short' }, { host: '!'.repeat(43) }, { ticket: b64url(new Uint8Array(8)) }, { ticket: '!'.repeat(22) }, { urls: [] }, { urls: ['http://192.168.1.20/link'] },
    { urls: ['ws://user:pass@192.168.1.20/link'] }, { urls: Array(9).fill('ws://a/link') }, { expires: NaN },
  ];
  for (const b of bad) assert.throws(() => parseOffer(offerText(offer(b))), /isn't a pairing code/, JSON.stringify(b));
  assert.throws(() => parseOffer(offerText(offer({ expires: Date.now() - 1 }))), /run out/);
  assert.equal(parseOffer(offerText(offer({ name: 'Evil‮moc.elgoog\u0007' }))).name, 'Evilmoc.elgoog', 'no hidden or direction-flipping characters');
});

test('typed codes: twelve unambiguous characters in threes of four; case, spaces and dashes forgiven', () => {
  assert.equal(CODE_ALPHABET.length, 31);
  assert.doesNotMatch(CODE_ALPHABET, /[01OIL]/);
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    const c = newCode();
    assert.match(c, /^[2-9A-HJKMNP-Z]{4}(-[2-9A-HJKMNP-Z]{4}){2}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 300);
  assert.equal(normalizeCode(' 7kq4 m2xp-9rth '), '7KQ4M2XP9RTH');
  for (const bad of ['7KQ4-M2XP-9RT', '7KQ4-M2XP-9RTHH', '0KQ4-M2XP-9RTH', 'OKQ4-M2XP-9RTH']) assert.equal(normalizeCode(bad), null, bad);
});

test('confirmation words: 256 distinct plain words; every message a person can see is plain', () => {
  assert.equal(CONFIRM_WORDS.length, 256);
  assert.equal(new Set(CONFIRM_WORDS).size, 256);
  assert.ok(CONFIRM_WORDS.every((w) => /^[a-z]+$/.test(w)));
  const banned = /\b(noise|handshake|key|token|socket|websocket|relay|psk|ticket|grant|http|json|error|null|undefined|status|\d{3,})|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(LINK_WORDS)) assert.doesNotMatch(w, banned, k);
});
