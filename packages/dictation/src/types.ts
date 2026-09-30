export type DictateEngineId = 'system' | 'whisper' | 'openai' | 'openrouter' | 'chatgpt';
export type DictateEngineInfo = { id: DictateEngineId; model?: string; onDevice: boolean; streaming: 'native' | 'reread' | 'utterance'; account: 'plan' | 'key' | 'none' };
export type DictateOptions = { languages?: string[]; prompt?: string; keywords?: string[]; replacements?: Record<string, string>; punctuation?: boolean; timestamps?: 'none' | 'segment' | 'word'; onDeviceOnly?: boolean; signal?: AbortSignal;
  /** Live PCM capture limit, including silence, in seconds. Defaults to 300; finite and positive. */
  maxSeconds?: number };
export type DictateSegment = { id: string; text: string; final: boolean; startMs?: number; endMs?: number; language?: string; words?: { text: string; startMs: number; endMs: number }[] };
export type DictateUsage = { audioMs: number; basis: 'free' | 'minutes' | 'tokens' | 'subscription'; costUsd?: number; inputTokens?: number };
export type DictateTranscript = { text: string; segments: DictateSegment[]; language?: string; durationMs?: number; usage: DictateUsage; engine: DictateEngineInfo };
export type DictationState = { phase: 'idle' | 'listening' | 'settling' | 'loading-model'; why?: DictateErrorCode };
export type DictationEvent = { type: 'partial'; segment: DictateSegment } | { type: 'final'; segment: DictateSegment } | { type: 'level'; rms: number } | { type: 'turn'; phase: 'start' | 'end' };
export type DictateErrorCode = 'signed-out' | 'resting' | 'not-included' | 'rate-limited' | 'network' | 'bad-key' | 'mic-blocked' | 'mic-busy' | 'needs-download' | 'not-local' | 'unsupported' | 'too-large' | 'bad-model' | 'cancelled';
export class DictateError extends Error {
  readonly code: DictateErrorCode;
  readonly until?: number;
  constructor(code: DictateErrorCode, o: { cause?: unknown; until?: number } = {}) {
    super(code, { cause: o.cause }); this.name = 'DictateError'; this.code = code; this.until = o.until;
  }
}
/** PCM16 mono, 16 kHz, little endian. The app owns permission, capture and microphone arbitration. */
export type AudioFrame = { data: Int16Array; at: number };
export interface AudioMicStream extends AsyncIterable<AudioFrame> {
  /** Stop producing audio, unblock iteration, and yield already captured frames
   * before the iterator ends. Must be idempotent; finish drains, cancel discards.
   */
  stop(): Promise<void> }
export interface AudioMic { open(o: { rate: 16000; purpose: 'dictation'; signal?: AbortSignal }): Promise<AudioMicStream> }
export type DictateInput = Uint8Array | Blob;
export interface DictateEngine {
  readonly info: DictateEngineInfo;
  /** Optional live energy gate: normalized PCM RMS (before the UI's ×4 scale). */
  readonly capture?: { speechThreshold: number; relativeThreshold?: number; silenceMs: number; finalReading?: 'recording' };
  available?(locale?: string): Promise<'ready' | 'needs-download' | 'unsupported' | 'mic-blocked'>;
  transcribe(input: DictateInput, o: DictateOptions): Promise<Omit<DictateTranscript, 'engine'>>;
  /** Throwaway live reading; kept/final text always uses transcribe. */
  preview?(input: DictateInput, o: DictateOptions): Promise<Omit<DictateTranscript, 'engine'>>;
  start?(o: DictateOptions, on: (s: DictateSegment) => void): { stop(): Promise<void>; cancel(): void };
}
export interface DictationHandle {
  on<T extends DictationEvent['type']>(type: T, fn: (e: Extract<DictationEvent, { type: T }>) => void): () => void;
  finish(): Promise<DictateTranscript>;
  cancel(): void;
}
export type DictateSystemNative = {
  available(locale: string): Promise<'ready' | 'needs-download' | 'unsupported' | 'mic-blocked'>;
  start(o: { locale: string; partial: boolean; onDevice: true; punctuation: boolean }, on: (s: DictateSegment) => void): { stop(): Promise<void>; cancel(): void };
  transcribe?(input: DictateInput, o: DictateOptions): Promise<Omit<DictateTranscript, 'engine'>>;
};
