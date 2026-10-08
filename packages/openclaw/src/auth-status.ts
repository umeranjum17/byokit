import { statSync } from 'node:fs';
import { join } from 'node:path';
import { signedInProviders, USABLE } from './runs.ts';
import type { GatewayTransport } from './types.ts';

export type AuthStatus = { providers?: (string | {
  provider?: unknown; status?: unknown; profiles?: { status?: unknown; expiresAt?: unknown }[]; usage?: unknown;
})[]; unavailable?: { message?: unknown } };

/** Native Claude login stays in Claude Code. The pin's profile status does not include this synthetic auth;
 * setup detection asks the CLI itself, without handing credentials to the kit. */
export async function authStatus(
  request: GatewayTransport['request'], agentId: string, refresh = false, native = false,
): Promise<AuthStatus> {
  const status = await request('models.authStatus', { agentId, ...(refresh ? { refresh: true } : {}) },
    { timeoutMs: 20_000 }) as AuthStatus;
  return native ? nativeStatus(request, agentId, status) : status;
}

async function nativeStatus(request: GatewayTransport['request'], agentId: string, status: AuthStatus): Promise<AuthStatus> {
  const detected = await request('openclaw.setup.detect', { agentId }, { timeoutMs: 20_000 }).catch(() => ({})) as {
    candidates?: { kind?: string; credentials?: boolean }[];
  };
  const rows = (status.providers ?? []).filter((row) => (typeof row === 'string' ? row : row.provider) !== 'claude-cli');
  if (detected.candidates?.some((candidate) => candidate.kind === 'claude-cli' && candidate.credentials === true)) {
    return { providers: [...rows, { provider: 'claude-cli', status: 'ok' }] };
  }
  return { ...status, providers: rows };
}

/** Admission snapshots, never credentials: per kit/agent/native route, at most 30s and never past reported expiry.
 * Witness only app-owned file metadata (absence included); changed/unreadable state and auth/lifecycle mutations recheck.
 * Remote revocation still comes from the real run's signed-out error (a local status read cannot prove it either).
 */
export function createAuthStatus(root: string, request: GatewayTransport['request']) {
  const snapshots = new Map<string, { status: AuthStatus; until: number; witness: string }>();
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
    const profiles = await authStatus(request, agentId, refresh);
    const status = native ? await nativeStatus(request, agentId, profiles) : profiles;
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
