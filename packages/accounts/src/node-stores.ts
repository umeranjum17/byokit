// Desktop stores: sealed with a host-supplied adapter, such as Electron's safeStorage.
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { recordStore, type EndingStore } from './stores.ts';

/** Pass Electron's safeStorage from the main process after ready, or an equivalent trusted sealing adapter.
 * Adapters without capability methods are responsible for ensuring their key is protected. */
export type SafeStorageLike = {
  encryptString(text: string): Uint8Array;
  decryptString(data: Buffer): string;
  isEncryptionAvailable?(): boolean;
  getSelectedStorageBackend?(): string;
};

/** One person's sealed sign-ins in an app-owned 0600 file inside a private 0700 folder.
 * No plaintext fallback. Writes are serialized per store instance; use one instance per path and a host lock
 * if multiple processes share it. The host owns the adapter and its key, separately from this file. */
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
      return JSON.parse(safeStorage.decryptString(readFileSync(fd)));
    } finally { closeSync(fd); }
  };
  const save = async (data: object) => {
    ready();
    const sealed = safeStorage.encryptString(JSON.stringify(data, null, 2));
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
  return recordStore(load, save);
}
