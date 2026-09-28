// Members are app-chosen ids used verbatim as the OpenClaw agentId (D9); ensure creates once and caches (5.8, O4).
import type { GatewayTransport, Member } from './types.ts';

export const MEMBER_ID: RegExp = /^[a-z][a-z0-9-]{0,31}$/;

export function createMembers(ctx: {
  request: GatewayTransport['request'];
  root: string;
}): { ensure(member: Member): Promise<{ agentId: string; workspace: string }> } {
  throw new Error('not built: O4');
}
