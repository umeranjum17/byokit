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

/** Raw X25519 key pair, compatible with TweetNaCl box.keyPair. */
export function boxKeyPair(rng: RandomBytes = random): { publicKey: Uint8Array; secretKey: Uint8Array } {
  const secretKey = fresh(32, rng).slice();
  return { publicKey: boxPublicKey(secretKey), secretKey };
}
export function boxPublicKey(secretKey: Uint8Array): Uint8Array {
  sized(secretKey, 32, 'box secret key');
  return x25519.getPublicKey(secretKey);
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
/** Open with the raw 32-byte X25519 secret, including a secret derived by boxKeyPairFromSeed. */
export function openBox(bundle: Uint8Array, recipientSecret: Uint8Array): Uint8Array | null {
  if (bundle.length < 72 || recipientSecret.length !== 32) return null;
  return openAuthBox(bundle.subarray(32), bundle.subarray(0, 32), recipientSecret);
}

/** Seed-based opening for callers of the original API. */
export function openBoxFromSeed(bundle: Uint8Array, recipientSeed: Uint8Array): Uint8Array | null {
  if (bundle.length < 72 || recipientSeed.length !== 32) return null;
  const { secretKey } = boxKeyPairFromSeed(recipientSeed);
  try { return openBox(bundle, secretKey); }
  finally { secretKey.fill(0); }
}

/** Known-sender crypto_box_easy: nonce (24) | ciphertext (16-byte MAC first). */
export function box(bytes: Uint8Array, theirPublic: Uint8Array, mySecret: Uint8Array, rng: RandomBytes = random): Uint8Array {
  sized(theirPublic, 32, 'box public key');
  sized(mySecret, 32, 'box secret key');
  const nonce = fresh(24, rng);
  const key = boxKey(theirPublic, mySecret);
  try { return concat(nonce, xsalsa20poly1305(key, nonce).encrypt(bytes)); }
  finally { key.fill(0); }
}
export function openAuthBox(bundle: Uint8Array, theirPublic: Uint8Array, mySecret: Uint8Array): Uint8Array | null {
  if (bundle.length < 40 || theirPublic.length !== 32 || mySecret.length !== 32) return null;
  try {
    const key = boxKey(theirPublic, mySecret);
    try { return xsalsa20poly1305(key, bundle.subarray(0, 24)).decrypt(bundle.subarray(24)); }
    finally { key.fill(0); }
  } catch { return null; }
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
function encodeNotice(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1] ?? 0, c = bytes[i + 2] ?? 0;
    out += BASE64URL[a >> 2] + BASE64URL[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += BASE64URL[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += BASE64URL[c & 63];
  }
  return out;
}
function decodeNotice(text: string): Uint8Array | null {
  if (text.length % 4 === 1 || /[^A-Za-z0-9_-]/.test(text)) return null;
  const out = new Uint8Array(Math.floor(text.length * 6 / 8));
  let hold = 0, bits = 0, at = 0;
  for (const char of text) {
    hold = (hold << 6) | BASE64URL.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (hold >> bits) & 255;
    }
  }
  return bits > 0 && (hold & ((1 << bits) - 1)) !== 0 ? null : out;
}

/** JSON sealed to one recipient; no sender identity is asserted. */
export function sealNotice(value: unknown, boxPublicKey: Uint8Array, rng: RandomBytes = random): { v: 1; sealed: string } {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('notice must be JSON serializable');
  const bytes = new TextEncoder().encode(json);
  try { return { v: 1, sealed: encodeNotice(sealBox(bytes, boxPublicKey, rng)) }; }
  finally { bytes.fill(0); }
}
export function openNotice(data: unknown, secret: Uint8Array): unknown | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const envelope = data as Record<string, unknown>;
  if (envelope.v !== 1 || typeof envelope.sealed !== 'string') return null;
  const bundle = decodeNotice(envelope.sealed);
  if (bundle === null) return null;
  const bytes = openBox(bundle, secret);
  if (bytes === null) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return null; }
  finally { bytes.fill(0); }
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
