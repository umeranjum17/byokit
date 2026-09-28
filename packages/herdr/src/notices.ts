// Sealed blocked-approval notices: the relay reads only a generic title, the phone opens the sealed body with its
// own key (docs/runtime-kits.md 7.3) — built in H7.

import type { BlockedAgent } from './types.ts';

export function sealNotice(b: BlockedAgent, boxPublicKey: Uint8Array): { v: 1; sealed: string } {
  throw new Error('@byokit/herdr: sealNotice lands in H7 (docs/runtime-kits.md §11.3).');
}

export function openNotice(data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null {
  throw new Error('@byokit/herdr: openNotice lands in H7 (docs/runtime-kits.md §11.3).');
}
