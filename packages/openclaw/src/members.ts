import { join } from 'node:path';
import type { GatewayTransport, Member } from './types.ts';

export const MEMBER_ID: RegExp = /^[a-z][a-z0-9-]{0,31}$/;
export const KEY_PREFIX = 'byokit-key-';
export const keyAgentId = (member: Member): string => `${KEY_PREFIX}${member}`;

// The engine answers agents.create before its roster hot-reload applies (up to ~113 ms observed), so a turn sent
// at once fails as 'unknown agent id'. ensure resolves only once agents.list shows the member.
const VISIBLE_TIMEOUT_MS = 5_000;
const VISIBLE_POLL_MS = 25;

export function createMembers(ctx: { request: GatewayTransport['request']; root: string }): {
  ensure(member: Member): Promise<{ agentId: string; workspace: string }>;
} {
  const cache = new Map<string, Promise<{ agentId: string; workspace: string }>>();
  const listed = (member: Member): Promise<boolean> =>
    ctx.request('agents.list').then((list) => (list as { agents: { id: string }[] }).agents.some((agent) => agent.id === member));
  return { ensure(member) {
    if (!MEMBER_ID.test(member) || member.startsWith(KEY_PREFIX)) return Promise.reject(new Error(`invalid member id: ${member}`));
    const existing = cache.get(member);
    if (existing) return existing;
    const workspace = join(ctx.root, 'workspaces', member);
    const result = (async () => {
      if (!await listed(member)) {
        await ctx.request('agents.create', { name: member, workspace });
        const deadline = Date.now() + VISIBLE_TIMEOUT_MS;
        while (!await listed(member)) {
          if (Date.now() >= deadline) throw new Error(`agent ${member} is not listed by agents.list after agents.create`);
          await new Promise((resolve) => setTimeout(resolve, VISIBLE_POLL_MS));
        }
      }
      return { agentId: member, workspace };
    })();
    cache.set(member, result);
    void result.catch(() => { if (cache.get(member) === result) cache.delete(member); });
    return result;
  } };
}
