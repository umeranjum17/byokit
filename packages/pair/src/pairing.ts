// What pairing puts in front of a person: the QR's text (or a link that carries it), and the typed code.
import b4a from 'b4a';
import { b64url, hash, random, unb64url } from './channel.ts';
import type { Role } from './host.ts';

/** What a scanned QR (or opened pairing link) holds. The ticket is single-use and short-lived. `role` and `lifetime`
 *  (how long the device's access lasts, in ms; absent means until removed) let the device say what it is agreeing to
 *  before it connects; 0.1 parsers ignore them, and the host's own records decide. */
export type PairOffer = { v: 1; host: string; name: string; urls: string[]; ticket: string; expires: number; role?: Role; lifetime?: number };

const TAG = 'byokit-link:1:';
const UNSAFE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu; // control and direction-flipping characters

/** A device or host name as a person should see it: no hidden characters, at most 60 of them. */
export const cleanName = (name: unknown, fallback: string): string =>
  (typeof name === 'string' ? name.replace(UNSAFE, '').trim().slice(0, 60) : '') || fallback;

/** The QR's text. Give a web address (`https://…/pair`) to get a link a browser can open instead: the offer rides in
 *  the part after `#`, which browsers never send to a server. */
export function offerText(offer: PairOffer, base?: string): string {
  const body = TAG + b64url(b4a.from(JSON.stringify(offer)));
  return base ? `${base}#${body}` : body;
}

/** Scan (or pasted link) in, offer out; throws a plain sentence for anything that is not a live byokit pairing code.
 * Pass `0` as `now` to inspect an expired offer without connecting. */
export function parseOffer(scanned: string, now = Date.now()): PairOffer {
  const at = scanned.indexOf(TAG);
  let o: any;
  try {
    if (at < 0 || scanned.length > 8192) throw new Error();
    o = JSON.parse(b4a.toString(b4a.from(unb64url(scanned.slice(at + TAG.length).trim()))));
    if (typeof o?.host !== 'string' || unb64url(o.host).length !== 32 ||
        typeof o.ticket !== 'string' || unb64url(o.ticket).length !== 16) throw new Error();
  } catch {
    throw new Error("That isn't a pairing code.");
  }
  const ok = o?.v === 1 && Number.isFinite(o.expires)
    && Array.isArray(o.urls) && o.urls.length > 0 && o.urls.length <= 8 && o.urls.every(wsUrl);
  if (!ok) throw new Error("That isn't a pairing code.");
  if (o.expires < now) throw new Error('That pairing code has run out. Show a new one.');
  return { v: 1, host: o.host, name: cleanName(o.name, 'your computer'), urls: o.urls, ticket: o.ticket, expires: o.expires,
    ...(o.role === 'control' || o.role === 'view' ? { role: o.role } : {}),
    ...(Number.isSafeInteger(o.lifetime) && o.lifetime > 0 ? { lifetime: o.lifetime } : {}) };
}

function wsUrl(u: unknown): boolean {
  if (typeof u !== 'string' || u.length > 512) return false;
  try {
    const p = new URL(u);
    return (p.protocol === 'ws:' || p.protocol === 'wss:') && !p.username && !p.password;
  } catch {
    return false;
  }
}

// A separate offline envelope, not the short PSK code. Preserve every offer field (including relay addresses and
// exact expiry) rather than borrowing the reference's direct-only, second-resolution compact representation.
const OFFER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TYPED_OFFER = 14_000;
const badOffer = () => new Error("That code didn't match. Check it and try again.");

// FNV-1a detects transcription errors. It is not authentication; the Noise handshake pins the host key.
function checksum(bytes: Uint8Array): number {
  let h = 2166136261;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}

/** A complete offline offer in groups of five base32 characters, with a transcription checksum. This carries the
 * same single-use ticket as the QR; it neither extends expiry nor replaces host approval. */
export function encodeOffer(offer: PairOffer): string {
  const checked = parseOffer(offerText(offer), 0);
  const body = b4a.from(JSON.stringify(checked));
  const bytes = new Uint8Array(1 + body.length + 4);
  bytes[0] = 1;
  bytes.set(body, 1);
  new DataView(bytes.buffer).setUint32(bytes.length - 4, checksum(bytes.subarray(0, -4)));
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8 | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += OFFER_ALPHABET[(value >>> bits) & 31]; }
  }
  if (bits) out += OFFER_ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g)!.join('-');
}

/** Read an offline offer without network access. Case, spaces and dashes are ignored; O means 0 and I/L mean 1.
 * Old compact direct offers remain readable for migration; new offers always use the current format.
 * Other typos fail the checksum. Expiry and addresses follow `parseOffer`; `now = 0` permits inspection only. */
export function decodeOffer(text: string, now = Date.now()): PairOffer {
  if (text.length > MAX_TYPED_OFFER) throw badOffer();
  const compact = text.toUpperCase().replace(/[\s-]/g, '');
  // Legacy v1 + role starts with 26 in its own alphabet; current v1 starts with 0.
  if (compact.startsWith('26')) return decodeLegacyOffer(compact, now);
  const s = compact.replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!s || [...s].some((c) => !OFFER_ALPHABET.includes(c))) throw badOffer();
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const c of s) {
    value = (value << 5 | OFFER_ALPHABET.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  // Reject extra zero symbols as well as non-zero padding: one byte sequence has one canonical encoding.
  if (s.length !== Math.ceil(bytes.length * 8 / 5) || (bits && (value & ((1 << bits) - 1)))) throw badOffer();
  const b = Uint8Array.from(bytes);
  if (b.length < 6 || b[0] !== 1 || checksum(b.subarray(0, -4)) !== new DataView(b.buffer).getUint32(b.length - 4)) throw badOffer();
  return parseOffer(TAG + b64url(b.subarray(1, -4)), now);
}

// Migration read path only. The old direct envelope used seconds, a role byte and no name/lifetime.
function decodeLegacyOffer(s: string, now: number): PairOffer {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ0';
  if (s.length > 2048 || [...s].some((c) => !alphabet.includes(c))) throw badOffer();
  const bytes: number[] = [];
  let bits = 0, value = 0;
  for (const c of s) {
    value = (value << 5 | alphabet.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  if (s.length !== Math.ceil(bytes.length * 8 / 5) || (bits && (value & ((1 << bits) - 1)))) throw badOffer();
  const b = Uint8Array.from(bytes);
  if (b.length < 59 || b[0] !== 1 || b[1]! > 1) throw badOffer();
  const end = b.length - 4;
  const view = new DataView(b.buffer);
  if (checksum(b.subarray(0, end)) !== view.getUint32(end)) throw badOffer();
  const count = b[54]!;
  if (!count || count > 8) throw badOffer();
  let at = 55;
  const urls: string[] = [];
  for (let i = 0; i < count; i++) {
    if (at >= end) throw badOffer();
    const length = b[at++]!;
    if (length === 0) {
      if (at + 6 > end) throw badOffer();
      const port = view.getUint16(at + 4);
      if (!port) throw badOffer();
      urls.push(`ws://${[...b.subarray(at, at + 4)].join('.')}:${port}/link`);
      at += 6;
    } else {
      if (at + length > end) throw badOffer();
      try { urls.push(new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(at, at + length))); }
      catch { throw badOffer(); }
      at += length;
    }
  }
  if (at !== end || urls.some((url) => !url.startsWith('ws:') || !wsUrl(url))) throw badOffer();
  return parseOffer(offerText({
    v: 1, host: b64url(b.subarray(2, 34)), ticket: b64url(b.subarray(34, 50)),
    expires: view.getUint32(50) * 1000, name: 'your computer', role: b[1] ? 'control' : 'view', urls,
  }), now);
}

/** Typed codes use letters and numbers nobody mixes up (no 0/O, 1/I/L). Twelve of them are about 59 bits: too many
 *  to guess, even offline, in the few minutes a code lives. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;

export function newCode(): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const b of random(32)) if (b < 248 && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % 31]; // 248 = 8 × 31, so no bias
  }
  return code.match(/.{4}/g)!.join('-');
}

/** A legacy secret or machine-bound short code, normalized or null. Case, spaces and dashes don't matter. */
export function normalizeCode(typed: string): string | null {
  if (typed.length > 256) return null;
  const c = typed.toUpperCase().replace(/[\s-]/g, '');
  if (c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch))) return c;
  return /^K1[2-9A-HJKMNP-Z]{12}[0-9A-F]{32}$/.test(c) ? c : null;
}

/** Public machine-key commitment; the secret's entropy still comes only from `newCode`. */
export const shortKey = (hostKey: Uint8Array): string =>
  [...hash(16, 'byokit-link-short-key-v1', hostKey)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();

export const bindCode = (code: string, hostKey: Uint8Array): string =>
  `K1-${code}-${shortKey(hostKey).match(/.{4}/g)!.join('-')}`;

/** Accept a bound code or the legacy secret; malformed bound codes never downgrade. */
export function parseCode(typed: string): { secret: string; commitment?: string } | null {
  const compact = normalizeCode(typed);
  if (!compact) return null;
  if (compact.length === CODE_LENGTH) return { secret: compact };
  return { secret: compact.slice(2, 14), commitment: compact.slice(14) };
}

/** The Noise pre-shared key a typed code stands for. */
export const codeKey = (code: string): Uint8Array => hash(32, 'byokit-link-code-v1', parseCode(code)?.secret ?? '');

// A compact pairing offer for the QR: the same secret a typed code carries (same single use, expiry, two words
// and host approval, through the same code entry), plus the addresses to try, packed binary. Scanned, never typed,
// so the QR's own error correction covers misreads and there is no transcription checksum. The tag is uppercase so
// the QR stays in its dense alphanumeric mode. Version 1 offers keep parsing unchanged.
export const COMPACT_TAG = 'BYOKIT-LINK:2:';
export type CompactOffer = { code: string; urls: string[]; expires: number; name: string; role: Role; lifetime?: number };

const COMPACT_VERSION = 2;
const COMPACT_ROLE = 1; // control; view is the default bit-off state
const COMPACT_LIFETIME = 2;
const badCompact = () => new Error("That isn't a pairing code.");

// Twelve base-31 digits need 63 bits, past float precision: BigInt throughout.
const secretValue = (secret: string): bigint => {
  let value = 0n;
  for (const c of secret) value = value * 31n + BigInt(CODE_ALPHABET.indexOf(c));
  return value;
};

const secretChars = (value: bigint): string => {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) { out = CODE_ALPHABET[Number(value % 31n)] + out; value /= 31n; }
  return out;
};

// One address, packed: a type byte (secure scheme, IPv4 or name, default `/link` path or custom), then the address,
// an explicit port (the scheme default when the URL leaves it out), and any custom path and query.
function packUrl(u: string): number[] {
  const p = new URL(u);
  const secure = p.protocol === 'wss:';
  const v4 = p.hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const ip = v4 && v4.every((n) => n < 256) ? v4 as number[] : null;
  const port = p.port ? Number(p.port) : secure ? 443 : 80;
  // A bare authority (`ws://host:port`) keeps its empty path, so a decode is byte-stable; `/link` is still elided.
  const path = p.pathname === '/' && !p.search && !p.hash ? '' : p.pathname + p.search + p.hash;
  const textbook = path === '/link';
  const host = new TextEncoder().encode(p.hostname);
  const road = new TextEncoder().encode(path);
  if (!(port >= 1 && port <= 65535) || host.length > 255 || road.length > 255) throw new Error('That address is too long for a compact code.');
  const out = [(secure ? 128 : 0) | (ip ? 0 : 2) | (textbook ? 0 : 1)];
  out.push(...(ip ?? [host.length, ...host]));
  out.push(port >> 8, port & 255);
  if (!textbook) out.push(road.length, ...road);
  return out;
}

function unpackUrl(b: Uint8Array, at: { i: number }): string {
  if (at.i >= b.length) throw badCompact();
  const type = b[at.i++]!;
  const secure = (type & 128) !== 0;
  const custom = (type & 1) !== 0;
  let host: string;
  if ((type & 2) === 0) {
    if (at.i + 6 > b.length) throw badCompact();
    host = [...b.subarray(at.i, at.i + 4)].join('.');
    at.i += 4;
  } else {
    const length = b[at.i++]!;
    if (at.i + length + 2 > b.length) throw badCompact();
    try { host = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(at.i, at.i + length)); }
    catch { throw badCompact(); }
    at.i += length;
  }
  const port = (b[at.i]! << 8) | b[at.i + 1]!;
  at.i += 2;
  let path = '/link';
  if (custom) {
    const length = b[at.i++]!;
    if (at.i + length > b.length) throw badCompact();
    try { path = new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(at.i, at.i + length)); }
    catch { throw badCompact(); }
    at.i += length;
  }
  // The port is always written back: the envelope holds it explicitly, so the text has one canonical shape.
  const url = `${secure ? 'wss' : 'ws'}://${host}:${port}${path}`;
  if (!wsUrl(url)) throw badCompact();
  return url;
}

/** Pack a code secret, its addresses and terms into QR-sized text. Throws a plain sentence for anything that would
 *  not survive the trip (bad addresses, absurd lengths); the host calls this before storing the code, so a throw
 *  leaves no open entry behind. */
export function encodeCompactOffer(o: { code: string; urls: string[]; expires: number; name: string; role: Role; lifetime?: number }): string {
  const secret = o.code.toUpperCase().replace(/[\s-]/g, '');
  if (secret.length !== CODE_LENGTH || [...secret].some((c) => !CODE_ALPHABET.includes(c))) throw badCompact();
  if (!Array.isArray(o.urls) || o.urls.length === 0 || o.urls.length > 8 || !o.urls.every(wsUrl)) throw badCompact();
  if (!Number.isFinite(o.expires) || o.expires <= 0) throw badCompact();
  if (o.role !== 'control' && o.role !== 'view') throw badCompact();
  if (o.lifetime !== undefined && (!Number.isSafeInteger(o.lifetime) || o.lifetime <= 0 || o.lifetime > 4294967295 * 1000)) throw new Error('A lifetime must fit in a compact code.');
  const bytes: number[] = [COMPACT_VERSION];
  let value = secretValue(secret);
  const word = new Array(8).fill(0) as number[];
  for (let i = 7; i >= 0; i--) { word[i] = Number(value & 255n); value >>= 8n; }
  bytes.push(...word);
  const minutes = Math.ceil(o.expires / 60000); // minute resolution; rounded up, so our own "run out" never fires early
  bytes.push((minutes >>> 24) & 255, (minutes >>> 16) & 255, (minutes >>> 8) & 255, minutes & 255);
  bytes.push((o.role === 'control' ? COMPACT_ROLE : 0) | (o.lifetime === undefined ? 0 : COMPACT_LIFETIME), o.urls.length);
  for (const u of o.urls) bytes.push(...packUrl(u));
  const name = new TextEncoder().encode(cleanName(o.name, 'your computer'));
  if (name.length > 255) throw new Error('That name is too long for a compact code.');
  bytes.push(name.length, ...name);
  if (o.lifetime !== undefined) {
    const seconds = Math.ceil(o.lifetime / 1000);
    bytes.push((seconds >>> 24) & 255, (seconds >>> 16) & 255, (seconds >>> 8) & 255, seconds & 255);
  }
  let bits = 0, acc = 0, out = '';
  for (const byte of bytes) {
    acc = (acc << 8 | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += OFFER_ALPHABET[(acc >>> bits) & 31]; }
  }
  if (bits) out += OFFER_ALPHABET[(acc << (5 - bits)) & 31];
  return COMPACT_TAG + out;
}

/** Read a compact offer. Case, spaces and dashes are forgiven; anything else that is not a compact offer throws a
 *  plain sentence. Expiry follows `parseOffer`; `now = 0` permits inspection only. */
export function decodeCompactOffer(scanned: string, now = Date.now()): CompactOffer {
  const at = scanned.indexOf(COMPACT_TAG);
  if (at < 0 || scanned.length > 2048) throw badCompact();
  const s = scanned.slice(at + COMPACT_TAG.length).toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (!s || [...s].some((c) => !OFFER_ALPHABET.includes(c))) throw badCompact();
  const raw: number[] = [];
  let bits = 0, acc = 0;
  for (const c of s) {
    acc = (acc << 5 | OFFER_ALPHABET.indexOf(c)) & 0xffff;
    bits += 5;
    if (bits >= 8) { bits -= 8; raw.push((acc >>> bits) & 255); }
  }
  // One byte sequence has one canonical encoding: reject extra symbols and non-zero padding, as typed offers do.
  if (s.length !== Math.ceil(raw.length * 8 / 5) || (bits && (acc & ((1 << bits) - 1)))) throw badCompact();
  const b = Uint8Array.from(raw);
  const pos = { i: 0 };
  const take = (n: number): Uint8Array => {
    if (pos.i + n > b.length) throw badCompact();
    return b.subarray(pos.i, (pos.i += n));
  };
  if (take(1)[0] !== COMPACT_VERSION) throw badCompact();
  let secret = 0n;
  for (const byte of take(8)) secret = secret * 256n + BigInt(byte);
  if (secret >= 31n ** BigInt(CODE_LENGTH)) throw badCompact();
  const code = secretChars(secret);
  if (pos.i + 4 > b.length) throw badCompact();
  const minutes = new DataView(b.buffer, b.byteOffset + pos.i, 4).getUint32(0);
  pos.i += 4;
  const flags = take(1)[0]!;
  if (flags & ~(COMPACT_ROLE | COMPACT_LIFETIME)) throw badCompact();
  const count = take(1)[0]!;
  if (!count || count > 8) throw badCompact();
  const urls: string[] = [];
  for (let i = 0; i < count; i++) urls.push(unpackUrl(b, pos));
  const nameLength = take(1)[0]!;
  let name: string;
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(take(nameLength)); }
  catch { throw badCompact(); }
  let lifetime: number | undefined;
  if (flags & COMPACT_LIFETIME) {
    if (pos.i + 4 > b.length) throw badCompact();
    lifetime = new DataView(b.buffer, b.byteOffset + pos.i, 4).getUint32(0) * 1000;
    pos.i += 4;
  }
  if (pos.i !== b.length) throw badCompact();
  const expires = minutes * 60000;
  if (expires < now) throw new Error('That pairing code has run out. Show a new one.');
  return { code, urls, expires, name: cleanName(name, 'your computer'),
    role: flags & COMPACT_ROLE ? 'control' : 'view', ...(lifetime === undefined ? {} : { lifetime }) };
}
