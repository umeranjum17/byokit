// Retained-login migration (D15, 5.7): stage a Pi auth.json-shaped record into the engine's own store, then confirm
// only when the Gateway itself reports every provider signed in.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { providers } from './signin.ts';
import type { RetainedLogin } from './kit.ts';
import type { SignInCtx } from './signin.ts';
import type { Member } from './types.ts';

export type DoctorRunner = () => { status: number | null };

const MOVED = '.moved-to-engine';
const MARKER = '.canonicalized';
const TRY_MS = 1_500;
const TRIES = 3;

/** The file to import from (D15): the path itself, else the retired copy while it is still unconfirmed. */
function sourceFile(source: RetainedLogin): string | undefined {
  if (!('path' in source)) return undefined;
  if (existsSync(source.path)) return source.path;
  const moved = source.path + MOVED;
  return existsSync(moved) && !existsSync(moved + MARKER) ? moved : undefined;
}

/** The old sign-in's plain `{ '<provider>': credential }` map, or undefined when it is absent or unreadable. */
function credentials(source: RetainedLogin, path: string | undefined): Record<string, unknown> | undefined {
  try {
    const raw = 'record' in source ? source.record : JSON.parse(readFileSync(path as string, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

/** The engine's own provider ids for what the old sign-in holds; `openai-codex` is `openai` (D15). */
function wantedProviders(legacy: Record<string, unknown>): string[] {
  const names = Object.entries(legacy).map(([key, credential]) => {
    if (key === 'openai-codex') return 'openai';
    const own = credential && typeof credential === 'object' ? (credential as { provider?: unknown }).provider : undefined;
    return typeof own === 'string' && own !== '' ? own : key.toLowerCase();
  });
  return [...new Set(names)];
}

/**
 * Stage before `start()` (an import while a Gateway owns the state is exactly how a preserved sign-in is lost):
 * `prepare()` first, then the member's `auth-profiles.json` (0600), then one offline doctor run. The original file
 * is never written to: a failed run only clears the staging, so the next boot stages it again byte for byte.
 */
export async function migrateRetainedLogin(
  ctx: { root: string; prepare(): Promise<void>; doctor: DoctorRunner },
  member: Member,
  source: RetainedLogin,
): Promise<'staged' | 'nothing' | 'failed'> {
  const path = sourceFile(source);
  if ('path' in source && !path) return 'nothing';
  const legacy = credentials(source, path);
  if (!legacy || !Object.keys(legacy).length) return 'nothing'; // never migrate an empty source
  // A retired copy without the one provider the engine's canonicalization exists for is not worth importing.
  if (path?.endsWith(MOVED) && !('openai-codex' in legacy)) return 'nothing';
  await ctx.prepare();
  const agentDir = join(ctx.root, 'state', 'agents', member, 'agent');
  const staged = join(agentDir, 'auth-profiles.json');
  if (!existsSync(staged)) {
    // Doctor canonicalizes legacy provider ids before importing; staging `auth.json` instead keeps the old id,
    // which looks signed in but cannot authenticate `openai/*` turns.
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(staged, JSON.stringify({ version: 1, profiles: Object.fromEntries(
      Object.entries(legacy).map(([provider, credential]) => [`${provider}:default`, credential])) }), { mode: 0o600 });
  }
  // The doctor's exit is a weak yes (it exits 0 even when it imports nothing), so a failed run only clears the
  // staging; retiring the original stays confirm's job.
  if (ctx.doctor().status !== 0) {
    rmSync(staged, { force: true });
    return 'failed';
  }
  return 'staged';
}

/**
 * After `ready`: the migration counts only when the Gateway itself reports every provider signed in. Only then does
 * a path source move aside (a rename, so the original bytes survive whole) — anything else leaves the sign-in where
 * it was and the next boot retries it without asking the person to sign in again.
 */
export async function confirmRetainedLogin(ctx: SignInCtx, member: Member, source: RetainedLogin): Promise<boolean> {
  const original = 'path' in source ? source.path : undefined;
  const path = sourceFile(source);
  if (original && !path) return false;
  const legacy = credentials(source, path);
  if (!legacy) return false;
  const wanted = wantedProviders(legacy);
  if (!wanted.length) return false; // nothing recognizable to verify: never retire on a guess
  try {
    for (let tries = 0; tries < TRIES; tries++) {
      const have = await providers(ctx, member, true);
      if (wanted.every((provider) => have.includes(provider))) {
        if (path && path === original) renameSync(path, path + MOVED);
        if (original) writeFileSync(original + MOVED + MARKER, '', { mode: 0o600 });
        return true; // a record source moves nothing: the app deletes its own copy
      }
      if (tries < TRIES - 1) await new Promise((resume) => setTimeout(resume, TRY_MS));
    }
  } catch { /* the engine is down or the file unreadable: the original stays */ }
  return false;
}
