import { join } from 'node:path';
import { activate, type ActivationCtx } from './activation.ts';
import { keyAgentId, MEMBER_ID, KEY_PREFIX, untilListed } from './members.ts';
import { routes } from './routes.ts';
import { modelsOf } from './accounts.ts';
import { LIVE_CATALOGS } from './constants.ts';
import type { Member, ModelInfo } from './types.ts';

// retry: the engine may have taken the key but it was not kept; the unsealed key is cleared best-effort. If that clear
// does not reach the engine, the key stays unsealed and unusable until the next key add or kit start, and runs fail
// closed meanwhile.
export type KeyFailureReason = 'auth' | 'billing' | 'empty' | 'model' | 'network' | 'engine' | 'inference' | 'busy';
export type AddKeyResult = { status: 'ok' } |
  { status: 'invalid' | 'not_included' | 'retry'; reason: KeyFailureReason };

export function createKeys(ctx: ActivationCtx & {
  root: string;
  ensure(member: Member): Promise<{ agentId: string }>;
  restarting?(): boolean;
  prepareOwner(agentId: string): Promise<void>;
}) {
  // Serialize key replacement and key runs, so an in-flight run never sees a half-installed replacement.
  const tails = new Map<string, Promise<unknown>>();
  const exclusive = async <T>(member: Member, work: () => Promise<T>): Promise<T> => {
    const previous = tails.get(member) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    tails.set(member, next);
    try { return await next; }
    finally { if (tails.get(member) === next) tails.delete(member); }
  };
  const check = (member: Member) => MEMBER_ID.test(member) && !member.startsWith(KEY_PREFIX);
  // Config writes may drain/restart the gateway: a restart, or a retryable refusal, means the call may simply run again.
  const transient = (error: unknown): boolean => {
    const refusal = error as { code?: string; retryable?: boolean } | null;
    return Boolean(ctx.restarting?.() || (refusal?.code === 'UNAVAILABLE' && refusal.retryable === true));
  };
  const control = (member: Member, action: 'prepare' | 'seal' | 'ready' | 'clear', provider?: string, model?: string) =>
    ctx.request('byokit.keys', { member, action, ...(provider ? { provider } : {}), ...(model ? { model } : {}) }) as
      Promise<{ ok: boolean; model?: string; absent?: boolean }>;
  const failure = (status: 'invalid' | 'not_included' | 'retry', reason: KeyFailureReason): AddKeyResult => ({ status, reason });
  // Only a provider refusal is `invalid`; an unavailable route or model is `not_included`; everything else may be retried.
  const probeResult = (status: string | undefined): AddKeyResult => {
    switch (status) {
      case 'auth': return failure('invalid', 'auth');
      case 'billing': return failure('invalid', 'billing');
      case 'unavailable': case 'no_model': return failure('not_included', 'model');
      case 'timeout': case 'network': return failure('retry', 'network');
      case 'rate_limit': case 'busy': return failure('retry', 'busy');
      case 'format': case 'unknown': return failure('retry', 'inference');
      default: return failure('retry', 'engine');
    }
  };
  const registered = async (provider: string, model: string): Promise<boolean> => {
    const { config } = await ctx.request('config.get') as
      { config?: { models?: { providers?: Record<string, { models?: { id: string }[] }> } } };
    return Boolean(config?.models?.providers?.[provider]?.models?.some((m) => `${provider}/${m.id}` === model));
  };
  const errorReason = (error: unknown, sent: boolean): KeyFailureReason => {
    if (transient(error)) return 'busy';
    const e = error as { code?: string; name?: string } | null;
    if (sent && e?.code === 'INVALID_REQUEST') return 'inference';
    return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'CLIENT_TIMEOUT', 'NETWORK_ERROR'].includes(e?.code ?? '')
      || e?.name === 'TimeoutError' ? 'network' : 'engine';
  };
  const models = async (member: Member, o: { authChoice: string }): Promise<ModelInfo[]> => {
    if (!check(member)) throw new Error('Choose your own member.');
    const route = routes().find((r) => r.choice === o.authChoice && r.keyEntry && r.readiness === 'ready');
    if (!route || !LIVE_CATALOGS.includes(route.provider)) return [];
    await ctx.ensure(member);
    const catalog = await ctx.request('byokit.catalog', { provider: route.provider }) as
      { ok: boolean; reason?: string; models?: Record<string, unknown>[] };
    if (catalog.ok) return modelsOf(route.provider, { models: catalog.models?.map((m) => ({ ...m, provider: route.provider })) });
    if (catalog.reason !== 'no-key') throw new Error('Model catalog is unavailable.');
    return [];
  };
  return {
    models,
    exclusive,
    async add(member: Member, o: { authChoice: string; apiKey: string; model?: string }): Promise<AddKeyResult> {
      if (!check(member)) throw new Error('Choose your own member.');
      if (!o.apiKey.trim()) return failure('invalid', 'empty');
      const route = routes().find((r) => r.choice === o.authChoice && r.keyEntry && r.readiness === 'ready');
      if (!route || (o.model !== undefined && !LIVE_CATALOGS.includes(route.provider))) return failure('not_included', 'model');
      return exclusive(member, async () => {
        let sent = false;
        // A key the engine may have taken but not sealed is cleared (prepare already emptied the agent); if the clear
        // does not reach the engine, the key stays unsealed and unusable until the next key add or kit start, so runs
        // fail closed.
        const abandon = async (result: AddKeyResult): Promise<AddKeyResult> => {
          await control(member, 'clear').catch(() => undefined);
          return result;
        };
        try {
          await ctx.ensure(member);
          const agentId = keyAgentId(member);
          const list = await ctx.request('agents.list') as { agents: { id: string }[] };
          if (!list.agents.some((a) => a.id === agentId))
            await ctx.request('agents.create', { name: agentId, workspace: join(ctx.root, 'key-workspaces', member) });
          // Creation answers before the runtime roster/owners publish, just as for ordinary members.
          await untilListed(ctx.request, agentId);
          if (!(await control(member, 'prepare', route.provider)).ok) return failure('retry', 'engine');
          // The public pin's typed API-key path, never a CLI-login import. Discard the engine's lines/errors.
          sent = true;
          const result = await activate(ctx, { kind: 'api-key', agentId, authChoice: o.authChoice, apiKey: o.apiKey },
            { timeoutMs: 180_000 });
          if (!result.ok && !result.late) return abandon(probeResult(result.status));
          if (result.late) return abandon(failure('retry', 'busy'));
          if (o.model !== undefined && !(await models(member, o)).some((m) => m.id === o.model && m.available))
            return abandon(failure('not_included', 'model'));
          // Prepare before publishing the ready marker: failed preparation remains unusable even if clear fails.
          try { await ctx.prepareOwner(agentId); }
          catch { return abandon(failure('retry', 'engine')); }
          if (o.model !== undefined && LIVE_CATALOGS.includes(route.provider) && !(await registered(route.provider, o.model)))
            return abandon(failure('retry', 'model'));
          if ((await control(member, 'seal', undefined, o.model)).ok) return { status: 'ok' };
          return abandon(failure('retry', 'engine'));
        } catch (error) {
          const reason = errorReason(error, sent);
          if (sent) return abandon(failure('retry', reason));
          return failure('retry', reason);
        }
      });
    },
    async ready(member: Member, o: { once?: boolean } = {}): Promise<{ agentId: string; model: string } | undefined> {
      if (!check(member)) return undefined;
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const ready = await control(member, 'ready');
          return ready.ok && ready.model ? { agentId: keyAgentId(member), model: ready.model } : undefined;
        } catch (error) {
          // This read is safe to retry; an absent profile or a terminal refusal still fails closed immediately.
          if (o.once || !transient(error) || Date.now() >= deadline) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
    // Kit start calls this once the gateway is ready: a failed add whose abandon clear never reached the engine
    // leaves an unsealed key with no ready marker, so drop it. A single ready read per key agent, no retries; an add
    // in flight for that member is waited for. Only an absent marker is cleared; a refused read or clear (the gateway
    // left ready) makes the sweep incomplete. Resolves true once every key agent was read.
    async sweep(): Promise<boolean> {
      let agents: { id: string }[];
      try {
        agents = ((await ctx.request('agents.list')) as { agents: { id: string }[] }).agents;
      } catch { return false; }
      let complete = true;
      for (const agent of agents) {
        if (!agent.id.startsWith(KEY_PREFIX)) continue;
        const member = agent.id.slice(KEY_PREFIX.length) as Member;
        if (!check(member)) continue;
        await exclusive(member, async () => {
          const ready = await control(member, 'ready').catch(() => undefined);
          if (ready?.ok === true) return;
          if (ready?.absent !== true) { complete = false; return; }
          const cleared = await control(member, 'clear').catch(() => undefined);
          if (cleared?.ok !== true) complete = false;
        });
      }
      return complete;
    },
  };
}
