// Desktop stores: sealed with a host-supplied adapter, such as Electron's safeStorage.
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, statSync, utimesSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { recordStore, type EndingStore } from './stores.ts';

/** Pass Electron's safeStorage from the main process after ready, or an equivalent trusted sealing adapter.
 * Adapters without capability methods are responsible for ensuring their key is protected. */
export type SafeStorageLike = {
  encryptString(text: string): Uint8Array;
  decryptString(data: Buffer): string;
  /** Optional authenticated format upgrade; fileStore verifies and atomically replaces it. */
  upgrade?(data: Buffer): Uint8Array | undefined;
  isEncryptionAvailable?(): boolean;
  getSelectedStorageBackend?(): string;
};

/** One person's sealed sign-ins in an app-owned 0600 file inside a private 0700 folder.
 * No plaintext fallback. Writes, a whole refresh included, are serialized across every process sharing the path through
 * a `<path>.lock` file beside it. The host owns the adapter and its key, separately from this file. */
export function fileStore(path: string, safeStorage: SafeStorageLike): EndingStore {
  const ready = () => {
    if (!safeStorage || typeof safeStorage.encryptString !== 'function' || typeof safeStorage.decryptString !== 'function') {
      throw new TypeError('fileStore requires a sealing adapter');
    }
    if (safeStorage.isEncryptionAvailable?.() === false || safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('Secure credential storage is unavailable');
    }
  };
  ready();
  const folder = dirname(path);
  const privateFolder = () => {
    const st = lstatSync(folder);
    if (!st.isDirectory() || (st.mode & 0o777) !== 0o700) throw new Error('Credential storage requires a private 0700 folder');
  };
  const load = async () => {
    ready();
    let fd: number;
    try {
      privateFolder();
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (e: any) { if (e?.code === 'ENOENT') return {}; throw e; }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || (st.mode & 0o077)) throw new Error('Credential storage requires a private regular file');
      const bytes = readFileSync(fd);
      const text = safeStorage.decryptString(bytes);
      const data = JSON.parse(text);
      const upgraded = safeStorage.upgrade?.(bytes);
      if (upgraded) {
        if (safeStorage.decryptString(Buffer.from(upgraded)) !== text) throw new Error('Credential upgrade verification failed');
        replace(upgraded);
      }
      return data;
    } finally { closeSync(fd); }
  };
  const save = async (data: object) => {
    ready();
    const sealed = safeStorage.encryptString(JSON.stringify(data, null, 2));
    replace(sealed);
  };
  const replace = (sealed: Uint8Array) => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    privateFolder();
    const tmp = `${path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    let created = false;
    try {
      // O_EXCL is the numeric equivalent of wx; O_NOFOLLOW also forbids a symlink.
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        writeFileSync(fd, sealed);
        // Node's permission model disables fsync even for permitted descriptors.
        if (!process.permission) fsyncSync(fd);
      }
      finally { closeSync(fd); }
      renameSync(tmp, path);
      // Windows does not support opening directories for fsync through this API.
      if (!process.permission && process.platform !== 'win32') {
        const dir = openSync(folder, constants.O_RDONLY);
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
    } finally { if (created) try { unlinkSync(tmp); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
  };
  // Processes sharing this path take turns through one lock file naming its holder (pid and a random tag); the holder
  // touches it while it works. A waiter that finds the holder dead, or the file untouched for a while (a reused pid),
  // claims `<lock>.<tag>` first, so exactly one waiter removes that lock.
  const lockFile = `${path}.lock`;
  /** Creates `file` already holding `text`, or returns false when it exists. */
  const exclusive = (file: string, text: string) => {
    const tmp = `${file}.${randomBytes(12).toString('hex')}.tmp`;
    writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    try { linkSync(tmp, file); return true; }
    catch (e: any) { if (e?.code === 'EEXIST') return false; throw e; }
    finally { try { unlinkSync(tmp); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === 'EPERM'; } };
  const fresh = () => { try { return Date.now() - statSync(lockFile).mtimeMs < 30_000; } catch { return true; } };
  const lock = async <T>(fn: () => Promise<T>): Promise<T> => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    privateFolder();
    const mine = `${process.pid} ${randomBytes(12).toString('hex')}`;
    while (!exclusive(lockFile, mine)) {
      let holder: string;
      try { holder = readFileSync(lockFile, 'utf8'); } catch (e: any) { if (e?.code === 'ENOENT') continue; throw e; }
      const [pid, tag] = holder.split(' ');
      // ponytail: a waiter that dies between claiming and removing a dead holder's lock leaves both for a person to delete.
      if ((!alive(Number(pid)) || !fresh()) && exclusive(`${lockFile}.${tag}`, mine)) {
        try { if (readFileSync(lockFile, 'utf8') === holder) unlinkSync(lockFile); }
        catch (e: any) { if (e?.code !== 'ENOENT') throw e; }
        finally { try { unlinkSync(`${lockFile}.${tag}`); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
      } else await new Promise((r) => setTimeout(r, 20));
    }
    const touch = setInterval(() => { try { const now = new Date(); utimesSync(lockFile, now, now); } catch {} }, 5_000);
    touch.unref();
    try { return await fn(); } finally { clearInterval(touch); try { if (readFileSync(lockFile, 'utf8') === mine) unlinkSync(lockFile); } catch (e: any) { if (e?.code !== 'ENOENT') throw e; } }
  };
  return recordStore(load, save, lock);
}
