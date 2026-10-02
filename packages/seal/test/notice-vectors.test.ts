// The notice vectors the Swift opener (ios/Tests) must match byte for byte: made here with a fixed RNG, opened by the
// TypeScript `openNotice` and libsodium, and compared with the committed file. BYOKIT_WRITE_VECTORS=1 rewrites it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { boxKeyPairFromSeed, openNotice, sealBox, sealNotice } from '../src/index.ts';

const sodium = createRequire(import.meta.url)('sodium-native');
const file = new URL('../ios/Tests/ByokitSealTests/notice-vectors.json', import.meta.url);
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64url'));
const counter = (start: number) => { let n = start; return (length: number) => Uint8Array.from({ length }, () => n++ & 255); };

function vectors() {
  const recipient = boxKeyPairFromSeed(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
  const other = boxKeyPairFromSeed(new Uint8Array(32).fill(9));
  let seed = 0;
  const seal = (value: unknown) => sealNotice(value, recipient.publicKey, counter(seed += 17));
  const raw = (bytes: Uint8Array) => ({ v: 1, sealed: b64(sealBox(bytes, recipient.publicKey, counter(seed += 17))) });
  const flip = (n: { sealed: string }, at: number) => { const b = unb64(n.sealed); b[at] ^= 1; return { v: 1, sealed: b64(b) }; };
  const ask = seal({ kind: 'ask', agent: 'Builder', text: 'Ship it? ✅ — “quoted” 𝄞', options: ['Open', 'Answer'] });
  const odd = seal('x'.repeat(30)); // 32 plaintext bytes: Poly1305 with whole blocks only
  const short = seal(1); // 73-byte bundle: a final base64url group with stray bits to set
  const cases: { name: string; envelope: unknown; secret?: string }[] = [
    { name: 'object with non-ASCII text', envelope: ask },
    { name: 'string', envelope: seal('hi') },
    { name: 'number', envelope: seal(42.5) },
    { name: 'array', envelope: seal([1, 'two', { three: 3 }]) },
    { name: 'empty object', envelope: seal({}) },
    { name: 'whole Poly1305 blocks', envelope: odd },
    { name: 'several Salsa20 blocks', envelope: seal({ text: 'long '.repeat(300) }) },
    { name: 'leading UTF-8 BOM', envelope: raw(new TextEncoder().encode('﻿{"a":1}')) },
    { name: 'JSON null is nothing', envelope: seal(null) },
    { name: 'two leading BOMs', envelope: raw(new TextEncoder().encode('\uFEFF\uFEFF{}')) },
    { name: 'tampered MAC', envelope: flip(ask, 56) },
    { name: 'tampered ciphertext', envelope: flip(ask, unb64(ask.sealed).length - 1) },
    { name: 'tampered nonce', envelope: flip(ask, 40) },
    { name: 'tampered ephemeral key', envelope: flip(ask, 3) },
    { name: 'wrong secret', envelope: ask, secret: hex(other.secretKey) },
    { name: 'short secret', envelope: ask, secret: hex(recipient.secretKey.subarray(0, 31)) },
    { name: 'truncated to 71 bytes', envelope: { v: 1, sealed: b64(unb64(ask.sealed).subarray(0, 71)) } },
    { name: 'empty sealed', envelope: { v: 1, sealed: '' } },
    { name: 'padding', envelope: { v: 1, sealed: short.sealed + '=' } },
    { name: 'standard base64 character', envelope: { v: 1, sealed: '+' + ask.sealed.slice(1) } },
    { name: 'whitespace', envelope: { v: 1, sealed: ask.sealed + ' ' } },
    { name: 'length 1 mod 4', envelope: { v: 1, sealed: ask.sealed + 'A' } },
    { name: 'stray low bits', envelope: { v: 1, sealed: short.sealed.slice(0, -1) + 'B' } },
    { name: 'version 2', envelope: { ...ask, v: 2 } },
    { name: 'version as string', envelope: { ...ask, v: '1' } },
    { name: 'version as boolean', envelope: { ...ask, v: true } },
    { name: 'no version', envelope: { sealed: ask.sealed } },
    { name: 'sealed as number', envelope: { v: 1, sealed: 7 } },
    { name: 'array envelope', envelope: [1, ask.sealed] },
    { name: 'string envelope', envelope: ask.sealed },
    { name: 'null envelope', envelope: null },
    { name: 'invalid UTF-8', envelope: raw(Uint8Array.of(0x22, 0xff, 0xfe, 0x22)) },
    { name: 'not JSON', envelope: raw(new TextEncoder().encode('not json')) },
    { name: 'trailing garbage', envelope: raw(new TextEncoder().encode('{} x')) },
    { name: 'low-order ephemeral key', envelope: { v: 1, sealed: b64(new Uint8Array(80)) } },
  ];
  assert.equal(short.sealed.length % 4, 2, 'the stray-bits case needs leftover bits');
  return {
    rule: 'ByokitSeal.openNotice(envelope, secret) must equal expect (null: no notice) for every case; made by notice-vectors.test.ts',
    secret: hex(recipient.secretKey),
    cases: cases.map((c) => ({ ...c, expect: openNotice(c.envelope, Buffer.from(c.secret ?? hex(recipient.secretKey), 'hex')) ?? null })),
  };
}

test('notice vectors for the Swift opener match the committed file and libsodium', () => {
  const made = vectors();
  if (process.env.BYOKIT_WRITE_VECTORS === '1') writeFileSync(file, JSON.stringify(made, null, 2) + '\n');
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), made, 'stale vectors: rerun with BYOKIT_WRITE_VECTORS=1');
  const secret = Buffer.from(made.secret, 'hex');
  let opened = 0;
  for (const c of made.cases) {
    const e = c.envelope as { sealed?: unknown };
    if (c.expect === null || c.secret || typeof e?.sealed !== 'string') continue;
    const bundle = unb64(e.sealed), plain = Buffer.alloc(bundle.length - 72);
    assert.ok(sodium.crypto_box_open_easy(plain, bundle.subarray(56), bundle.subarray(32, 56), bundle.subarray(0, 32), secret), c.name);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), c.expect, c.name);
    opened++;
  }
  assert.equal(opened, 8);
  assert.equal(made.cases.filter((c) => c.expect === null).length, 27, 'every negative case fails closed');
});
