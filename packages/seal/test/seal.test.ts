// Consumer journeys for the published @byokit/seal surface (the built package export), in both directions against
// libsodium (sodium-native) and TweetNaCl, with the trust boundaries a caller would meet: tampered bytes, wrong or
// low-order keys, short bundles and non-JSON payloads all fail closed. Real crypto.getRandomValues drives the
// production paths; fixed RNGs only reproduce the published interop vectors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import nacl from 'tweetnacl';
import {
  box, boxKeyPair, boxPublicKey, boxKeyPairFromSeed, openBox, openBoxFromSeed, openAuthBox,
  sealBox, sealNotice, openNotice, sealSecretBox, openSecretBox, sealJson, openJson,
  signingKeyPairFromSeed, signDetached, verifyDetached,
} from '@byokit/seal';

const sodium = createRequire(import.meta.url)('sodium-native');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const seed = Uint8Array.from({ length: 32 }, (_, i) => i);
const key = Uint8Array.from({ length: 32 }, (_, i) => i + 33);
const nonce = Uint8Array.from({ length: 24 }, (_, i) => i + 65);
const ephemeral = Uint8Array.from({ length: 32 }, (_, i) => i + 89);
const sequence = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((part) => [...part]));
const fixedBoxRng = () => {
  let draw = 0;
  return (length: number) => {
    const part = [ephemeral, nonce][draw++ % 2];
    assert.equal(length, part.length);
    return part.slice();
  };
};
const plain = new TextEncoder().encode('muxr encrypted catalog payload');

test('a recipient whose key comes from a stored seed opens boxes this library seals and libsodium sends', () => {
  const recipient = boxKeyPairFromSeed(seed);
  const libsodiumPublic = Buffer.alloc(32), libsodiumSecret = Buffer.alloc(32);
  sodium.crypto_box_seed_keypair(libsodiumPublic, libsodiumSecret, Buffer.from(seed));
  assert.equal(hex(recipient.publicKey), hex(libsodiumPublic));
  assert.equal(hex(recipient.secretKey), hex(libsodiumSecret));
  assert.equal(hex(recipient.secretKey), '3d94eea49c580aef816935762be049559d6d1440dede12e6a125f1841fff8e6f');

  const sealed = sealBox(plain, recipient.publicKey, fixedBoxRng());
  assert.equal(hex(sealed), '9198a2e5c608111faaa84a8b3ae7536c638680d74707be337a606e41d0cfc7704142434445464748494a4b4c4d4e4f505152535455565758a4e13bff68d3fcf6702e04e1c9c4061e80eb9315e81c66d29de2755d55f7008a406e63614f971a161a7d25777863');
  const nativePlain = Buffer.alloc(plain.length);
  sodium.crypto_box_open_easy(nativePlain, sealed.subarray(56), sealed.subarray(32, 56), sealed.subarray(0, 32), libsodiumSecret);
  assert.equal(hex(nativePlain), hex(plain));

  const ephPublic = Buffer.alloc(32);
  sodium.crypto_scalarmult_base(ephPublic, Buffer.from(ephemeral));
  const nativeCipher = Buffer.alloc(plain.length + 16);
  sodium.crypto_box_easy(nativeCipher, Buffer.from(plain), Buffer.from(nonce), libsodiumPublic, Buffer.from(ephemeral));
  const bundle = sequence(ephPublic, nonce, nativeCipher);
  assert.equal(hex(sealed), hex(bundle));
  assert.equal(hex(openBox(bundle, recipient.secretKey)!), hex(plain));
  assert.equal(hex(openBoxFromSeed(bundle, seed)!), hex(plain));

  assert.equal(openBox(bundle.map((v, i) => i === 60 ? v ^ 1 : v), recipient.secretKey), null);
  assert.equal(openBox(bundle, key), null);
  assert.equal(openBox(bundle.subarray(0, 70), recipient.secretKey), null);

  const live = sealBox(plain, recipient.publicKey);
  assert.equal(hex(openBox(live, recipient.secretKey)!), hex(plain));
  assert.equal(hex(openBox(sealBox(new Uint8Array(), recipient.publicKey), recipient.secretKey)!), '');
  assert.equal(openBox(sequence(new Uint8Array(32), live.subarray(32)), recipient.secretKey), null);
  assert.equal(openBox(live, new Uint8Array(31)), null);

  assert.throws(() => boxPublicKey(new Uint8Array(31)), RangeError);
  assert.throws(() => boxKeyPair(() => new Uint8Array(31)), RangeError);
});

test('two devices that already know each other exchange boxes, sealed JSON and signatures', () => {
  const sender = boxKeyPair(() => ephemeral);
  const recipient = boxKeyPair(() => key);
  assert.deepEqual(sender.secretKey, ephemeral);
  assert.notEqual(sender.secretKey, ephemeral);
  assert.equal(hex(sender.publicKey), hex(nacl.box.keyPair.fromSecretKey(ephemeral).publicKey));
  assert.equal(hex(boxPublicKey(key)), hex(recipient.publicKey));
  const nativePublic = Buffer.alloc(32);
  sodium.crypto_scalarmult_base(nativePublic, Buffer.from(key));
  assert.equal(hex(recipient.publicKey), hex(nativePublic));

  const before = sender.secretKey.slice();
  const sealed = box(plain, recipient.publicKey, sender.secretKey, () => nonce.slice());
  const naclCipher = nacl.box(plain, nonce, recipient.publicKey, sender.secretKey);
  const nativeCipher = Buffer.alloc(plain.length + 16);
  sodium.crypto_box_easy(nativeCipher, Buffer.from(plain), Buffer.from(nonce), Buffer.from(recipient.publicKey), Buffer.from(sender.secretKey));
  assert.equal(hex(sealed), hex(sequence(nonce, naclCipher)));
  assert.equal(hex(sealed), hex(sequence(nonce, nativeCipher)));
  assert.equal(hex(openAuthBox(sequence(nonce, nativeCipher), sender.publicKey, recipient.secretKey)!), hex(plain));
  assert.equal(hex(nacl.box.open(sealed.subarray(24), nonce, sender.publicKey, recipient.secretKey)!), hex(plain));
  const opened = Buffer.alloc(plain.length);
  sodium.crypto_box_open_easy(opened, sealed.subarray(24), Buffer.from(nonce), Buffer.from(sender.publicKey), Buffer.from(recipient.secretKey));
  assert.equal(hex(opened), hex(plain));
  assert.deepEqual(sender.secretKey, before);

  assert.equal(openAuthBox(sealed, boxPublicKey(seed), recipient.secretKey), null);
  assert.equal(openAuthBox(sealed, sender.publicKey, seed), null);
  assert.equal(openAuthBox(sealed.map((v, i) => i === 24 ? v ^ 1 : v), sender.publicKey, recipient.secretKey), null);
  assert.equal(openAuthBox(sealed.subarray(0, 39), sender.publicKey, recipient.secretKey), null);
  assert.equal(openAuthBox(sealed, new Uint8Array(32), recipient.secretKey), null);
  assert.equal(openAuthBox(sealed, sender.publicKey.subarray(1), recipient.secretKey), null);
  assert.equal(openAuthBox(sealed, sender.publicKey, recipient.secretKey.subarray(1)), null);
  assert.throws(() => box(plain, new Uint8Array(31), sender.secretKey), RangeError);
  assert.throws(() => box(plain, recipient.publicKey, new Uint8Array(31)), RangeError);
  assert.equal(hex(openAuthBox(box(new Uint8Array(), recipient.publicKey, sender.secretKey), sender.publicKey, recipient.secretKey)!), '');

  const stored = sealSecretBox(plain, key, () => nonce.slice());
  assert.equal(hex(stored), '4142434445464748494a4b4c4d4e4f50515253545556575846ca6ca3faedb1084367dcd7fe9d58c9053d6af4dd190fce42964f4bd2fa76bc0387029fa5142763c0c523689f0d');
  const nativeSecret = Buffer.alloc(plain.length + 16);
  sodium.crypto_secretbox_easy(nativeSecret, Buffer.from(plain), Buffer.from(nonce), Buffer.from(key));
  assert.equal(hex(stored), hex(sequence(nonce, nativeSecret)));
  const decrypted = Buffer.alloc(plain.length);
  sodium.crypto_secretbox_open_easy(decrypted, stored.subarray(24), stored.subarray(0, 24), Buffer.from(key));
  assert.equal(hex(decrypted), hex(plain));
  assert.equal(hex(openSecretBox(sequence(nonce, nativeSecret), key)!), hex(plain));
  assert.equal(openSecretBox(stored.map((v, i) => i === 30 ? v ^ 1 : v), key), null);
  assert.equal(openSecretBox(stored, seed), null);
  const payload = { machines: [{ id: 'home', token: 'αβ' }], version: 2 };
  assert.deepEqual(openJson(sealJson(payload, key, () => nonce.slice()), key), payload);
  assert.deepEqual(openJson(sequence(nonce, nativeSecret), key), null);

  const signer = signingKeyPairFromSeed(seed);
  const naclSigner = nacl.sign.keyPair.fromSeed(seed);
  assert.equal(hex(signer.publicKey), hex(naclSigner.publicKey));
  assert.equal(hex(signer.secretKey), hex(naclSigner.secretKey));
  const nativeSignPublic = Buffer.alloc(32), nativeSignSecret = Buffer.alloc(64);
  sodium.crypto_sign_seed_keypair(nativeSignPublic, nativeSignSecret, Buffer.from(seed));
  assert.equal(hex(signer.secretKey), hex(nativeSignSecret));
  const signature = signDetached(plain, signer.secretKey);
  assert.equal(hex(signature), '3779c81c8e2809ef44c825a3c9468df82ce125a94d873cde8bc93919e3f3eab972244ea1c5cf17db85856ca0a8fd4abbff03dacd85f629afbb3f64c3aa9bc60b');
  assert.equal(hex(signature), hex(nacl.sign.detached(plain, naclSigner.secretKey)));
  assert.equal(sodium.crypto_sign_verify_detached(Buffer.from(signature), Buffer.from(plain), nativeSignPublic), true);
  const nativeSignature = Buffer.alloc(64);
  sodium.crypto_sign_detached(nativeSignature, Buffer.from(plain), nativeSignSecret);
  assert.equal(verifyDetached(plain, nativeSignature, signer.publicKey), true);
  assert.equal(verifyDetached(plain, signature.map((v, i) => i === 1 ? v ^ 1 : v), signer.publicKey), false);
  assert.equal(verifyDetached(plain, signature, signingKeyPairFromSeed(key).publicKey), false);
});

test('a notice sealed by one consumer opens in another as portable JSON', () => {
  const recipient = boxKeyPairFromSeed(seed);
  const value = { kind: 'completed', payload: ['αβ', 42, false, null] };
  const notice = sealNotice(value, recipient.publicKey, fixedBoxRng());
  assert.equal(notice.v, 1);
  assert.match(notice.sealed, /^[A-Za-z0-9_-]+$/);
  const bundle = Buffer.from(notice.sealed, 'base64url');
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const cipher = nacl.box(bytes, bundle.subarray(32, 56), recipient.publicKey, ephemeral);
  assert.equal(hex(bundle), hex(sequence(boxPublicKey(ephemeral), nonce, cipher)));

  assert.deepEqual(openNotice(JSON.parse(JSON.stringify(notice)), recipient.secretKey), value);
  assert.deepEqual(openNotice({ v: 1, sealed: Buffer.from(sequence(bundle.subarray(0, 56), cipher)).toString('base64url') }, recipient.secretKey), value);
  assert.deepEqual(openNotice(sealNotice(value, recipient.publicKey), recipient.secretKey), value);

  assert.equal(openNotice(notice, key), null);
  assert.equal(openNotice(notice, new Uint8Array(31)), null);
  const corrupted = bundle.slice();
  corrupted[60] ^= 1;
  assert.equal(openNotice({ v: 1, sealed: corrupted.toString('base64url') }, recipient.secretKey), null);
  for (const bad of [null, [], 1, {}, { ...notice, v: 2 }, { v: 1, sealed: 2 }, { v: 1, sealed: 'A' }, { v: 1, sealed: notice.sealed + '=' }, { v: 1, sealed: '' }]) {
    assert.equal(openNotice(bad, recipient.secretKey), null);
  }
  for (const packed of [new TextEncoder().encode('not JSON'), new Uint8Array([255])]) {
    const sealed = Buffer.from(sealBox(packed, recipient.publicKey)).toString('base64url');
    assert.equal(openNotice({ v: 1, sealed }, recipient.secretKey), null);
  }
  for (const item of ['text', 42, false, null, [1, 2]]) {
    assert.deepEqual(openNotice(sealNotice(item, recipient.publicKey), recipient.secretKey), item);
  }
  assert.throws(() => sealNotice(undefined, recipient.publicKey), TypeError);
  assert.throws(() => sealNotice(1n, recipient.publicKey), TypeError);
});
