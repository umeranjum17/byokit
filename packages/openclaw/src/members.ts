import { join } from 'node:path';
import type { GatewayTransport, Member } from './types.ts';

export const MEMBER_ID: RegExp = /^[a-z][a-z0-9-]{0,31}$/;
export const KEY_PREFIX = 'byokit-key-';
export const keyAgentId = (member: Member): string => `${KEY_PREFIX}${member}`;

export function createMembers(ctx: { request: GatewayTransport['request']; root: string }): {
  ensure(member: Member): Promise<{ agentId: string; workspace: string }>;
} {
  const cache = new Map<string, Promise<{ agentId: string; workspace: string }>>();
  return { ensure(member) {
    if (!MEMBER_ID.test(member) || member.startsWith(KEY_PREFIX)) return Promise.reject(new Error(`invalid member id: ${member}`));
    const existing = cache.get(member);
    if (existing) return existing;
    const workspace = join(ctx.root, 'workspaces', member);
    const result = (async () => {
      const list = await ctx.request('agents.list') as { agents: { id: string }[] };
      if (!list.agents.some((agent) => agent.id === member)) await ctx.request('agents.create', { name: member, workspace });
      return { agentId: member, workspace };
    })();
    cache.set(member, result);
    void result.catch(() => { if (cache.get(member) === result) cache.delete(member); });
    return result;
  } };
}
