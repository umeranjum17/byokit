// Node only (`@byokit/link/node`): host key and device grant files. Kept out of the main entry for browsers and React Native.
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, unwatchFile, watchFile, writeFileSync, writeSync } from 'node:fs';
import type { Grant, GrantStore } from './host.ts';
import { dirname } from 'node:path';
import { b64url, keyPair, keyPairFrom, random, unb64url, type KeyPair } from './channel.ts';
import type { KeptDevice } from './stores.ts';

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
  let created = false;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    created = true;
    try { writeSync(fd, JSON.stringify({ v: 1, secretKey: b64url(keys.secretKey) })); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(tmp, path); } catch (e: any) { if (e?.code === 'EEXIST') return existing(); throw e; }
    return keys;
  } finally { if (created) try { unlinkSync(tmp); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
}

// A computer's device store (Node, Electron's main process): the grant in a 0600 file the app chooses; newly created
// folders are 0700, existing folders keep their permissions. Sealed with Electron's safeStorage when given; otherwise
// plaintext.

/** The parts of Electron's `safeStorage` this uses; pass `safeStorage` from 'electron' (main process, after `ready`). */
export type SafeStorageLike = { encryptString(text: string): Uint8Array; decryptString(data: Buffer): string };

export function fileDeviceStore(path: string, safeStorage?: SafeStorageLike): KeptDevice {
  return {
    async load() {
      let raw: Buffer;
      try { raw = readFileSync(path); } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
      const g = JSON.parse(safeStorage ? safeStorage.decryptString(raw) : raw.toString('utf8'));
      return g?.v === 1 ? g : null;
    },
    save(g) {
      const text = JSON.stringify(g);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.${b64url(random(6))}.tmp`;
      let created = false;
      try {
        const fd = openSync(tmp, 'wx', 0o600);
        created = true;
        try { writeFileSync(fd, safeStorage ? safeStorage.encryptString(text) : text); fsyncSync(fd); }
        finally { closeSync(fd); }
        renameSync(tmp, path);
      } finally { if (created) try { unlinkSync(tmp); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
    },
    clear() { rmSync(path, { force: true }); },
  };
}

/** Host grants at the app's path: atomic 0600 writes and notifications across processes, including rename/unlink.
 *  Cooperating writers lock and reject stale snapshots; notifications are advisory and Host.reload reads the authority.
 *  Polling avoids platform-dependent rename watcher loss. No keys or application files are discovered. */
export function fileGrantStore(path: string, intervalMs = 100): GrantStore {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error('A watch interval must be a positive whole number of milliseconds.');
  let loaded: string | null | undefined;
  const read = () => {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.mode & 0o077) throw new Error('Link grants must be a private plain file.');
      const folder = lstatSync(dirname(path));
      if (!folder.isDirectory() || (folder.mode & 0o777) !== 0o700) throw new Error('Link grants require a private 0700 folder.');
      return readFileSync(path, 'utf8');
    } catch (e: any) { if (e?.code === 'ENOENT') return null; throw e; }
  };
  return {
    load() {
      const text = read();
      if (text === null) { loaded = null; return []; }
      const grants: unknown = JSON.parse(text);
      if (!Array.isArray(grants) || grants.some((g) => !g || typeof g.id !== 'string' || typeof g.key !== 'string'
        || typeof g.name !== 'string' || !['view', 'control'].includes(g.role) || !Number.isFinite(g.created)
        || (g.expires !== undefined && !Number.isFinite(g.expires)))
        || new Set(grants.map((g) => g.id)).size !== grants.length) throw new Error('Invalid link grants.');
      loaded = text;
      return grants as Grant[];
    },
    async save(grants) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const folder = lstatSync(dirname(path));
      if (!folder.isDirectory() || (folder.mode & 0o777) !== 0o700) throw new Error('Link grants require a private 0700 folder.');
      // Cooperating writers use the same exclusive lock. Never erase an abandoned lock automatically.
      const lock = `${path}.lock`;
      let fd: number | undefined;
      const until = Date.now() + 5000;
      while (fd === undefined) {
        try { fd = openSync(lock, 'wx', 0o600); }
        catch (e: any) {
          if (e?.code !== 'EEXIST' || Date.now() >= until) throw e;
          await new Promise((r) => setTimeout(r, 10));
        }
      }
      const tmp = `${path}.${process.pid}.${b64url(random(6))}.tmp`;
      let created = false;
      try {
        const current = read();
        if (loaded !== undefined && current !== loaded) throw new Error('Link grants changed in another process; reload before saving.');
        const text = JSON.stringify(grants);
        const file = openSync(tmp, 'wx', 0o600);
        created = true;
        try { writeFileSync(file, text); fsyncSync(file); }
        finally { closeSync(file); }
        renameSync(tmp, path);
        loaded = text;
      } finally {
        try { if (created) unlinkSync(tmp); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
        finally { closeSync(fd); unlinkSync(lock); }
      }
    },
    subscribe(changed) {
      const listener = () => changed();
      watchFile(path, { interval: intervalMs, persistent: false }, listener);
      return () => unwatchFile(path, listener);
    },
  };
}
