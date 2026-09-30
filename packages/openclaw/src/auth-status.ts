import type { GatewayTransport } from './types.ts';

export type AuthStatus = { providers?: (string | {
  provider?: unknown; status?: unknown; profiles?: { status?: unknown }[]; usage?: unknown;
})[]; unavailable?: { message?: unknown } };

/** Native Claude login stays in Claude Code. The pin's profile status does not include this synthetic auth;
 * setup detection asks the CLI itself, without handing credentials to the kit. */
export async function authStatus(
  request: GatewayTransport['request'], agentId: string, refresh = false, native = false,
): Promise<AuthStatus> {
  const status = await request('models.authStatus', { agentId, ...(refresh ? { refresh: true } : {}) },
    { timeoutMs: 20_000 }) as AuthStatus;
  if (!native) return status;
  const detected = await request('openclaw.setup.detect', { agentId }, { timeoutMs: 20_000 }).catch(() => ({})) as {
    candidates?: { kind?: string; credentials?: boolean }[];
  };
  const rows = (status.providers ?? []).filter((row) => (typeof row === 'string' ? row : row.provider) !== 'claude-cli');
  if (detected.candidates?.some((candidate) => candidate.kind === 'claude-cli' && candidate.credentials === true)) {
    return { providers: [...rows, { provider: 'claude-cli', status: 'ok' }] };
  }
  return { ...status, providers: rows };
}
