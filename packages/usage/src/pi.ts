import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './store.ts';
import { record } from './windows.ts';
import { codexTokenWindows, kimiWindows } from './quota.ts';
import { providerGet, type Answer } from './providers.ts';
import { managedProviderFolder } from './claude.ts';
import type { PiProvider, Source, Window } from './types.ts';

type PiSource = Extract<Source, { provider: 'pi'; folder: string; piProvider: PiProvider }>;
const AUTH_FILE = 'auth.json';
const MAX_BYTES = 64 * 1024;
/** The plan each Pi provider id reads: ChatGPT's Codex windows or Kimi's. */
const FAMILY: Record<PiProvider, 'codex' | 'kimi'> = { 'openai-codex': 'codex', 'kimi-coding': 'kimi' };

/** The managed Pi folder is the account's `PI_CODING_AGENT_DIR`, holding `auth.json`. */
export function managedPiFolder(folder: string, stateDir: string): boolean {
  return managedProviderFolder(folder, stateDir, 'pi');
}
/** Metadata only, so account/cache probes never load a token. */
export function piCredential(folder: string) {
  try {
    const stat = lstatSync(join(folder, AUTH_FILE));
    return stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES ? stat : undefined;
  } catch { return undefined; }
}
/** ChatGPT's account id from the access token's own claims, the same claim Pi's sign-in flow reads. */
function chatgptAccountId(access: string): string | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(access.split('.')[1] ?? '', 'base64url').toString('utf8'));
    const auth = record(claims) ? claims['https://api.openai.com/auth'] : undefined;
    const id = record(auth) ? auth.chatgpt_account_id : undefined;
    return typeof id === 'string' && id && id.length <= 16384 ? id : undefined;
  } catch { return undefined; }
}
/** The credential for one Pi provider id, held only for this request; no refresh, writes or recovery sidecars. */
function piToken(folder: string, piProvider: PiProvider): { access: string; accountId?: string } | undefined {
  const raw = readJson(join(folder, AUTH_FILE), MAX_BYTES);
  if (!record(raw)) return undefined;
  const credential = raw[piProvider];
  if (!record(credential) || credential.type !== 'oauth') return undefined;
  const access = credential.access;
  if (typeof access !== 'string') return undefined;
  const trimmed = access.trim();
  if (!trimmed || trimmed.length > 16384 || /[\x00-\x20\x7f]/.test(trimmed)) return undefined;
  if (FAMILY[piProvider] !== 'codex') return { access: trimmed };
  // Codex's route names the ChatGPT account; the stored id stands, and the claim backs it up.
  const accountId = typeof credential.accountId === 'string' && credential.accountId ? credential.accountId : chatgptAccountId(trimmed);
  return accountId === undefined ? { access: trimmed } : { access: trimmed, accountId };
}
/** The Pi provider id decides which plan the folder login reads: ChatGPT's Codex windows or Kimi's. */
export function piWindows(source: PiSource, raw: unknown, nowMs: number): Window[] {
  return FAMILY[source.piProvider] === 'kimi' ? kimiWindows(raw, nowMs) : codexTokenWindows(raw, nowMs);
}
/** The Pi provider id decides which plan the folder login reads through a BYOKit-owned route. */
export async function piUsage(source: PiSource, fetcher: typeof fetch, nowMs: number, pacing?: Parameters<typeof providerGet>[3]): Promise<Answer> {
  const credential = piToken(source.folder, source.piProvider);
  if (!credential) return { code: 'not-connected' };
  if (FAMILY[source.piProvider] === 'kimi') return providerGet({ provider: 'kimi', access: credential.access }, fetcher, nowMs, pacing);
  // Without the account id Codex's route cannot be addressed, so the room stays unknown, never zero.
  if (credential.accountId === undefined) return { code: 'unavailable' };
  return providerGet({ provider: 'codex', access: credential.access, accountId: credential.accountId }, fetcher, nowMs, pacing);
}
