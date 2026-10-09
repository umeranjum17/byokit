import { existsSync, readFileSync } from 'node:fs';
import { hostKeyFileDirectory, hostKeyFileSeal, durableReplace, type HostKeyFileOptions } from './host-key-file.ts';
import { boundedKeyring } from './bounded-keyring.ts';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { openSecretBox, sealSecretBox } from '@byokit/seal';
import { KeystoreError } from './errors.ts';
import type { KeyringBackend } from './os-keyring.ts';
import { assertName } from './validate.ts';

/** Structurally matches @byokit/accounts' SafeStorageLike; no accounts runtime dependency. */
export interface SealingAdapter {
  readonly mode?: 'keyring' | 'host-key-file' | 'host-key' | 'dual-wrap';
  encryptString(text: string): Uint8Array;
  decryptString(data: Buffer): string;
  /** Optional authenticated migration. Caller verifies and atomically replaces under its writer lock. */
  upgrade?(data: Buffer): Uint8Array | undefined;
}

export type HostKey = Uint8Array | (() => Uint8Array);
export type HostKeySealOptions = {
  /** Exactly 32 bytes; ownership stays with the host. The resolver must be synchronous. */
  key: HostKey;
  /** An app-owned context, authenticated inside every envelope. Default 'byokit-host-key'. */
  service?: string;
};
export type OSKeyringSealOptions = HostKeyFileOptions & {
  /** Disable the automatic file fallback when an OS keyring is mandatory. */
  fallback?: boolean;
  /** Also wrap with an owner-only host file key. Default false; weakens protection to that file. */
  dualWrap?: boolean;
  /** Bound each native operation; default 1000 ms, maximum 5000 ms. */
  timeoutMs?: number;
  /** Inject a fake in tests; production uses native OS APIs. Dedicated to this service. */
  keyring?: KeyringBackend;
};
export interface OSKeyringSeal extends SealingAdapter {
  readonly mode: 'keyring' | 'host-key-file' | 'dual-wrap';
  /** Keyring and dual modes: activate a fresh key, retaining old keys. Returns its id. */
  rotateKey(): string;
  /** Re-seal supplied files under the host writer lock; dual mode retains wrapping keys. */
  rotate(paths?: readonly string[]): void;
}

// BKS1 | mode (host=0, keyring=1, file=2) | key id (16) | secretbox (nonce + MAC + ciphertext).
// The complete header is repeated INSIDE the authenticated plaintext; metadata cannot be rewritten.
const MAGIC = Buffer.from('BKS1');
const HEADER_BYTES = 21;
const ACTIVE = 'byokit-seal-active-v1';
const keyName = (id: string) => `byokit-seal-key-v1-${id}`;
const authFailed = () => new KeystoreError('auth-failed', 'Sealed credentials could not be authenticated');

function copyKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    throw new KeystoreError('invalid', 'A sealing key must be exactly 32 bytes');
  }
  return Buffer.from(value);
}
// The authenticated envelope is exactly the bytes JSON.stringify({ service, text }) produces, but escaped in
// bounded chunks: JSON string escaping is per character, so chunk-wise escaping (never splitting a surrogate
// pair, whose halves would otherwise escape differently than the pair) is byte-identical to the whole-string
// stringify. A full second stringify once made the payload a second runtime string the size of the snapshot
// itself and aborted the process on the string limit; here the largest string is one chunk.
const ENVELOPE_CHUNK = 1 << 20;
function envelope(text: string, service: string): Buffer {
  const parts: Buffer[] = [Buffer.from(`{"service":${JSON.stringify(service)},"text":"`, 'utf8')];
  for (let at = 0; at < text.length;) {
    let end = Math.min(at + ENVELOPE_CHUNK, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end++; // keep a surrogate pair in one chunk
    const escaped = JSON.stringify(text.slice(at, end));
    parts.push(Buffer.from(escaped.slice(1, -1), 'utf8'));
    at = end;
  }
  parts.push(Buffer.from('"}', 'utf8'));
  const out = Buffer.concat(parts);
  for (const part of parts) part.fill(0);
  return out;
}
export function encrypt(text: string, key: Buffer, header: Buffer, service: string): Uint8Array {
  if (typeof text !== 'string') throw new KeystoreError('invalid', 'Sealing requires a string');
  const payload = envelope(text, service);
  const plain = Buffer.concat([header, payload]);
  try { return Buffer.concat([header, sealSecretBox(plain, key)]); }
  finally { payload.fill(0); plain.fill(0); }
}
export function headerOf(data: Buffer, mode: number): Buffer {
  if (!(data instanceof Uint8Array) || data.length < HEADER_BYTES + 40 + HEADER_BYTES ||
      !MAGIC.equals(data.subarray(0, 4)) || data[4] !== mode) throw authFailed();
  return data.subarray(0, HEADER_BYTES);
}
export function decrypt(data: Buffer, key: Buffer, header: Buffer, service: string): string {
  const plain = openSecretBox(data.subarray(HEADER_BYTES), key);
  if (!plain) throw authFailed();
  try {
    if (plain.length < HEADER_BYTES || !timingSafeEqual(plain.subarray(0, HEADER_BYTES), header)) throw authFailed();
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain.subarray(HEADER_BYTES)));
    if (!parsed || typeof parsed !== 'object' || !('service' in parsed) || parsed.service !== service ||
        !('text' in parsed) || typeof parsed.text !== 'string') throw authFailed();
    return parsed.text;
  } catch { throw authFailed(); }
  finally { plain.fill(0); }
}
export function makeHeader(mode: number, id: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from([mode]), id]);
}

/** Explicit server/headless sealing. Never creates a key or writes it to disk. */
export function hostKeySeal(o: HostKeySealOptions): SealingAdapter {
  const service = o?.service ?? 'byokit-host-key';
  assertName(service, 'service');
  const source = o?.key;
  if (typeof source !== 'function') copyKey(source).fill(0);
  const withKey = <T>(fn: (key: Buffer) => T): T => {
    let value: Uint8Array;
    try { value = typeof source === 'function' ? source() : source; }
    catch { throw new KeystoreError('unavailable', 'The host sealing key is unavailable'); }
    const key = copyKey(value);
    try { return fn(key); } finally { key.fill(0); }
  };
  const header = makeHeader(0, Buffer.alloc(16));
  return {
    mode: 'host-key',
    encryptString: (text) => withKey((key) => encrypt(text, key, header, service)),
    decryptString(data) {
      const readHeader = headerOf(data, 0);
      return withKey((key) => decrypt(data, key, readHeader, service));
    },
  };
}

/** Ready adapter for accounts.fileStore(path, osKeyringSeal({ service })). */
function keyringSeal(o: OSKeyringSealOptions, probe = false): OSKeyringSeal {
  assertName(o?.service, 'service');
  const service = o.service;
  const ring = o.keyring ?? boundedKeyring({ service, timeoutMs: o.timeoutMs });
  const call = <T>(fn: () => T): T => {
    try { return fn(); }
    catch { throw new KeystoreError('unavailable', 'No OS keyring is available or accessible'); }
  };
  const readKey = (id: string): Buffer => {
    const text = call(() => ring.get(keyName(id)));
    // Never replace a missing or damaged key: doing so would orphan existing data.
    if (typeof text !== 'string' || !/^[a-f0-9]{64}$/.test(text)) throw authFailed();
    return Buffer.from(text, 'hex');
  };
  const rotate = (): string => {
    const id = randomBytes(16).toString('hex');
    const key = randomBytes(32);
    try {
      // Immutable, random key names keep concurrent initialization/rotation from losing keys.
      call(() => ring.set(keyName(id), key.toString('hex')));
      // Confirm persistence before activating a key. A failed activation may leave an unused key.
      const saved = readKey(id);
      try { if (!timingSafeEqual(saved, key)) throw authFailed(); }
      finally { saved.fill(0); }
      call(() => ring.set(ACTIVE, id));
      return id;
    } finally { key.fill(0); }
  };
  const current = (): string => {
    const id = call(() => ring.get(ACTIVE));
    if (id === null) return rotate();
    if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw authFailed();
    return id;
  };
  // Probe non-interactive access before selecting keyring mode, without creating a key.
  if (probe) call(() => ring.get(ACTIVE));
  return {
    mode: 'keyring',
    encryptString(text) {
      if (typeof text !== 'string') throw new KeystoreError('invalid', 'Sealing requires a string');
      const id = current();
      const key = readKey(id);
      try { return encrypt(text, key, makeHeader(1, Buffer.from(id, 'hex')), service); }
      finally { key.fill(0); }
    },
    decryptString(data) {
      const header = headerOf(data, 1);
      try {
        const key = readKey(header.subarray(5).toString('hex'));
        try { return decrypt(data, key, header, service); }
        finally { key.fill(0); }
      } catch (error) {
        if (error instanceof KeystoreError && error.code === 'unavailable') throw keyringLocked();
        throw error;
      }
    },
    rotateKey: rotate,
    rotate(paths) {
      if (!paths?.length) throw new KeystoreError('invalid', 'Rotation requires all sealed store paths');
      // Old keys remain until all rewrites succeed, including an interrupted rotation.
      const sources = paths.map((path) => ({ path, text: this.decryptString(readFileSync(path)) }));
      const old = current();
      rotate();
      for (const { path, text } of sources) durableReplace(path, this.encryptString(text));
      call(() => ring.delete(keyName(old)));
    },
  };
}

const keyringLocked = () => new KeystoreError('keyring-locked', 'Saved sign-in is locked or temporarily inaccessible; try again after unlocking password storage');
const inaccessible = (error: unknown) => error instanceof KeystoreError && ['unavailable', 'unsupported', 'keyring-locked'].includes(error.code);

/** Writes use the selected mode; reads always use the authenticated envelope's mode. */
export function osKeyringSeal(o: OSKeyringSealOptions): OSKeyringSeal {
  assertName(o?.service, 'service');
  if (o.dualWrap && o.fallback === false) throw new KeystoreError('invalid', 'Dual wrapping requires the host key fallback');
  let ring: OSKeyringSeal | undefined;
  let file: ReturnType<typeof hostKeyFileSeal> | undefined;
  const host = () => file ??= hostKeyFileSeal(o);
  const keyring = () => ring ??= keyringSeal(o);
  let mode: OSKeyringSeal['mode'] = 'host-key-file';
  if (o.dualWrap || o.fallback === false || !existsSync(hostKeyFileDirectory(o))) {
    try { ring = keyringSeal(o, true); mode = o.dualWrap ? 'dual-wrap' : 'keyring'; }
    catch (error) { if (!inaccessible(error) || o.fallback === false) throw error; }
  }
  if (mode === 'host-key-file') host();
  const ringDecrypt = (data: Buffer): string => {
    try { return keyring().decryptString(data); }
    catch (error) { if (inaccessible(error)) throw keyringLocked(); throw error; }
  };
  // Mode 3: header | two u32 wrap lengths | keyring wrap | host wrap | payload box.
  // Both wraps contain the random payload key and the outer header. The payload also
  // authenticates a hash of BOTH wraps and their lengths, even when one is inaccessible.
  let dualSource: Buffer | undefined;
  const context = (wraps: Buffer) => `${o.service}:dual:${createHash('sha256').update(wraps).digest('hex')}`;
  const dualEncrypt = (text: string): Uint8Array => {
    const header = makeHeader(3, randomBytes(16));
    const key = randomBytes(32);
    try {
      const wrappedText = JSON.stringify({ header: header.toString('hex'), key: key.toString('hex') });
      let a: Buffer;
      try { a = Buffer.from(keyring().encryptString(wrappedText)); }
      catch (error) {
        if (!inaccessible(error) || !dualSource) throw error;
        // Reuse only encrypted wrapping metadata from a fully authenticated read.
        // Fresh secretbox nonces permit updating its payload while the keyring stays locked.
        return dualRewrite(text, dualSource);
      }
      const b = Buffer.from(host().encryptString(wrappedText));
      const lengths = Buffer.alloc(8); lengths.writeUInt32BE(a.length, 0); lengths.writeUInt32BE(b.length, 4);
      const wraps = Buffer.concat([lengths, a, b]);
      const payload = Buffer.from(encrypt(text, key, header, context(wraps)));
      return Buffer.concat([header, wraps, payload.subarray(HEADER_BYTES)]);
    } finally { key.fill(0); }
  };
  const dualParts = (data: Buffer, payload = true) => {
    const header = headerOf(data, 3);
    if (data.length < HEADER_BYTES + 8) throw authFailed();
    const aLength = data.readUInt32BE(HEADER_BYTES), bLength = data.readUInt32BE(HEADER_BYTES + 4);
    const split = HEADER_BYTES + 8 + aLength, end = split + bLength;
    if (aLength < HEADER_BYTES + 40 + HEADER_BYTES || bLength < HEADER_BYTES + 40 + HEADER_BYTES || end > data.length - (payload ? 40 + HEADER_BYTES : 0)) throw authFailed();
    const a = data.subarray(HEADER_BYTES + 8, split), b = data.subarray(split, end);
    headerOf(a, 1); headerOf(b, 2);
    let text: string;
    try { text = ringDecrypt(a); }
    catch (error) { if (!inaccessible(error)) throw error; text = host().decryptString(b); }
    let key: Buffer;
    try {
      const wrap = JSON.parse(text) as { header?: unknown; key?: unknown };
      if (wrap?.header !== header.toString('hex') || typeof wrap.key !== 'string' || !/^[a-f0-9]{64}$/.test(wrap.key)) throw authFailed();
      key = Buffer.from(wrap.key, 'hex');
    } catch { throw authFailed(); }
    return { header, key, wraps: data.subarray(HEADER_BYTES, end), end };
  };
  const dualRewrite = (text: string, source: Buffer): Uint8Array => {
    const { header, key, wraps } = dualParts(source, false);
    try { return Buffer.concat([header, wraps, Buffer.from(encrypt(text, key, header, context(wraps))).subarray(HEADER_BYTES)]); }
    finally { key.fill(0); }
  };
  const dualDecrypt = (data: Buffer): string => {
    const { header, key, wraps, end } = dualParts(data);
    try {
      const text = decrypt(Buffer.concat([header, data.subarray(end)]), key, header, context(wraps));
      dualSource = Buffer.from(data.subarray(0, end));
      return text;
    } finally { key.fill(0); }
  };
  const adapter: OSKeyringSeal = {
    get mode() { return mode; },
    encryptString(text) {
      if (mode === 'dual-wrap') return dualEncrypt(text);
      return mode === 'keyring' ? keyring().encryptString(text) : host().encryptString(text);
    },
    decryptString(data) {
      // Validate the common header BEFORE invoking any backend.
      headerOf(data, data?.[4]);
      if (data[4] === 1) {
        const text = ringDecrypt(data);
        mode = o.dualWrap ? 'dual-wrap' : 'keyring';
        return text;
      }
      if (data[4] === 2) {
        const text = host().decryptString(data);
        if (!o.dualWrap) mode = 'host-key-file';
        return text;
      }
      if (data[4] === 3) {
        const text = dualDecrypt(data);
        mode = 'dual-wrap';
        return text;
      }
      throw authFailed();
    },
    upgrade(data) {
      if (!o.dualWrap || data[4] !== 1) return undefined;
      // A failed upgrade never mutates the input or retires its original key.
      return dualEncrypt(ringDecrypt(data));
    },
    rotateKey() {
      if (mode === 'host-key-file') throw new KeystoreError('invalid', 'Use rotate(paths) to rotate an automatic host key');
      return keyring().rotateKey();
    },
    rotate(paths) {
      if (!paths?.length) {
        if (mode === 'host-key-file') { host().rotate(paths); return; }
        throw new KeystoreError('invalid', 'Rotation requires all sealed store paths');
      }
      const bytes = paths.map(path => ({ path, data: readFileSync(path) }));
      if (new Set(bytes.map(({ data }) => data[4])).size !== 1) throw new KeystoreError('invalid', 'Rotate each sealing mode separately');
      // Authenticate and adopt the stores' mode before choosing a rotation backend.
      const sources = bytes.map(({ path, data }) => ({ path, text: adapter.decryptString(data) }));
      if (mode === 'host-key-file') { host().rotate(paths); return; }
      if (mode === 'keyring') { keyring().rotate(paths); return; }
      // Retain prior wrapping keys until callers deliberately retire their backups.
      keyring().rotateKey();
      for (const { path, text } of sources) durableReplace(path, adapter.encryptString(text));
    },
  };
  return adapter;
}
