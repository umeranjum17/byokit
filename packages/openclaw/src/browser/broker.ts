// Internal W1/W2 seam from the accepted handoff. Types only: no qualified broker implementation yet.
import type { Member } from '../types.ts';
import type { LiveFrame, LiveInput } from '../browser.ts';

export type BrokerOptions = {
  executablePath: string;
  profileDir: string;
  member: Member;
  onExit(code: number | null): void;
};

export type Broker = {
  endpoint(): { cdpUrl: string };
  fence(on: boolean): Promise<void>;
  agentTab(): string | undefined;
  originOf(targetId: string): Promise<string>;
  openPrivate(url: string): Promise<string>;
  closePrivate(): Promise<void>;
  probe(url: string, verify: (p: Probe) => Promise<boolean>, timeoutMs: number): Promise<'ok' | 'fail' | 'timeout'>;
  attachViewer(o: { lease?: { epoch: number; nonce: string } }): ViewerSession;
  navigateAgent(url: string | 'reload'): Promise<void>;
  close(): Promise<void>;
};

export type Probe = { url: string; status: number; exists(selector: string): Promise<boolean> };
export type ViewerSession = { frames: AsyncIterable<LiveFrame>; input(i: LiveInput): void; close(): void };
