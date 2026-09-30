// A passphrase-sealed file: the whole name→secret map in one sealSecretBox under a scrypt key.
// A wrong passphrase fails closed (auth-failed): nothing is returned and nothing is written.
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openSecretBox, sealSecretBox } from '@byokit/seal';
import { writeFileAtomic } from './atomic.ts';
import { KeystoreError } from './errors.ts';
import type { Keystore } from './types.ts';
import { assertName, assertSecret } from './validate.ts';

export type FileOptions = {
  /** Absolute path of the sealed file. */
  path: string;
  /** Never stored. A string cannot be zeroed (the runtime keeps copies); prefer a Uint8Array. */
  passphrase: string | Uint8Array;
};

const KDF = 'scrypt-16384-8-1';
const SALT_BYTES = 16;
const KEY_BYTES = 32;

function passphraseBytes(passphrase: string | Uint8Array): { bytes: Uint8Array; owned: boolean } {
  if (typeof passphrase === 'string') {
    if (passphrase.length === 0) throw new KeystoreError('invalid', 'keystore passphrase must not be empty');
    return { bytes: new TextEncoder().encode(passphrase), owned: true };
  }
  if (passphrase instanceof Uint8Array) {
    if (passphrase.length === 0) throw new KeystoreError('invalid', 'keystore passphrase must not be empty');
    return { bytes: passphrase, owned: false };
  }
  throw new KeystoreError('invalid', 'keystore passphrase must be a string or bytes');
}

function deriveKey(passphrase: string | Uint8Array, salt: Uint8Array): Uint8Array {
  const { bytes, owned } = passphraseBytes(passphrase);
  try {
    return scryptSync(bytes, salt, KEY_BYTES, { N: 16384, r: 8, p: 1 });
  } finally {
    if (owned) bytes.fill(0);
  }
}

type Entries = Record<string, string>;

function readEntries(path: string, passphrase: string | Uint8Array): Entries | null {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (e: any) {
    if (e?.code === 'ENOENT') return null;
    throw new KeystoreError('failed', 'keystore file is not readable');
  }
  let file: any;
  try {
    file = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new KeystoreError('failed', 'keystore file is not valid JSON');
  }
  if (typeof file !== 'object' || file === null || file.v !== 1 || typeof file.salt !== 'string' || typeof file.box !== 'string') {
    throw new KeystoreError('failed', 'keystore file has an unexpected shape');
  }
  let salt: Uint8Array;
  let box: Uint8Array;
  try {
    salt = new Uint8Array(Buffer.from(file.salt, 'base64'));
    box = new Uint8Array(Buffer.from(file.box, 'base64'));
  } catch {
    throw new KeystoreError('failed', 'keystore file has an unexpected shape');
  }
  if (salt.length !== SALT_BYTES) throw new KeystoreError('failed', 'keystore file has an unexpected shape');
  const key = deriveKey(passphrase, salt);
  try {
    const inner = openSecretBox(box, key);
    if (inner === null) throw new KeystoreError('auth-failed', 'wrong passphrase or tampered keystore file');
    let parsed: any;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(inner));
    } catch {
      throw new KeystoreError('failed', 'keystore file holds an unexpected shape');
    }
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.entries !== 'object' || parsed.entries === null) {
      throw new KeystoreError('failed', 'keystore file holds an unexpected shape');
    }
    for (const [name, secret] of Object.entries(parsed.entries)) {
      assertName(name);
      assertSecret(secret as string);
    }
    return parsed.entries;
  } finally {
    key.fill(0);
  }
}

function writeEntries(path: string, passphrase: string | Uint8Array, entries: Entries): void {
  const salt = randomBytes(SALT_BYTES);
  const key = deriveKey(passphrase, new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength));
  try {
    const box = sealSecretBox(new TextEncoder().encode(JSON.stringify({ entries })), key);
    const file = JSON.stringify({
      v: 1,
      kdf: KDF,
      salt: Buffer.from(salt).toString('base64'),
      box: Buffer.from(box).toString('base64'),
    });
    writeFileAtomic(path, file);
  } finally {
    key.fill(0);
  }
}

export function fileStore(o: FileOptions): Keystore {
  if (typeof o !== 'object' || o === null) throw new KeystoreError('invalid', 'keystore file options must be an object');
  if (typeof o.path !== 'string' || !isAbsolute(o.path)) throw new KeystoreError('invalid', 'keystore file path must be absolute');
  passphraseBytes(o.passphrase); // validates now, so a bad passphrase fails before any disk touch
  const { path, passphrase } = o;
  return {
    async get(name: string): Promise<string | null> {
      assertName(name);
      const entries = readEntries(path, passphrase);
      if (entries === null) return null;
      return Object.hasOwn(entries, name) ? entries[name] : null;
    },
    async set(name: string, secret: string): Promise<void> {
      assertName(name);
      assertSecret(secret);
      const entries = readEntries(path, passphrase) ?? {};
      entries[name] = secret;
      writeEntries(path, passphrase, entries);
    },
    async delete(name: string): Promise<boolean> {
      assertName(name);
      const entries = readEntries(path, passphrase);
      if (entries === null || !Object.hasOwn(entries, name)) return false;
      delete entries[name];
      writeEntries(path, passphrase, entries);
      return true;
    },
  };
}
