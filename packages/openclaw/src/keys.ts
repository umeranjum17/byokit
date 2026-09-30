import { join } from 'node:path';
import { keyAgentId, MEMBER_ID, KEY_PREFIX } from './members.ts';
import { routes } from './routes.ts';
import type { GatewayParams, GatewayResult, GatewayTransport, Member } from './types.ts';

export type AddKeyResult = 'ok' | 'invalid' | 'not_included';

export function createKeys(ctx: {
  root: string;
  request: GatewayTransport['request'];
  ensure(member: Member): Promise<{ agentId: string }>;
  restarting?(): boolean;
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
  const control = (member: Member, action: 'prepare' | 'seal' | 'ready', provider?: string) =>
    ctx.request('byokit.keys', { member, action, ...(provider ? { provider } : {}) }) as Promise<{ ok: boolean; model?: string }>;
  return {
    exclusive,
    async add(member: Member, o: { authChoice: string; apiKey: string }): Promise<AddKeyResult> {
      if (!check(member) || !o.apiKey.trim()) return 'invalid';
      const route = routes().find((r) => r.choice === o.authChoice && r.keyEntry);
      if (!route) return 'not_included';
      return exclusive(member, async () => {
        try {
          await ctx.ensure(member);
          const agentId = keyAgentId(member);
          const list = await ctx.request('agents.list') as { agents: { id: string }[] };
          if (!list.agents.some((a) => a.id === agentId))
            await ctx.request('agents.create', { name: agentId, workspace: join(ctx.root, 'key-workspaces', member) });
          if (!(await control(member, 'prepare', route.provider)).ok) return 'invalid';
          // The public pin's typed API-key path, never a CLI-login import. Discard the engine's lines/errors.
          const params: GatewayParams<'openclaw.setup.activate'> = {
            kind: 'api-key', agentId, authChoice: o.authChoice, apiKey: o.apiKey,
          };
          const result = (await ctx.request('openclaw.setup.activate', params, { timeoutMs: 180_000 })) as GatewayResult<'openclaw.setup.activate'>;
          if (!result.ok) return result.status === 'unavailable' ? 'not_included' : 'invalid';
          return (await control(member, 'seal')).ok ? 'ok' : 'invalid';
        } catch { return 'invalid'; }
      });
    },
    async ready(member: Member): Promise<{ agentId: string; model: string } | undefined> {
      if (!check(member)) return undefined;
      const deadline = Date.now() + 60_000;
      for (;;) {
        try {
          const ready = await control(member, 'ready');
          return ready.ok && ready.model ? { agentId: keyAgentId(member), model: ready.model } : undefined;
        } catch (error) {
          // Config writes may drain/restart the gateway after activation. This read is safe to retry;
          // an absent profile or a terminal refusal still fails closed immediately.
          const refusal = error as { code?: string; retryable?: boolean } | null;
          const transient = ctx.restarting?.() || (refusal?.code === 'UNAVAILABLE' && refusal.retryable === true);
          if (!transient || Date.now() >= deadline) return undefined;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    },
  };
}
