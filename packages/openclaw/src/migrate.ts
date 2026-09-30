// Retained-login migration (D15, 5.7): stage a Pi auth.json-shaped record into the engine's own store, then confirm
// only when the Gateway itself reports every provider signed in.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SealingAdapter } from '@byokit/secrets';
import { retireArchive } from './auth-store.ts';
import { MEMBER_ID } from './members.ts';
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
  if (existsSync(moved + MARKER)) return undefined;
  if (existsSync(moved)) return moved;
  return existsSync(moved + '.sealed') ? moved + '.sealed' : undefined;
}

/** The old sign-in's plain `{ '<provider>': credential }` map, or undefined when it is absent or unreadable. */
async function credentials(source: RetainedLogin, path: string | undefined, seal?: SealingAdapter): Promise<Record<string, unknown> | undefined> {
  let opened: Uint8Array | undefined;
  if (path?.endsWith('.sealed')) {
    if (!seal) throw new Error('authSeal required for sealed retained login');
    opened = Buffer.from(seal.decryptString(readFileSync(path)), 'base64');
  }
  try {
    const raw = 'record' in source ? source.record : JSON.parse(opened ? new TextDecoder('utf-8', { fatal: true }).decode(opened) : readFileSync(path as string, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
  } catch { return undefined; }
  finally { opened?.fill(0); }
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
  ctx: { root: string; prepare(): Promise<void>; doctor: DoctorRunner; seal?: SealingAdapter; log?: (line: string) => void;
    withStore?<T>(task: () => Promise<T>): Promise<T> },
  member: Member,
  source: RetainedLogin,
): Promise<'staged' | 'nothing' | 'failed'> {
  // The member id is the only thing between a caller and a credential write, and this runs before any transport
  // could validate it (D9).
  if (!MEMBER_ID.test(member)) throw new Error(`invalid member id: ${member}`);
  const path = sourceFile(source);
  if ('path' in source && !path) return 'nothing';
  const legacy = await credentials(source, path, ctx.seal);
  if (!legacy || !Object.keys(legacy).length) return 'nothing'; // never migrate an empty source
  // A retired copy without the one provider the engine's canonicalization exists for is not worth importing.
  if ((path?.endsWith(MOVED) || path?.endsWith(MOVED + '.sealed')) && !('openai-codex' in legacy)) return 'nothing';
  if (path?.endsWith(MOVED) && ctx.seal) await retireArchive(path, ctx.seal, ctx.log);
  await ctx.prepare();
  const stage = async (): Promise<'staged' | 'failed'> => {
    const agentDir = join(ctx.root, 'state', 'agents', member, 'agent');
    const staged = join(agentDir, 'auth-profiles.json');
    // Only a staging this call wrote may ever be removed: the file is the member's live sign-in once the engine has
    // imported it, and a failed run must not take that with it.
    const wrote = !existsSync(staged);
    if (wrote) {
      // Doctor canonicalizes legacy provider ids before importing; staging `auth.json` instead keeps the old id,
      // which looks signed in but cannot authenticate `openai/*` turns.
      mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const body = JSON.stringify({ version: 1, profiles: Object.fromEntries(
        Object.entries(legacy).map(([provider, credential]) => [`${provider}:default`, credential])) });
      // Written beside its home and renamed into place, so a reader never sees half a profile store.
      const staging = `${staged}.staging-${process.pid}`;
      writeFileSync(staging, body, { mode: 0o600 });
      renameSync(staging, staged);
    }
    // The doctor's exit is a weak yes (it exits 0 even when it imports nothing), so a failed run only clears the
    // staging; retiring the original stays confirm's job.
    if (ctx.doctor().status !== 0) {
      if (wrote) rmSync(staged, { force: true });
      return 'failed';
    }
    return 'staged';
  };
  return ctx.withStore ? ctx.withStore(stage) : stage();
}

/**
 * After `ready`: the migration counts only when the Gateway itself reports every provider signed in. Only then is
 * a path source removed without creating a plaintext archive — anything else leaves the sign-in where
 * it was and the next boot retries it without asking the person to sign in again.
 */
export async function confirmRetainedLogin(ctx: SignInCtx & { seal?: SealingAdapter; log?: (line: string) => void }, member: Member, source: RetainedLogin): Promise<boolean> {
  if (!MEMBER_ID.test(member)) throw new Error(`invalid member id: ${member}`);
  const original = 'path' in source ? source.path : undefined;
  const path = sourceFile(source);
  if (original && !path) return false;
  const legacy = await credentials(source, path, ctx.seal);
  if (!legacy) return false;
  const wanted = wantedProviders(legacy);
  if (!wanted.length) return false; // nothing recognizable to verify: never retire on a guess
  try {
    for (let tries = 0; tries < TRIES; tries++) {
      const have = await providers(ctx, member, true);
      if (wanted.every((provider) => have.includes(provider))) {
        if (original) {
          for (const file of [original, original + MOVED, original + MOVED + '.sealed']) rmSync(file, { force: true });
          writeFileSync(original + MOVED + MARKER, '', { mode: 0o600 });
          ctx.log?.('verified retained credential source removed');
        }
        return true; // a record source moves nothing: the app deletes its own copy
      }
      if (tries < TRIES - 1) await new Promise((resume) => setTimeout(resume, TRY_MS));
    }
  } catch { /* the engine is down or the file unreadable: the original stays */ }
  return false;
}
