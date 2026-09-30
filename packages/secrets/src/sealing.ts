import { randomBytes, timingSafeEqual } from 'node:crypto';
import { openSecretBox, sealSecretBox } from '@byokit/seal';
import { KeystoreError } from './errors.ts';
import { osKeyring, type KeyringBackend } from './os-keyring.ts';
import { assertName } from './validate.ts';

/** Structurally matches @byokit/accounts' SafeStorageLike; no accounts runtime dependency. */
export interface SealingAdapter {
  encryptString(text: string): Uint8Array;
  decryptString(data: Buffer): string;
}

export type HostKey = Uint8Array | (() => Uint8Array);
export type HostKeySealOptions = {
  /** Exactly 32 bytes; ownership stays with the host. The resolver must be synchronous. */
  key: HostKey;
  /** An app-owned context, authenticated inside every envelope. Default 'byokit-host-key'. */
  service?: string;
};
export type OSKeyringSealOptions = {
  service: string;
  /** Inject a fake in tests; production uses native OS APIs. Dedicated to this service. */
  keyring?: KeyringBackend;
};
export interface OSKeyringSeal extends SealingAdapter {
  /** New writes use a fresh key; old keys remain so existing files/backups still open. Returns its id. */
  rotateKey(): string;
}

// BKS1 | mode (host=0, keyring=1) | key id (16) | secretbox (nonce + MAC + ciphertext).
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
function encrypt(text: string, key: Buffer, header: Buffer, service: string): Uint8Array {
  if (typeof text !== 'string') throw new KeystoreError('invalid', 'Sealing requires a string');
  const payload = Buffer.from(JSON.stringify({ service, text }), 'utf8');
  const plain = Buffer.concat([header, payload]);
  try { return Buffer.concat([header, sealSecretBox(plain, key)]); }
  finally { payload.fill(0); plain.fill(0); }
}
function headerOf(data: Buffer, mode: number): Buffer {
  if (!(data instanceof Uint8Array) || data.length < HEADER_BYTES + 40 + HEADER_BYTES ||
      !MAGIC.equals(data.subarray(0, 4)) || data[4] !== mode) throw authFailed();
  return data.subarray(0, HEADER_BYTES);
}
function decrypt(data: Buffer, key: Buffer, header: Buffer, service: string): string {
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
function makeHeader(mode: number, id: Buffer): Buffer {
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
    encryptString: (text) => withKey((key) => encrypt(text, key, header, service)),
    decryptString(data) {
      const readHeader = headerOf(data, 0);
      return withKey((key) => decrypt(data, key, readHeader, service));
    },
  };
}

/** Ready adapter for accounts.fileStore(path, osKeyringSeal({ service })). */
export function osKeyringSeal(o: OSKeyringSealOptions): OSKeyringSeal {
  assertName(o?.service, 'service');
  const service = o.service;
  const ring = o.keyring ?? osKeyring({ service });
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
  // Probe access without creating a key. Empty accounts stores must also fail closed on headless hosts.
  call(() => ring.get(ACTIVE));
  return {
    encryptString(text) {
      if (typeof text !== 'string') throw new KeystoreError('invalid', 'Sealing requires a string');
      const id = current();
      const key = readKey(id);
      try { return encrypt(text, key, makeHeader(1, Buffer.from(id, 'hex')), service); }
      finally { key.fill(0); }
    },
    decryptString(data) {
      const header = headerOf(data, 1);
      const key = readKey(header.subarray(5).toString('hex'));
      try { return decrypt(data, key, header, service); }
      finally { key.fill(0); }
    },
    rotateKey: rotate,
  };
}
