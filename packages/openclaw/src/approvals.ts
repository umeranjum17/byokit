// Native approvals: exec.approval.*, plugin.approval.* and question.* surfaced through the same Approval shape (5.9, O5).
import type { Bridge } from './bridge.ts';
import type { Approval, Decision, GatewayTransport, Member } from './types.ts';

export class Approvals {
  constructor(_o: { request: GatewayTransport['request']; bridge: Pick<Bridge, 'resolveAsk'> }) {
    throw new Error('not built: O5');
  }

  handleEvent(e: { event: string; payload?: unknown }): void {
    throw new Error('not built: O5');
  }

  add(a: Approval): void {
    throw new Error('not built: O5');
  }

  remove(id: string): void {
    throw new Error('not built: O5');
  }

  list(member?: Member): Approval[] {
    throw new Error('not built: O5');
  }

  on(fn: (a: Approval, change: 'added' | 'resolved') => void): () => void {
    throw new Error('not built: O5');
  }

  decide(id: string, d: Decision): Promise<void> {
    throw new Error('not built: O5');
  }
}
