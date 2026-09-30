export type Provider = 'claude' | 'codex' | 'opencode' | 'zai' | 'copilot' | 'grok' | 'minimax' | 'gemini' | 'kimi';
/** Host-owned identity makes readings survive token renewal. Tokens never become stored identities. */
type Identity = { accountId?: string };
export type Source =
  | { provider: 'codex'; bin: string; home: string; env?: Record<string, string> }
  | { provider: 'codex'; access: string; accountId: string }
  | ({ provider: 'claude'; access: string; accountUuid?: string } & Identity)
  | ({ provider: 'claude'; accountUuid: string; read: ClaudeReader; connected?: () => boolean })
  | { provider: 'claude'; credentialsFile: string; configFile?: string; statuslineFile?: string }
  | ({ provider: 'opencode' | 'zai'; key: string } & Identity)
  | ({ provider: 'copilot' | 'grok' | 'minimax' | 'kimi'; access: string } & Identity)
  | ({ provider: 'gemini'; access: string; project?: string } & Identity);
export type Kind = 'session' | 'weekly' | 'monthly' | 'rolling' | 'custom';
/** All reset times are epoch milliseconds in 0.2.0. */
export type Window = { provider: Provider; kind: Kind; limit?: string; usedPercent: number; minutes?: number; resetsAt?: number; limited?: boolean };
export type Code = 'not-connected' | 'expired' | 'auth' | 'no-plan' | 'rate-limited' | 'unavailable' | 'incomplete';
export type Reading = { provider: Provider; windows: Window[]; at: number; code?: Code };
export type Room = { left: number; span: 'session' | 'week' | 'month' | 'tightest'; resetsAt?: number; at: number } | { left: 'unknown'; at?: number };
export type ReadOptions = { nowMs?: number };
export type SourceAnswer = { raw?: unknown; code?: Code; retryAfterMs?: number };
/** The app owns credential reads/refresh and sends its own requests through this seam. */
export type ClaudeReader = (options: { nowMs: number; signal: AbortSignal }) => Promise<SourceAnswer>;
export type StoredReading = { at: number; windows: Window[] };
export interface UsageStore {
  get(provider: Provider, account: string): StoredReading | undefined;
  put(provider: Provider, account: string, reading: StoredReading): void;
}
export interface BackoffPolicy {
  get(provider: Provider, account: string): number | undefined;
  set(provider: Provider, account: string, untilMs: number): void;
  /** Retry-After duration to wait; default at least five minutes. */
  delayMs?(retryAfterMs: number | undefined): number;
}
export type UsageOptions = { stateDir?: string; store?: UsageStore; backoff?: BackoffPolicy; salt?: string; fetch?: typeof fetch; now?: () => number };
export interface Usage {
  read(source: Source, options?: ReadOptions): Promise<Reading>;
  lastKnown(source: Source, options?: ReadOptions): Reading | undefined;
  connected(source: Source): boolean;
  /** Stable identity fingerprint, absent for an opaque token without a host-supplied id. */
  account(source: Source): string | undefined;
}
export class UsageError extends Error {
  readonly code = 'bad-source';
  override name = 'UsageError';
  constructor() { super('The app supplied an invalid usage source.'); }
}
