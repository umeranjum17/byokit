// The one typed activation path for sign-in and key add. An ok activation that changes config `auth` makes the pin
// restart the gateway once in-flight requests drain; `restarted` resolves once that restart is done, and the caller
// seals only after it. A late restart is `late`: the engine accepted the key, so the caller cleans up and says retry.
import type { GatewayParams, GatewayTransport } from './types.ts';

export type ActivationCtx = {
  request: GatewayTransport['request'];
  // The engine's config `auth` as text, read before an activation; a changed one is the restart the kit waits out.
  authConfig(): string;
  // True once that restart has begun and the kit is ready again; false on failure, timeout or abort.
  restarted(authBefore: string | undefined, signal?: AbortSignal): Promise<boolean>;
};

export const LATE_RESTART = 'The engine took too long to restart after this sign-in. Nothing was kept; try again.';

export type Activation = { ok: boolean; late?: boolean; status?: string; error?: string };

export async function activate(ctx: ActivationCtx, params: GatewayParams<'openclaw.setup.activate'>,
  o: { timeoutMs: number; signal?: AbortSignal }): Promise<Activation> {
  const authBefore = ctx.authConfig();
  const result = await ctx.request('openclaw.setup.activate', params, { timeoutMs: o.timeoutMs, signal: o.signal }) as
    { ok?: boolean; status?: string; error?: string };
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  return await ctx.restarted(authBefore, o.signal) ? { ok: true } : { ok: false, late: true };
}
