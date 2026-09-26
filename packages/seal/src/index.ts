import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hsalsa, xsalsa20poly1305 } from '@noble/ciphers/salsa.js';
import { sha512 } from '@noble/hashes/sha2.js';

export type RandomBytes = (length: number) => Uint8Array;
const random: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

function sized(bytes: Uint8Array, length: number, name: string): void {
  if (bytes.length !== length) throw new RangeError(`${name} must be ${length} bytes`);
}
function fresh(length: number, rng: RandomBytes): Uint8Array {
  const bytes = rng(length);
  sized(bytes, length, 'random output');
  return bytes;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function words(bytes: Uint8Array): Uint32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}
function boxKey(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey);
  const out = new Uint32Array(8);
  hsalsa(words(new TextEncoder().encode('expand 32-byte k')), words(shared), new Uint32Array(4), out);
  shared.fill(0);
  const key = new Uint8Array(32);
  const view = new DataView(key.buffer);
  out.forEach((word, i) => view.setUint32(i * 4, word, true));
  out.fill(0);
  return key;
}

/** Libsodium crypto_box_seed_keypair: the first 32 bytes of SHA-512(seed) form the X25519 secret. */
export function boxKeyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  sized(seed, 32, 'box seed');
  const hash = sha512(seed);
  const secretKey = hash.slice(0, 32);
  hash.fill(0);
  return { publicKey: x25519.getPublicKey(secretKey), secretKey };
}

/** ephemeral public key (32) | nonce (24) | crypto_box_easy (MAC first). */
export function sealBox(bytes: Uint8Array, recipientPublicKey: Uint8Array, rng: RandomBytes = random): Uint8Array {
  sized(recipientPublicKey, 32, 'recipient public key');
  const ephemeralSecret = fresh(32, rng);
  const nonce = fresh(24, rng);
  try {
    const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
    const key = boxKey(recipientPublicKey, ephemeralSecret);
    try { return concat(ephemeralPublic, nonce, xsalsa20poly1305(key, nonce).encrypt(bytes)); }
    finally { key.fill(0); }
  } finally { ephemeralSecret.fill(0); }
}
export function openBox(bundle: Uint8Array, recipientSeed: Uint8Array): Uint8Array | null {
  if (bundle.length < 72 || recipientSeed.length !== 32) return null;
  const { secretKey } = boxKeyPairFromSeed(recipientSeed);
  try {
    const nonce = bundle.subarray(32, 56);
    const key = boxKey(bundle.subarray(0, 32), secretKey);
    try { return xsalsa20poly1305(key, nonce).decrypt(bundle.subarray(56)); }
    finally { key.fill(0); }
  } catch { return null; }
  finally { secretKey.fill(0); }
}

/** nonce (24) | crypto_secretbox_easy ciphertext (16-byte MAC first). */
export function sealSecretBox(bytes: Uint8Array, key: Uint8Array, rng: RandomBytes = random): Uint8Array {
  sized(key, 32, 'secretbox key');
  const nonce = fresh(24, rng);
  return concat(nonce, xsalsa20poly1305(key, nonce).encrypt(bytes));
}
export function openSecretBox(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (bundle.length < 40 || key.length !== 32) return null;
  try { return xsalsa20poly1305(key, bundle.subarray(0, 24)).decrypt(bundle.subarray(24)); }
  catch { return null; }
}
export function sealJson(value: unknown, key: Uint8Array, rng: RandomBytes = random): Uint8Array {
  return sealSecretBox(new TextEncoder().encode(JSON.stringify(value)), key, rng);
}
export function openJson(bundle: Uint8Array, key: Uint8Array): unknown | null {
  const bytes = openSecretBox(bundle, key);
  if (bytes === null) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return null; }
}

/** TweetNaCl-compatible 64-byte secret: seed | public key. */
export function signingKeyPairFromSeed(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  sized(seed, 32, 'signing seed');
  const publicKey = ed25519.getPublicKey(seed);
  return { publicKey, secretKey: concat(seed, publicKey) };
}
export function signDetached(bytes: Uint8Array, secretKey: Uint8Array): Uint8Array {
  sized(secretKey, 64, 'signing secret key');
  const publicKey = ed25519.getPublicKey(secretKey.subarray(0, 32));
  if (!publicKey.every((byte, i) => byte === secretKey[32 + i])) throw new Error('signing secret key public half does not match seed');
  return ed25519.sign(bytes, secretKey.subarray(0, 32));
}
export function verifyDetached(bytes: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32) return false;
  try { return ed25519.verify(signature, bytes, publicKey); }
  catch { return false; }
}
