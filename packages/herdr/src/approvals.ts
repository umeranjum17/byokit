// Blocked-agent approvals: a `blocked` agent is an approval, the answer is keys to that exact pane occupant,
// revision-checked (docs/runtime-kits.md 6.4, D10) — built in H5.

import type { Call } from './agents.ts';
import type { BlockedAgent, HerdrSnapshot } from './types.ts';

export class Blocked {
  constructor(ctx: { call: Call }) {
    throw new Error('@byokit/herdr: Blocked lands in H5 (docs/runtime-kits.md §11.3).');
  }

  update(paneId: string, agent: HerdrSnapshot['workspaces'][number]['tabs'][number]['panes'][number]['agent'],
         where: { workspaceId: string; tabId: string }): void {
    throw new Error('@byokit/herdr: Blocked.update lands in H5 (docs/runtime-kits.md §11.3).');
  }

  list(): BlockedAgent[] {
    throw new Error('@byokit/herdr: Blocked.list lands in H5 (docs/runtime-kits.md §11.3).');
  }

  on(fn: (b: BlockedAgent, change: 'added' | 'resolved') => void): () => void {
    throw new Error('@byokit/herdr: Blocked.on lands in H5 (docs/runtime-kits.md §11.3).');
  }

  answer(paneId: string, keys: string[], o: { revision: number }): Promise<void> {
    throw new Error('@byokit/herdr: Blocked.answer lands in H5 (docs/runtime-kits.md §11.3).');
  }
}
