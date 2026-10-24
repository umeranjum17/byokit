import { statSync } from 'node:fs';
import { join } from 'node:path';
import { signedInProviders, USABLE } from './runs.ts';
import type { Detection, Detector } from './detect.ts';
import type { GatewayTransport } from './types.ts';

export type AuthStatus = { providers?: (string | {
  provider?: unknown; status?: unknown; profiles?: { profileId?: unknown; status?: unknown; expiresAt?: unknown }[]; usage?: unknown;
})[]; unavailable?: { message?: unknown };
  /** Providers whose sign-in the kit could not check (the native Claude Code probe failed or timed out). They are neither
   *  signed in nor signed out: nothing is listed for them, and a reader must not read that absence as a sign-out. */
  unknown?: string[] };

/** How long a failed native probe is retried: past the engine's own 10 s probe window, so a slow `claude auth status`
 *  gets a second full chance before the answer is given up as unknown. */
export const PROBE_WINDOW_MS = 12_000;
const PROBE_GAP_MS = 1_000;

/** The native Claude Code probe, retried (fresh, never the cached failure) until the window has passed and at least two
 *  attempts ran. Undefined is unknown: a thrown or timed-out probe is never an answer about the login. */
export async function probe(
  request: GatewayTransport['request'], agentId: string, detect?: Detector, o?: { windowMs?: number; gapMs?: number },
): Promise<Detection | undefined> {
  const start = Date.now();
  for (let attempt = 1; ; attempt++) {
    try { return await detection(request, agentId, detect, { fresh: attempt > 1 }); } catch { /* retried below */ }
    if (attempt >= 2 && Date.now() - start >= (o?.windowMs ?? PROBE_WINDOW_MS)) return undefined;
    await new Promise((resolve) => setTimeout(resolve, o?.gapMs ?? PROBE_GAP_MS));
  }
}

/** The engine's setup detection, through the shared detector when the caller has one: one probe per agent, reused
 * briefly, so a poll that reads readiness and the account list does not pay for the probe twice. A failed probe reads
 * as no detection: the caller decides what an unknown answer means (admission: unknown, never signed out). */
export const detection = async (
  request: GatewayTransport['request'], agentId: string, detect?: Detector,
  o?: { fresh?: boolean; signal?: AbortSignal; timeoutMs?: number },
): Promise<Detection> => {
  if (detect) return detect.detect(agentId, { fresh: o?.fresh, timeoutMs: o?.timeoutMs, ...(o?.signal ? { signal: o.signal } : {}) });
  return await request('openclaw.setup.detect', { agentId },
    { timeoutMs: o?.timeoutMs ?? 20_000, ...(o?.signal ? { signal: o.signal } : {}) }) as Detection;
};

/** Native Claude login stays in Claude Code. The pin's profile status does not include this synthetic auth;
 * setup detection asks the CLI itself, without handing credentials to the kit. The detection and the pin's own status
 * are independent reads, so they run together rather than one after the other. */
export async function authStatus(
  request: GatewayTransport['request'], agentId: string, refresh = false, native = false, detect?: Detector,
): Promise<AuthStatus> {
  const [status, detected] = await Promise.all([
    request('models.authStatus', { agentId, ...(refresh ? { refresh: true } : {}) }, { timeoutMs: 20_000 }) as Promise<AuthStatus>,
    native ? probe(request, agentId, detect) : undefined,
  ]);
  return native ? nativeStatus(status, detected) : status;
}

function nativeStatus(status: AuthStatus, detected: Detection | undefined): AuthStatus {
  if (detected === undefined) return { ...status, providers: (status.providers ?? []).filter((row) => (typeof row === 'string' ? row : row.provider) !== 'claude-cli'),
    unknown: [...status.unknown ?? [], 'claude-cli'] };
  const rows = (status.providers ?? []).filter((row) => (typeof row === 'string' ? row : row.provider) !== 'claude-cli');
  if (detected?.candidates?.some((candidate) => candidate.kind === 'claude-cli' && candidate.credentials === true)) {
    return { providers: [...rows, { provider: 'claude-cli', status: 'ok' }] };
  }
  return { ...status, providers: rows };
}

/** Admission snapshots, never credentials: per kit/agent/native route, at most 30s and never past reported expiry.
 * Witness only app-owned file metadata (absence included); changed/unreadable state and auth/lifecycle mutations recheck.
 * Remote revocation still comes from the real run's signed-out error (a local status read cannot prove it either).
 */
export function createAuthStatus(root: string, request: GatewayTransport['request'], codex?: () => Promise<boolean>,
  detect?: Detector) {
  const snapshots = new Map<string, { status: AuthStatus; until: number; witness: string }>();
  const witnesses = new Map<string, string>();
  let generation = 0;
  const invalidate = () => { generation++; snapshots.clear(); };
  const witness = (agentId: string): string | undefined => {
    try {
      return ['openclaw.json', `state/agents/${agentId}/agent/auth-profiles.json`,
        'state/auth-profiles.json', 'state/agents/main/agent/auth-profiles.json',
        'home/.claude/.credentials.json', 'home/.claude/.claude.json', 'home/.claude/settings.json',
        'home/.claude.json', 'home/.codex/auth.json'].map(path => {
        try {
          const s = statSync(join(root, path), { bigint: true });
          return `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
          throw error;
        }
      }).join('|');
    } catch { return undefined; } // unreadable witnesses never authorize reuse
  };
  const read = async (agentId: string, refresh = false, native = false, reuse = true): Promise<AuthStatus> => {
    const now = Date.now(), key = `${agentId}:${native}`, before = witness(agentId), epoch = generation;
    for (const [key, snapshot] of snapshots) if (snapshot.until <= now) snapshots.delete(key);
    const cached = snapshots.get(key);
    if (reuse && !refresh && before !== undefined && cached?.witness === before && cached.until > now) return cached.status;
    snapshots.delete(key);
    snapshots.delete(`${agentId}:false`);
    // The detection answers about the same state this witness covers (the engine's own logins), so a changed witness
    // drops it: the next reader asks the engine again instead of reading an earlier answer.
    const seen = witnesses.get(agentId);
    if (before !== undefined) witnesses.set(agentId, before);
    if (before !== undefined && seen !== undefined && seen !== before) detect?.invalidate(agentId);
    // The pin's own status and the setup detection are independent reads: they run together, not one after the other.
    const [profiles, detected] = await Promise.all([
      authStatus(request, agentId, refresh),
      native ? probe(request, agentId, detect) : undefined,
    ]);
    if (codex) {
      profiles.providers = (profiles.providers ?? []).filter(row => (typeof row === 'string' ? row : row.provider) !== 'openai-codex');
      if (await codex()) profiles.providers.push({ provider: 'openai-codex', status: 'ok' });
    }
    const status = native ? nativeStatus(profiles, detected) : profiles;
    // An unknown answer is never kept: the next reader asks again.
    if (before !== undefined && epoch === generation && witness(agentId) === before && !status.unknown?.length) {
      for (const [route, answer] of (native ? [[false, profiles], [true, status]] : [[false, profiles]]) as [boolean, AuthStatus][]) {
        const usable = signedInProviders(answer);
        if (!usable?.length || (route && !usable.includes('claude-cli'))) continue;
        let until = now + 30_000;
        for (const row of answer.providers ?? []) if (typeof row !== 'string') for (const p of row.profiles ?? [])
          if (USABLE.has(String(p?.status)) && typeof p.expiresAt === 'number' && Number.isFinite(p.expiresAt))
            until = Math.min(until, p.expiresAt);
        if (until > Date.now()) snapshots.set(`${agentId}:${route}`, { status: answer, until, witness: before });
      }
    }
    return status;
  };
  return { read, invalidate };
}
