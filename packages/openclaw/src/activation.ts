// The one typed activation path for sign-in and key add. Only the native gatewayRestartRequired flag requests
// a restart wait: 9.33 can hot-apply auth changes. A late requested restart is `late`, so the caller cleans up.
import type { GatewayParams, GatewayResult, GatewayTransport } from './types.ts';

export type ActivationCtx = {
  request: GatewayTransport['request'];
  // Called only for a native-requested restart; true once it began and the kit is ready again.
  restarted(signal?: AbortSignal): Promise<boolean>;
};

export const LATE_RESTART = 'The engine took too long to restart after this sign-in. Nothing was kept; try again.';

export type Activation = { ok: boolean; late?: boolean; status?: string; error?: string };

export async function activate(ctx: ActivationCtx, params: GatewayParams<'openclaw.setup.activate'>,
  o: { timeoutMs: number; signal?: AbortSignal }): Promise<Activation> {
  // The request is never aborted by a cancel: its answer decides whether the engine kept the key, so cleanup waits for it.
  const result = await ctx.request('openclaw.setup.activate', params, { timeoutMs: o.timeoutMs }) as GatewayResult<'openclaw.setup.activate'>;
  if (!result.ok) return { ok: false, status: result.status, error: result.error };
  if (result.gatewayRestartRequired !== true) return { ok: true };
  return await ctx.restarted(o.signal) ? { ok: true } : { ok: false, late: true };
}
