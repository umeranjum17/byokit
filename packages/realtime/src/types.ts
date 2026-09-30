import type { RealtimeClientFrame, RealtimeHostFrame, RealtimeAppAction } from './frames.ts';
export type RealtimeProviderId = 'chatgpt' | 'openai' | 'gemini' | 'xai';
export type RealtimeTool = { name: string; description: string; parameters: object };
export type RealtimeUsage = { seconds: number; basis: 'tokens' | 'minutes' | 'subscription'; inputTokens?: number; outputTokens?: number; audioInTokens?: number; audioOutTokens?: number; cachedTokens?: number };
export type RealtimeAuth = { kind: 'key'; key: string } | { kind: 'plan'; access(signal?: AbortSignal): Promise<{ access: string; accountId: string }> };
export type RealtimeConfig = { instructions?: string; model?: string; voice?: string; tools?: RealtimeTool[] };
export type RealtimeErrorCode = 'signed-out' | 'resting' | 'not-included' | 'rate-limited' | 'network' | 'bad-key' | 'expired' | 'protocol' | 'mic-blocked' | 'mic-busy' | 'unsupported';
export class RealtimeError extends Error {
  readonly name = 'RealtimeError';
  readonly code: RealtimeErrorCode;
  readonly detail?: Record<string, unknown>;
  readonly until?: number;
  constructor(code: RealtimeErrorCode, options: { cause?: unknown; detail?: Record<string, unknown>; until?: number } = {}) {
    super(code, { cause: options.cause }); this.code = code; this.detail = options.detail; this.until = options.until;
  }
}
export type RealtimeToolCall = { callId: string; name: string; args: unknown; delegated?: boolean };
export type AudioPorts = {
  microphone: { acquire(): Promise<void>; release(): void };
  capture(rate: number, onData: (base64: string) => void): Promise<{ pending: string[]; release(): Promise<void> }>;
  player: {
    ensure(rate: number): void; bind(sink: PlaybackSink): void; unbind(sink: PlaybackSink): void;
    admit(base64: string): 'ok' | 'malformed' | 'overflow'; clear(): void;
    finish(onDrained?: () => void): boolean; afterDrain(kind: 'connected' | 'speech', run: () => void): boolean;
    stop(): void; release(): void;
  };
  route(): Promise<void>; unroute(): Promise<void>;
};
export type PlaybackSink = { send(frame: RealtimeClientFrame): boolean };
export type RealtimeStream = PlaybackSink & {
  onFrame(fn: (frame: RealtimeHostFrame) => void): void;
  onClose(fn: (reason?: string) => void): void;
  start(): void; close(): void;
};
export type RealtimeClientOptions = {
  open(): Promise<RealtimeStream>; audio: AudioPorts;
  webrtc?: (options: import('./webrtc.ts').WebRtcOptions) => Promise<import('./webrtc.ts').WebRtcHandle>;
  onStatus(status: 'connecting' | 'connected' | 'thinking' | 'speaking' | 'disconnected', reason?: string): void;
  onTurn(role: 'user' | 'agent', text: string): void;
  onActivity?(): void; onLevel?(direction: 'input' | 'output', base64: string): void;
  onStats?(stats: { micCaptured: number; micSent: number; micQueued: number; micDropped: number; transportReconnects: number; providerReconnects: number }): void;
  onUsage?(usage: RealtimeUsage): void;
  onAppRequest?(action: RealtimeAppAction, target?: string): Promise<{ ok: boolean; text: string }>;
};
