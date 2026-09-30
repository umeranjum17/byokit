export type Provider = 'claude' | 'codex' | 'opencode' | 'zai';
/** Claude's credential adapter belongs to the host; only its parser ships here. */
export type Source =
  | { provider: 'codex'; bin: string; home: string; env?: Record<string, string> }
  | { provider: 'opencode'; key: string }
  | { provider: 'zai'; key: string };
export type Kind = 'session' | 'weekly' | 'monthly' | 'rolling' | 'custom';
export type Window = { provider: Provider; kind: Kind; limit?: string; usedPercent: number; minutes?: number; resetsAt?: number; limited?: boolean };
export type Code = 'not-connected' | 'expired' | 'auth' | 'no-plan' | 'rate-limited' | 'unavailable' | 'incomplete';
export type Reading = { provider: Provider; windows: Window[]; at: number; code?: Code };
export type ReadOptions = { nowMs?: number };
export type UsageOptions = { stateDir: string; salt?: string; fetch?: typeof fetch; now?: () => number };
export interface Usage {
  read(source: Source, options?: ReadOptions): Promise<Reading>;
  lastKnown(source: Source, options?: ReadOptions): Reading | undefined;
  connected(source: Source): boolean;
  account(source: Source): string | undefined;
}
export class UsageError extends Error {
  readonly code = 'bad-source';
  override name = 'UsageError';
  constructor() { super('The app supplied an invalid usage source.'); }
}
