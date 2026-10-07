// What a person scans, opens or types, and the words they read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINK_WORDS, b64url, keyPair } from '../src/index.ts';
import { CODE_ALPHABET, decodeCompactOffer, encodeCompactOffer, newCode, normalizeCode, offerText, parseOffer, type PairOffer } from '../src/pairing.ts';
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

test('compact offers stay QR-small and round-trip every field', () => {
  const secret = normalizeCode(newCode())!;
  const lan = { code: secret, urls: ['ws://192.168.1.144:7310/link'], expires: Date.now() + 60_000, name: 'Kitchen computer', role: 'control' as const };
  const text = encodeCompactOffer(lan);
  assert.ok(text.length < 80, `QR text is ${text.length} chars`);
  assert.match(text, /^BYOKIT-LINK:2:[0-9A-Z:]+$/, 'uppercase tag and payload stay in the QR alphanumeric mode');
  const back = decodeCompactOffer(text, 0);
  assert.equal(back.code, secret);
  assert.deepEqual(back.urls, lan.urls);
  assert.equal(back.name, 'Kitchen computer');
  assert.equal(back.role, 'control');
  assert.equal(back.lifetime, undefined);
  assert.equal(back.expires, Math.ceil(lan.expires / 60000) * 60000);

  // Every address shape survives, and a decode is byte-stable (ports are always written back).
  const urls = ['ws://192.168.1.5:7300', 'ws://h.example/link', 'wss://s.example:443/link',
    'wss://macbook.tail012345.ts.net:7310/link', 'wss://relay.example/link/v1/abcdefghijklmnopqrstuv',
    'ws://[fd7a:115:c2e::1]:7310/link', 'ws://h.example:80/a path?q=1&y=2'];
  const big = encodeCompactOffer({ code: secret, urls, expires: lan.expires, name: 'Evil‮moc.elgoog', role: 'view', lifetime: 3600_500 });
  const wide = decodeCompactOffer(big, 0);
  assert.deepEqual(wide.urls.map((u) => new URL(u).href), urls.map((u) => new URL(u).href), 'same addresses');
  assert.equal(wide.name, 'Evilmoc.elgoog', 'no hidden or direction-flipping characters');
  assert.equal(wide.role, 'view');
  assert.equal(wide.lifetime, 3601_000, 'lifetime rounds up to whole seconds');
  assert.equal(encodeCompactOffer({ ...wide, code: secret, expires: wide.expires, name: wide.name }), big, 'decoding is byte-stable');

  // Expiry follows the QR parser; inspecting with zero does not renew.
  assert.throws(() => decodeCompactOffer(encodeCompactOffer({ ...lan, expires: Date.now() - 60_000 })), /run out/);
  assert.ok(decodeCompactOffer(encodeCompactOffer({ ...lan, expires: Date.now() - 60_000 }), 0).code);

  // Anything else is refused in plain words, before any connection.
  const good = encodeCompactOffer(lan).replace(/-/g, '');
  for (const j of ['', 'byokit-link:1:%%%', good.slice(0, -1), good + '0', good.replace(/^BYOKIT-LINK:2:./, 'BYOKIT-LINK:2:8'), // wrong version byte
    'BYOKIT-LINK:2:' + '0'.repeat(2048), good.toLowerCase().replace('byokit', 'byokit0')]) {
    assert.throws(() => decodeCompactOffer(j, 0), /isn't a pairing code/, j);
  }
  for (const bad of [{ urls: [] as string[] }, { urls: Array(9).fill('ws://a/link') }, { urls: ['http://a/link'] },
    { urls: ['ws://u:p@a/link'] }, { code: 'short' }, { code: 'K1-23456789ABCD-0123456789ABCDEF0123456789ABCDEF' }, { expires: NaN }, { role: 'admin' }]) {
    assert.throws(() => encodeCompactOffer({ ...lan, ...bad } as typeof lan), /isn't a pairing code|compact code/, JSON.stringify(bad));
  }
});
