// The frozen public surface: platform text-to-speech only, no network, no keys.
// Signature changes are spec changes.
export type SpeakErrorCode = 'invalid' | 'unavailable' | 'failed' | 'interrupted';

export class SpeakError extends Error {
  readonly code: SpeakErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: SpeakErrorCode, message: string, o: { detail?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, o.cause === undefined ? undefined : { cause: o.cause });
    this.name = 'SpeakError';
    this.code = code;
    if (o.detail !== undefined) this.detail = o.detail;
  }
}

export type Voice = { id: string; name: string; lang: string };
export type SpeakOptions = {
  voice?: string; // platform voice id; unknown ids fall back to the platform default
  rate?: number; // 0.25–4, default 1
  pitch?: number; // 0–2, default 1
  signal?: AbortSignal; // per call, never in the constructor
};
export type SpeakEvent = { type: 'start' } | { type: 'end' } | { type: 'error'; error: SpeakError };
export type SpeakEventType = SpeakEvent['type'];
export interface SpeakHandle {
  readonly done: Promise<void>; // resolves on end, rejects on error, cancel or abort
  cancel(): void; // done rejects with SpeakError 'interrupted'
  on<T extends SpeakEventType>(type: T, fn: (e: Extract<SpeakEvent, { type: T }>) => void): () => void;
}
export interface Speaker {
  speak(text: string, o?: SpeakOptions): SpeakHandle;
  voices(): Promise<Voice[]>;
  stop(): void; // cancel every in-flight utterance
}
// What the native modules expose; internal seam.
export type NativeSpeakEvent = { id: number; type: 'start' | 'end' | 'error'; message?: string };
export interface NativeSpeak {
  speak(id: number, text: string, voice: string | null, rate: number, pitch: number): void;
  cancel(id: number): void;
  stopAll(): void;
  voices(): Promise<Voice[]>;
  addListener(event: 'speak', fn: (e: NativeSpeakEvent) => void): { remove(): void };
}
