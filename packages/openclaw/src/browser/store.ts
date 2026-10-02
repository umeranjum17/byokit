// Host-only durable state. One kit owns stateDir; host serializes every mutation across members.
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { NeedSignIn } from '../browser.ts';
import type { Member } from '../types.ts';

export type SignInData = {
  v: 1;
  requests: NeedSignIn[];
  host: Record<string, { checkUrl: string; confirmed: string[] }>;
  verified: Record<Member, string[]>;
};
export interface SignInStore {
  read(): SignInData;
  write(data: SignInData): void;
}
export const emptySignIns = (): SignInData => ({ v: 1, requests: [], host: {}, verified: {} });
export class BrowserStoreError extends Error {
  constructor() { super('browser state unavailable'); }
}
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function validOrigin(value: string): string {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || value !== u.origin) throw 0;
    return u.origin;
  } catch { throw new BrowserStoreError(); }
}
export function checkUrl(value: string): string {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw 0;
    // No credential-bearing fragments or URL parameters in durable host state.
    if (u.hash || [...u.searchParams.keys()].some(k => /password|passwd|secret|token|code|authorization/i.test(k))) throw 0;
    return u.href;
  } catch { throw new BrowserStoreError(); }
}
export function validateSignIns(value: unknown): SignInData {
  try {
    if (!object(value) || value.v !== 1 || !Array.isArray(value.requests) || !object(value.host) || !object(value.verified)
      || Object.keys(value).some(k => !['v', 'requests', 'host', 'verified'].includes(k))) throw 0;
    const ids = new Set<string>();
    const active = new Set<string>();
    for (const r of value.requests) {
      if (!object(r) || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(r.id) || ids.has(r.id)
        || typeof r.member !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(r.member) || !integer(r.gen) || r.gen < 1
        || typeof r.sessionKey !== 'string' || !r.sessionKey || typeof r.origin !== 'string' || typeof r.site !== 'string'
        || typeof r.secure !== 'boolean' || typeof r.firstTime !== 'boolean' || !integer(r.at) || !integer(r.expires)
        || !strings(r.reasons) || !strings(r.hints) || !Array.isArray(r.choices)
        || !['waiting', 'held', 'checking', 'parked', 'settled'].includes(String(r.state))) throw 0;
      validOrigin(r.origin);
      if (r.state === 'settled') {
        if (!object(r.settled) || !['verified', 'entered-unverified', 'cancelled', 'expired', 'failed'].includes(String(r.settled.state))
          || !integer(r.settled.at)) throw 0;
        const resume = r.settled.resume;
        if (resume !== undefined && (!object(resume) || r.settled.state !== 'verified' || !integer(resume.attempt) || resume.attempt < 1
          || typeof resume.key !== 'string' || !resume.key.startsWith(`signin:${r.id}:resume:${resume.attempt}:`)
          || !['pending', 'accepted', 'submitted', 'indeterminate', 'failed'].includes(String(resume.state)))) throw 0;
      } else {
        if (r.settled !== undefined || active.has(r.member)) throw 0;
        active.add(r.member);
      }
      ids.add(r.id);
      const h = value.host[r.id];
      if (!object(h) || typeof h.checkUrl !== 'string' || !strings(h.confirmed)) throw 0;
      checkUrl(h.checkUrl);
      h.confirmed.forEach(validOrigin);
    }
    if (Object.keys(value.host).some(id => !ids.has(id))) throw 0;
    for (const [member, sites] of Object.entries(value.verified)) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(member) || !strings(sites)) throw 0;
    }
    return structuredClone(value) as SignInData;
  } catch { throw new BrowserStoreError(); }
}

export function fileSignInStore(stateDir: string, io: { sync?: (fd: number) => void } = {}): SignInStore {
  const dir = join(stateDir, 'browser');
  const file = join(dir, 'signins.json');
  let failed = false;
  const sync = io.sync ?? fsyncSync;
  const guard = () => { if (failed) throw new BrowserStoreError(); };
  return {
    read() {
      guard();
      try {
        if (!existsSync(file)) return emptySignIns();
        if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink() || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw 0;
        chmodSync(file, 0o600);
        return validateSignIns(JSON.parse(readFileSync(file, 'utf8')));
      } catch { failed = true; throw new BrowserStoreError(); }
    },
    write(data) {
      guard();
      const tmp = join(dir, `.signins-${randomUUID()}`);
      try {
        const safe = validateSignIns(data);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw 0;
        chmodSync(dir, 0o700);
        writeFileSync(tmp, JSON.stringify(safe), { flag: 'wx', mode: 0o600 });
        const fd = openSync(tmp, 'r');
        try { sync(fd); } finally { closeSync(fd); }
        renameSync(tmp, file);
        // A failed directory fsync is ambiguous: poison this store, never dispatch or unfence.
        const directory = openSync(dir, 'r');
        try { sync(directory); } finally { closeSync(directory); }
      } catch { failed = true; throw new BrowserStoreError(); }
      finally { rmSync(tmp, { force: true }); }
    },
  };
}
