import { createHash, randomUUID, scryptSync } from 'node:crypto';
import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { UsageError } from './types.ts';
import { record } from './windows.ts';
import type { Provider, StoredReading, UsageStore, Poll } from './types.ts';
import { safeWindows } from './safe-windows.ts';
export { safeWindows } from './safe-windows.ts';
export type Stored = StoredReading;
type Plans = Partial<Record<Provider, Record<string, Stored>>>;
/** Bounded regular files only; do not follow credential or state symlinks. */
export function readJsonSnapshot(file: string, cap: number): { value: unknown; modified: number } | undefined {
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
    return length <= cap ? { value: JSON.parse(body.subarray(0, length).toString('utf8')) as unknown, modified: stat.mtimeMs } : undefined;
  } catch { return undefined; } finally { if (fd !== undefined) closeSync(fd); }
}
export function readJson(file: string, cap: number): unknown { return readJsonSnapshot(file, cap)?.value; }
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
/** Poll metadata is distinct from the observation timestamp. */
export function safePoll(raw: unknown): Poll | undefined {
  if (!record(raw) || typeof raw.at !== 'number' || !Number.isFinite(raw.at) || !['ok', 'not-connected', 'expired', 'auth', 'no-plan', 'rate-limited', 'unavailable', 'incomplete', 'refresh-failed'].includes(String(raw.outcome))) return undefined;
  return { at: raw.at, outcome: raw.outcome as Poll['outcome'], ...(typeof raw.retryAt === 'number' && Number.isFinite(raw.retryAt) ? { retryAt: raw.retryAt } : {}) };
}
export function store(stateDir: string): UsageStore {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || /[\0\r\n]/.test(stateDir)) throw new UsageError();
  const path = join(stateDir, 'plans-v2.json');
  function load(): Plans {
    const saved = readJson(path, 256 * 1024); const plans: Plans = {};
    if (!record(saved) || !record(saved.plans)) return plans;
    for (const id of ['claude', 'codex', 'opencode', 'zai', 'copilot', 'grok', 'minimax', 'gemini', 'kimi'] as const) {
      const entries = saved.plans[id]; if (!record(entries)) continue;
      const readings: Record<string, Stored> = Object.create(null) as Record<string, Stored>;
      for (const [fp, r] of Object.entries(entries)) {
        if (/^[a-f0-9]{64}$/.test(fp) && record(r) && (r.at === undefined || typeof r.at === 'number' && Number.isFinite(r.at))) readings[fp] = { ...(typeof r.at === 'number' ? { at: r.at } : {}), windows: safeWindows(id, r.windows), ...(r.limited === true ? { limited: true } : {}), ...(safePoll(r.poll) ? { poll: safePoll(r.poll) } : {}) };
      }
      plans[id] = readings;
    }
    return plans;
  }
  return {
    get: (id: Provider, fp: string): Stored | undefined => load()[id]?.[fp],
    put(id: Provider, fp: string, reading: Stored): void {
      if (!/^[a-f0-9]{64}$/.test(fp) || !Number.isFinite(reading.at)) return;
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        const plans = load(); const entries = plans[id] ?? {};
        if (reading.at !== undefined && reading.at < (entries[fp]?.at ?? -Infinity)) return;
        entries[fp] = { at: reading.at, windows: safeWindows(id, reading.windows), ...(reading.limited ? { limited: true } : {}), ...(safePoll(reading.poll) ? { poll: safePoll(reading.poll) } : {}) }; plans[id] = entries;
        const body = JSON.stringify({ plans }); if (Buffer.byteLength(body) > 256 * 1024) return;
        mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chmodSync(stateDir, 0o700);
        writeFileSync(temporary, body, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path);
      } catch { /* Persistence failure never exposes provider data as an error. */ }
      finally { try { unlinkSync(temporary); } catch { /* already renamed or never created */ } }
    },
  };
}

export function memoryUsageStore(): UsageStore {
  const readings = new Map<string, StoredReading>();
  return { get: (provider, account) => { const r = readings.get(`${provider}\0${account}`); return r ? { at: r.at, windows: safeWindows(provider, r.windows), ...(r.limited ? { limited: true } : {}), ...(safePoll(r.poll) ? { poll: safePoll(r.poll) } : {}) } : undefined; },
    put: (provider, account, reading) => { const key = `${provider}\0${account}`; if (reading.at === undefined || reading.at >= (readings.get(key)?.at ?? -Infinity)) readings.set(key, { at: reading.at, windows: safeWindows(provider, reading.windows), ...(reading.limited ? { limited: true } : {}), ...(safePoll(reading.poll) ? { poll: safePoll(reading.poll) } : {}) }); } };
}
