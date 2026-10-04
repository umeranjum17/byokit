export type AudioErrorCode = 'bad-model' | 'unsupported' | 'too-large' | 'cancelled';
export class AudioError extends Error {
  readonly code: AudioErrorCode;
  constructor(code: AudioErrorCode, o: { cause?: unknown } = {}) {
    super(code, { cause: o.cause }); this.name = 'AudioError'; this.code = code;
  }
}
/**
 * The one seam between the kit and an ONNX runtime: the host runs the graph,
 * the kit owns the audio framing, the carried context, the recurrent state and
 * the segment decisions. A host supplies no microphone, model path or credential.
 * A session carries recurrent state, so one stream gets one session.
 */
export interface VadSession {
  /** One window of `VAD_CONTEXT` carried samples followed by `VAD_WINDOW` fresh
   * samples, scaled to [-1, 1]. `state` is null for the first window of a stream.
   * Returns the speech probability and the recurrent state to feed the next window. */
  run(window: Float32Array, state: Float32Array | null): Promise<{ probability: number; state: Float32Array }>;
  release?(): Promise<void> | void;
}