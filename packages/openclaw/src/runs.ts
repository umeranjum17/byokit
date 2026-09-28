// Runs: one Gateway run per spec, streamed through typed events, ending in a classified RunEnd (5.8, O8).
import type { Bridge } from './bridge.ts';
import type { GatewayTransport, Member, RunEnd, RunEvent, RunSpec } from './types.ts';

export function createRuns(ctx: {
  request: GatewayTransport['request'];
  onEvent: GatewayTransport['onEvent'];
  ensure(member: Member): Promise<{ agentId: string }>;
  bridge: Pick<Bridge, 'register' | 'unregister'>;
}): {
  run(spec: RunSpec, on?: (e: RunEvent) => void): Promise<RunEnd>;
  steer(k: string, t: string): Promise<void>;
  abort(k: string): Promise<void>;
} {
  throw new Error('not built: O8');
}
