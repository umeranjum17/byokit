import { join } from 'node:path';
import { activate, type ActivationCtx } from './activation.ts';
import { keyAgentId, MEMBER_ID, KEY_PREFIX } from './members.ts';
import { routes } from './routes.ts';
import type { Member } from './types.ts';

// retry: the engine may have taken the key but it was not kept; the unsealed key is cleared best-effort. If that clear
// does not reach the engine, the key stays unsealed and unusable until the next key add or kit start, and runs fail
// closed meanwhile.
export type AddKeyResult = 'ok' | 'invalid' | 'not_included' | 'retry';

export function createKeys(ctx: ActivationCtx & {
  root: string;
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
  // Config writes may drain/restart the gateway: a restart, or a retryable refusal, means the call may simply run again.
  const transient = (error: unknown): boolean => {
    const refusal = error as { code?: string; retryable?: boolean } | null;
    return Boolean(ctx.restarting?.() || (refusal?.code === 'UNAVAILABLE' && refusal.retryable === true));
  };
  const control = (member: Member, action: 'prepare' | 'seal' | 'ready' | 'clear', provider?: string) =>
    ctx.request('byokit.keys', { member, action, ...(provider ? { provider } : {}) }) as Promise<{ ok: boolean; model?: string; absent?: boolean }>;
  return {
    exclusive,
    async add(member: Member, o: { authChoice: string; apiKey: string }): Promise<AddKeyResult> {
      if (!check(member) || !o.apiKey.trim()) return 'invalid';
      const route = routes().find((r) => r.choice === o.authChoice && r.keyEntry && r.readiness === 'ready');
      if (!route) return 'not_included';
      return exclusive(member, async () => {
        let sent = false;
        // A key the engine may have taken but not sealed is cleared (prepare already emptied the agent); if the clear
        // does not reach the engine, the key stays unsealed and unusable until the next key add or kit start, so runs
        // fail closed.
        const abandon = async (): Promise<AddKeyResult> => {
          await control(member, 'clear').catch(() => undefined);
          return 'retry';
        };
        try {
          await ctx.ensure(member);
          const agentId = keyAgentId(member);
          const list = await ctx.request('agents.list') as { agents: { id: string }[] };
          if (!list.agents.some((a) => a.id === agentId))
            await ctx.request('agents.create', { name: agentId, workspace: join(ctx.root, 'key-workspaces', member) });
          if (!(await control(member, 'prepare', route.provider)).ok) return 'invalid';
          // The public pin's typed API-key path, never a CLI-login import. Discard the engine's lines/errors.
          sent = true;
          const result = await activate(ctx, { kind: 'api-key', agentId, authChoice: o.authChoice, apiKey: o.apiKey },
            { timeoutMs: 180_000 });
          if (!result.ok && !result.late) return result.status === 'unavailable' ? 'not_included' : 'invalid';
          if (!result.late && (await control(member, 'seal')).ok) return 'ok';
          return abandon();
        } catch (error) {
          if (sent) return abandon();
          return transient(error) ? 'retry' : 'invalid';
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
          const ready = await control(member, 'ready').catch(() => { complete = false; return undefined; });
          if (!ready?.absent) return;
          const cleared = await control(member, 'clear').catch(() => undefined);
          if (cleared?.ok !== true) complete = false;
        });
      }
      return complete;
    },
  };
}
