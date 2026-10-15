import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './store.ts';
import { record } from './windows.ts';
import { providerHttp, type Answer } from './providers.ts';
import { managedProviderFolder } from './claude.ts';
import type { Source } from './types.ts';

type CursorSource = Extract<Source, { provider: 'cursor'; folder: string }>;
const PERIOD_USAGE = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';

/** The managed Cursor folder is the account's XDG_CONFIG_HOME, holding `cursor/auth.json`. */
export function managedCursorFolder(folder: string, stateDir: string): boolean {
  return managedProviderFolder(folder, stateDir, 'cursor');
}
/** Metadata only, so account/cache probes never load a token. */
export function cursorCredential(folder: string) {
  try {
    const stat = lstatSync(join(folder, 'cursor', 'auth.json'));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 ? stat : undefined;
  } catch { return undefined; }
}
/** The credential is held only for this request; no refresh, writes or recovery sidecars. */
export function cursorToken(folder: string): string | undefined {
  const raw = readJson(join(folder, 'cursor', 'auth.json'), 64 * 1024);
  if (!record(raw)) return undefined;
  const token = [raw.accessToken, raw.access_token, raw.token].find((v): v is string => typeof v === 'string');
  if (token === undefined) return undefined;
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 16384 || /[\x00-\x20\x7f]/.test(trimmed)) return undefined;
  return trimmed;
}
/** The same current-period window the dashboard reads, with the folder's own login. */
export async function cursorUsage(source: CursorSource, fetcher: typeof fetch, nowMs: number, pacing?: Parameters<typeof providerHttp>[5]): Promise<Answer> {
  const token = cursorToken(source.folder);
  if (!token) return { code: 'not-connected' };
  return providerHttp(PERIOD_USAGE, token, fetcher, nowMs, { headers: { 'Connect-Protocol-Version': '1' }, body: {} }, pacing);
}
