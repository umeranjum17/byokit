// Credential stores behind Pi's own CredentialStore seam: one per person, never a shared fallback.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { InMemoryCredentialStore, type Credential, type CredentialStore } from '@earendil-works/pi-ai';

export const memoryStore = (): CredentialStore => new InMemoryCredentialStore();

/** One person's sign-ins in a JSON file the app chooses (0600, in a 0700 folder), in the same shape as Pi's auth.json.
 *  ponytail: writes are serialized within this process only; add a file lock if two processes ever share one file. */
export function fileStore(path: string): CredentialStore {
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = chain.then(fn); chain = r.catch(() => {}); return r; };
  const load = (): Record<string, Credential> => {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e: any) { if (e?.code === 'ENOENT') return {}; throw e; }
  };
  const save = (data: Record<string, Credential>) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  };
  return {
    read: async (id) => load()[id],
    list: async () => Object.entries(load()).map(([providerId, c]) => ({ providerId, type: c.type })),
    modify: (id, fn) => serial(async () => {
      const current = load()[id];
      const next = await fn(current);
      if (next === undefined) return current;
      save({ ...load(), [id]: next }); // re-read: a sign-in can take minutes, and other providers may have changed meanwhile
      return next;
    }),
    delete: (id) => serial(async () => { const data = load(); if (id in data) { delete data[id]; save(data); } }),
  };
}
