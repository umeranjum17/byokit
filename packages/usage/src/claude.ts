import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { readJson } from './store.ts';
import { record } from './windows.ts';
import { providerHttp, type Answer } from './providers.ts';
import type { Source } from './types.ts';

type ClaudeSource = Extract<Source, { folder: string }>;
const DEFAULT_LOGIN_SEGMENTS = ['.claude', '.codex', '.pi'];
/** True when a path sits inside one of the person's own agent setups, lexically or once links are resolved. */
export function defaultLoginPath(path: string): boolean {
  if (resolve(path).split(sep).some((part) => DEFAULT_LOGIN_SEGMENTS.includes(part))) return true;
  try { return realpathSync(path).split(sep).some((part) => DEFAULT_LOGIN_SEGMENTS.includes(part)); } catch { return false; }
}
/** No ambient HOME discovery. Both the lexical and real folder must be managed by this root. */
export function managedClaudeFolder(folder: string, stateDir: string): boolean {
  const root = resolve(stateDir); const candidate = resolve(folder);
  if (defaultLoginPath(root)) return false;
  const parent = join(root, 'claude');
  if (!candidate.startsWith(parent + sep) || !/^[a-f0-9]+$/.test(candidate.slice(parent.length + 1))) return false;
  try {
    if (![root, parent, candidate].every((path) => { const s = lstatSync(path); return s.isDirectory() && !s.isSymbolicLink(); })) return false;
    const realRoot = realpathSync(root);
    if (defaultLoginPath(realRoot)) return false;
    const realFolder = realpathSync(candidate);
    return realFolder.startsWith(join(realRoot, 'claude') + sep);
  } catch { return false; }
}
/** Metadata only, so account/cache probes never load a token. */
export function claudeCredential(folder: string) {
  try {
    const stat = lstatSync(join(folder, '.credentials.json'));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= 64 * 1024 ? stat : undefined;
  } catch { return undefined; }
}
/** The credential is held only for this request; no refresh, writes or recovery sidecars. */
export async function claudeUsage(source: ClaudeSource, fetcher: typeof fetch, nowMs: number, pacing?: Parameters<typeof providerHttp>[5]): Promise<Answer> {
  const raw = readJson(join(source.folder, '.credentials.json'), 64 * 1024);
  const oauth = record(raw) && record(raw.claudeAiOauth) ? raw.claudeAiOauth : undefined;
  if (!oauth || typeof oauth.accessToken !== 'string' || !oauth.accessToken.trim() || oauth.accessToken.length > 16384 || /[\x00-\x20\x7f]/.test(oauth.accessToken)) return { code: 'not-connected' };
  if (typeof oauth.expiresAt !== 'number' || !Number.isFinite(oauth.expiresAt) || oauth.expiresAt <= nowMs) return { code: 'expired' };
  return providerHttp('https://api.anthropic.com/api/oauth/usage', oauth.accessToken, fetcher, nowMs, { headers: { 'anthropic-beta': source.headers['anthropic-beta'], 'User-Agent': source.headers['User-Agent'] } }, pacing);
}
