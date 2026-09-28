// Agent helpers: placements, prompt receipts, waits and reads (docs/runtime-kits.md 6.4) — built in H5.

import type { HerdrKit } from './kit.ts';
import type { HerdrSnapshot } from './types.ts';

export type Call = (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

export function createAgents(ctx: { call: Call; snapshot(): HerdrSnapshot }): Pick<HerdrKit,
  'startAgent' | 'prompt' | 'sendKeys' | 'wait' | 'read' | 'agentKinds' | 'installedAgentKinds'> {
  throw new Error('@byokit/herdr: createAgents lands in H5 (docs/runtime-kits.md §11.3).');
}
