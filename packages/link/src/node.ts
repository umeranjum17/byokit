// Node only (`@byokit/link/node`): the host's key in a file. Kept out of the main entry so browsers and React Native
// never load a Node module.
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { b64url, keyPair, keyPairFrom, random, unb64url, type KeyPair } from './channel.ts';

/** The host's key pair, kept in `path` (0600, in a 0700 folder, written atomically). The first call makes it.
 *  A file that exists but can't be read as a key is never replaced: a new key would silently cut off every paired
 *  device, so it throws and a person decides. */
export function hostKeyFile(path: string): KeyPair {
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if ((lstatSync(folder).mode & 0o777) !== 0o700) throw new Error(`${folder} must be a private 0700 folder for the link key`);
  const existing = () => {
    const st = lstatSync(path);
    if (!st.isFile()) throw new Error(`${path} is not a plain file; refusing to use it as the link key`);
    if (st.mode & 0o077) throw new Error(`${path} allows others to read or write; refusing to use it as the link key`);
    const o = JSON.parse(readFileSync(path, 'utf8'));
    const secret = typeof o?.secretKey === 'string' ? unb64url(o.secretKey) : new Uint8Array();
    if (o?.v !== 1 || secret.length !== 32) throw new Error(`${path} does not hold a link key; refusing to replace it`);
    return keyPairFrom(secret);
  };
  try { return existing(); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
  const keys = keyPair();
  const tmp = `${path}.${process.pid}.${b64url(random(6))}.tmp`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify({ v: 1, secretKey: b64url(keys.secretKey) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(tmp, path); } catch (e: any) { if (e?.code === 'EEXIST') return existing(); throw e; }
    return keys;
  } finally { try { unlinkSync(tmp); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
}
