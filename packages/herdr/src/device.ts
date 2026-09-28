// The phone and browser side (portable: no Node import anywhere in it): typed calls to a host running this kit's
// link adapter (docs/runtime-kits.md 7.2) — behavior lands in H7.

import type { DeviceLink } from '@byokit/link';
import type {
  AgentRef, BlockedAgent, HerdrSnapshot, HerdrState, PromptReceipt, StartAgent,
} from './types.ts';

export { openNotice } from './notices.ts';

export function herdrDevice(link: DeviceLink): {
  state(): Promise<{ state: HerdrState; words: string }>;
  tree(): Promise<HerdrSnapshot>;
  startAgent(o: StartAgent): Promise<AgentRef>;
  prompt(paneId: string, text: string): Promise<PromptReceipt>;
  keys(paneId: string, keys: string[]): Promise<void>;
  read(paneId: string, o?: { source?: 'visible' | 'recent' | 'recent_unwrapped' | 'detection'; lines?: number }):
    Promise<{ text: string; truncated: boolean }>;
  blocked(): Promise<BlockedAgent[]>;
  answer(paneId: string, keys: string[], revision: number): Promise<void>;
  close(o: { pane?: string; tab?: string; workspace?: string }): Promise<void>;
  events(): AsyncIterable<unknown>;
  registerNotices(seed: Uint8Array): Promise<void>;         // derives the box key with @byokit/seal
  openNotice(data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null;
  call(method: string, params?: unknown): Promise<unknown>;
  terminal(paneId: string, o: { mode: 'control' | 'observe'; cols: number; rows: number }): {
    onFrame(fn: (line: string) => void): () => void; send(line: string): void; close(): void;
  };
} {
  throw new Error('@byokit/herdr: herdrDevice lands in H7 (docs/runtime-kits.md §11.3).');
}
