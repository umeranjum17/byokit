import { join } from 'node:path';
import type { GatewayTransport, Member } from './types.ts';

// Any member that may run: D9's older rule, which a member created before O14 still matches (D17).
export const MEMBER_ID: RegExp = /^[a-z][a-z0-9-]{0,31}$/;
// D9 for a member the kit creates: no `--` (account agents are `<member>--<6 hex>`) and at most 24 characters.
const NEW_MEMBER_ID = /^[a-z](?!.*--)[a-z0-9-]{0,23}$/;
export const KEY_PREFIX = 'byokit-key-';
// The inherited auth base every agent reads through (5.15): the kit never creates, signs in to or runs it.
export const BASE_AGENT = 'byokit-base';
// The engine's own agents (`main` exists on every install) and the base are never a member, existing or not.
const RESERVED = new Set(['main', 'openclaw', 'crestodian', BASE_AGENT]);
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
    const invalid = () => new Error(`invalid member id: ${member}`);
    if (!MEMBER_ID.test(member) || member.startsWith(KEY_PREFIX) || RESERVED.has(member)) return Promise.reject(invalid());
    const existing = cache.get(member);
    if (existing) return existing;
    const workspace = join(ctx.root, 'workspaces', member);
    const result = (async () => {
      if (!await listed(member)) {
        if (!NEW_MEMBER_ID.test(member) || member.startsWith('byokit-')) throw invalid();
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
