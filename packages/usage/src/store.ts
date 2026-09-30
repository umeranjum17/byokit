import { createHash, randomUUID, scryptSync } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { join } from 'node:path';
import { record } from './windows.ts';
import type { Provider } from './types.ts';
export interface Stored { at: number; raw: unknown }
type Plans = Partial<Record<Provider, Record<string, Stored>>>;
/** Bounded regular files only; do not follow credential or state symlinks. */
export function readJson(file: string, cap: number): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > cap) return undefined;
    const body = Buffer.alloc(cap + 1);
    let length = 0;
    while (length <= cap) {
      const count = readSync(fd, body, length, cap + 1 - length, null);
      if (!count) break;
      length += count;
    }
    return length <= cap ? JSON.parse(body.subarray(0, length).toString('utf8')) : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
export function fingerprint(salt: string) {
  const memo = new Map<string, string>();
  return (provider: Provider, value: string): string => {
    const key = createHash('sha256').update(`${provider}\0${value}`).digest('hex');
    let fp = memo.get(key);
    if (!fp) {
      fp = scryptSync(value, `${salt}/${provider}`, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
      if (memo.size >= 32) memo.clear();
      memo.set(key, fp);
    }
    return fp;
  };
}
export function store(stateDir: string) {
  const path = join(stateDir, 'plans-v1.json');
  function load(): Plans {
    const saved = readJson(path, 256 * 1024); const plans: Plans = {};
    if (!record(saved) || !record(saved.plans)) return plans;
    for (const id of ['claude', 'codex', 'opencode', 'zai'] as const) {
      const entries = saved.plans[id]; if (!record(entries)) continue;
      const readings: Record<string, Stored> = Object.create(null) as Record<string, Stored>;
      for (const [fp, r] of Object.entries(entries)) {
        if (/^[a-f0-9]{64}$/.test(fp) && record(r) && typeof r.at === 'number' && Number.isFinite(r.at)) readings[fp] = { at: r.at, raw: r.raw };
      }
      plans[id] = readings;
    }
    return plans;
  }
  return {
    get: (id: Provider, fp: string): Stored | undefined => load()[id]?.[fp],
    put(id: Provider, fp: string, reading: Stored): void {
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const plans = load(); const entries = plans[id] ?? {};
        if (reading.at < (entries[fp]?.at ?? -Infinity)) return;
        entries[fp] = reading; plans[id] = entries;
        const body = JSON.stringify({ plans }); if (Buffer.byteLength(body) > 256 * 1024) return;
        mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
        writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
      } catch { /* Persistence failure never exposes provider data as an error. */ }
      finally { try { unlinkSync(temporary); } catch { /* already renamed or never created */ } }
    },
  };
}
