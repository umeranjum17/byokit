// Desktop stores: a file the app chooses, optionally sealed with Electron's safeStorage (the OS keychain's key).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialStore } from '@earendil-works/pi-ai';
import { recordStore } from './stores.ts';

/** The parts of Electron's `safeStorage` this uses; pass `safeStorage` from 'electron' (main process, after `ready`). */
export type SafeStorageLike = { encryptString(text: string): Uint8Array; decryptString(data: Buffer): string };

/** One person's sign-ins in a JSON file the app chooses (0600, in a 0700 folder), in the same shape as Pi's auth.json.
 *  With Electron's `safeStorage` the file is sealed with the OS keychain's key instead of plain JSON.
 *  ponytail: writes are serialized within this process only; add a file lock if two processes ever share one file. */
export function fileStore(path: string, safeStorage?: SafeStorageLike): CredentialStore {
  const load = async () => {
    try {
      const raw = readFileSync(path);
      return JSON.parse(safeStorage ? safeStorage.decryptString(raw) : raw.toString('utf8'));
    } catch (e: any) { if (e?.code === 'ENOENT') return {}; throw e; }
  };
  const save = async (data: object) => {
    const text = JSON.stringify(data, null, 2);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, safeStorage ? safeStorage.encryptString(text) : text, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  return recordStore(load, save);
}
