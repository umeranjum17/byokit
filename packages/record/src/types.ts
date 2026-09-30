// Public types, frozen by docs/capability-kits.md 5.2.
import type { DISPLAY_VARS } from './constants.ts';

export type SourceKind = 'screen' | 'x11' | 'android';
/** Grammar in docs/capability-kits.md 6.4. */
export type Source = 'screen' | `x11:${string}` | `android:${string}`;
export type EventsMode = 'own' | 'none';
export type DisplayVar = (typeof DISPLAY_VARS)[number];
export type CaptureOptions = {
  /** Absolute path of a recorder implementing protocol v1. */
  bin: string;
  /** App-owned; the kit writes only under join(stateDir, 'capture'). */
  stateDir: string;
  /** The session a `screen` or `x11:` recording needs (5.4). */
  display?: Partial<Record<DisplayVar, string>>;
  /** make() timeout, default 600_000, clamped 1 s–30 min. */
  timeoutMs?: number;
};
export type RecorderHello = {
  protocol: number;
  recorder: { name: string; version: string };
  sources: SourceKind[];
  /** = sources.includes('android'). */
  android: boolean;
  /** Always includes 'none'. */
  events: EventsMode[];
  planner: { available: boolean; needsKey: boolean };
};
export type RecordOptions = {
  source: Source;
  /** Absolute; takes are created as direct children. */
  root: string;
  /** Default 'none'. */
  events?: EventsMode;
  /** Integer 1–3600, a hard stop in the recorder. */
  maxSeconds: number;
  /** Abort → `capture stop` (5.4). */
  signal?: AbortSignal;
};
export type RecordEvent =
  | { event: 'consent-pending' }
  | { event: 'recording'; take: string }
  | { event: 'done'; take: string; seconds: number; warnings: string[] };
/** Seconds from the take's start; d = duration. */
export type Caption = { t: number; text: string; d?: number };
export type MakeOptions = {
  /** Absolute take dir from a `recording`/`done` event. */
  take: string;
  /** Estimate only: no model call, no video. */
  planOnly?: boolean;
  title?: string;
  captions?: Caption[];
  /** Recorder-defined render settings (6.6). */
  set?: Record<string, string | number | boolean>;
  /** Abort kills the make process group (SIGTERM, SIGKILL after 5 s) and rejects signal.reason (5.3). */
  signal?: AbortSignal;
} & ({ plannerKey: string; maxTokens: number } | { plannerKey?: undefined; maxTokens?: undefined });
export type MakeResult = {
  /** Absolute .mp4 inside the take; null with planOnly. */
  out: string | null;
  seconds: number;
  beats: number;
  planner: { plannedTokens: number; inputTokens: number; usd: number; failed: boolean };
  warnings: string[];
};
export type CaptureErrorCode =
  | 'missing' | 'needs-update' | 'unsupported' | 'invalid'
  | 'consent-cancelled' | 'consent-timeout' | 'stopped' | 'already-recording'
  | 'preflight-refused' | 'take-input' | 'render-failed'
  | 'timeout' | 'too-much-output' | 'protocol' | 'failed';
