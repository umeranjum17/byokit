// The fail-closed tool bridge: plugin hook -> unix socket -> app gate, with parked asks and one-use permits (5.9, O5).
import type { Approval, Decision, RunRef, ToolHost, ToolSpec } from './types.ts';

export function writePlugin(
  dir: string,
  o: { id: string; tools: ToolSpec[]; paramPrefix: '__byokit' | '__crewhouse' },
): void {
  throw new Error('not built: O5');
}

export class Bridge {
  constructor(_o: {
    path: string;
    host?: ToolHost;
    permitted: (tool: string) => boolean;
    approvalTimeoutMs: number;
    onAsk(a: Approval): void;
    onAskGone(id: string): void;
  }) {
    throw new Error('not built: O5');
  }

  start(): Promise<void> {
    throw new Error('not built: O5');
  }

  stop(): void {
    throw new Error('not built: O5');
  }

  register(run: RunRef): void {
    throw new Error('not built: O5');
  }

  unregister(sessionKey: string): void {
    throw new Error('not built: O5');
  }

  allowOnce(
    rule: { keyPrefix: string; tool: string; input?: (i: Record<string, unknown>) => boolean },
    ms: number,
  ): void {
    throw new Error('not built: O5');
  }

  disallowOnce(): void {
    throw new Error('not built: O5');
  }

  resolveAsk(id: string, d: Decision): boolean {
    throw new Error('not built: O5');
  }
}
