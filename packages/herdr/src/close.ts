// Exact close guards: a close that would widen (pane → tab → workspace) is refused (docs/runtime-kits.md 6.4)
// — built in H5.

import type { Call } from './agents.ts';

export function closePane(call: Call, paneId: string): Promise<void> {
  throw new Error('@byokit/herdr: closePane lands in H5 (docs/runtime-kits.md §11.3).');
}

export function closeTab(call: Call, tabId: string): Promise<void> {
  throw new Error('@byokit/herdr: closeTab lands in H5 (docs/runtime-kits.md §11.3).');
}

export function closeWorkspace(call: Call, workspaceId: string): Promise<void> {
  throw new Error('@byokit/herdr: closeWorkspace lands in H5 (docs/runtime-kits.md §11.3).');
}
