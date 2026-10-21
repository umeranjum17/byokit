import { statSync } from 'node:fs';
import { join } from 'node:path';
import { signedInProviders, USABLE } from './runs.ts';
import type { Detection, Detector } from './detect.ts';
import type { GatewayTransport } from './types.ts';

export type AuthStatus = { providers?: (string | {
  provider?: unknown; status?: unknown; profiles?: { profileId?: unknown; status?: unknown; expiresAt?: unknown }[]; usage?: unknown;
})[]; unavailable?: { message?: unknown } };

/** The engine's setup detection, through the shared detector when the caller has one: one probe per agent, reused
 * briefly, so a poll that reads readiness and the account list does not pay for the probe twice. A failed probe reads
 * as no detection: the caller decides what an unknown answer means. */
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
    native ? detection(request, agentId, detect).catch(() => ({})) : undefined,
  ]);
  return native ? nativeStatus(status, detected) : status;
}

function nativeStatus(status: AuthStatus, detected: Detection | undefined): AuthStatus {
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
      native ? detection(request, agentId, detect).catch(() => undefined) : undefined,
    ]);
    if (codex) {
      profiles.providers = (profiles.providers ?? []).filter(row => (typeof row === 'string' ? row : row.provider) !== 'openai-codex');
      if (await codex()) profiles.providers.push({ provider: 'openai-codex', status: 'ok' });
    }
    const status = native ? nativeStatus(profiles, detected) : profiles;
    if (before !== undefined && epoch === generation && witness(agentId) === before) {
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
