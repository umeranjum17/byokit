// `herdr terminal session <control|observe> <paneId>`: Herdr's own NDJSON terminal frames passed through untouched
// (docs/runtime-kits.md 6.5) — built in H4.

import type { TerminalSession } from './types.ts';

export function openTerminal(bin: string, env: Record<string, string>, paneId: string,
  o: { mode: 'control' | 'observe'; cols: number; rows: number }): TerminalSession {
  throw new Error('@byokit/herdr: openTerminal lands in H4 (docs/runtime-kits.md §11.3).');
}
