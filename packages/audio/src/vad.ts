import { AudioError, type VadSession } from './types.ts';

export const VAD_RATE = 16000;
export const VAD_WINDOW = 512;
export const VAD_CONTEXT = 64;
export const VAD_STATE = 256;
/** The upstream untuned default. Measured best on this repository's own fixture corpus;
 * lowering it trades a real false-trigger win for a few points of missed speech. */
export const VAD_THRESHOLD = 0.5;

export type VadOptions = {
  session: VadSession;
  /** Speech probability at or above which a window is speech. Finite in (0, 1); defaults to `VAD_THRESHOLD`. */
  threshold?: number;
  /** Silence that closes a segment, in milliseconds. Integer in [20, 10000]; defaults to 500. */
  silenceMs?: number;
  /** Padding kept on both sides of a segment, in milliseconds. Integer in [0, 5000]; defaults to 200. */
  paddingMs?: number;
};
export type VadFrame = { startMs: number; endMs: number; probability: number; speech: boolean };
export interface Vad {
  /** Feed signed PCM16 mono at `VAD_RATE`. Any length is accepted; only whole windows are scored. */
  push(pcm: Int16Array): Promise<VadFrame[]>;
  /** Score the trailing partial window with zero padding, as the published wrapper does. */
  flush(): Promise<VadFrame[]>;
  /** Speech segments with hangover and padding applied, in milliseconds. */
  ranges(): [number, number][];
  /** Drop buffered audio, carried context, recurrent state and open segments. */
  reset(): void;
  /** Dispose this detector and the session it was created with. The session carries
   * recurrent state, so a host that runs two streams at once hands out one session each. */
  release(): Promise<void>;
}

export function vadOptions(o: VadOptions): Required<VadOptions> {
  const threshold = o.threshold ?? VAD_THRESHOLD, silenceMs = o.silenceMs ?? 500, paddingMs = o.paddingMs ?? 200;
  if (!o.session || typeof o.session.run !== 'function'
    || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1
    || !Number.isSafeInteger(silenceMs) || silenceMs < 20 || silenceMs > 10_000
    || !Number.isSafeInteger(paddingMs) || paddingMs < 0 || paddingMs > 5_000) throw new AudioError('unsupported');
  return { session: o.session, threshold, silenceMs, paddingMs };
}

/**
 * Streaming speech detection over one host-run graph. Every decision a consumer
 * sees - window boundaries, hangover, padding, merge - happens here, so on-device
 * behaviour is identical on every platform and only inference moves across the seam.
 */
export function createVad(options: VadOptions): Vad {
  const o = vadOptions(options);
  const silence = o.silenceMs * VAD_RATE / 1000, padding = o.paddingMs * VAD_RATE / 1000;
  let context = new Float32Array(VAD_CONTEXT), state: Float32Array | null = null;
  let pending = new Int16Array(0), cursor = 0, seen = 0, fed = 0, speechAt = -1, last = 0;
  let closed: [number, number][] = [];
  // Clamp to real audio: the zero-padded tail window must not claim samples that were
  // never fed, or a consumer would be handed a range it cannot read.
  const open = (): [number, number] => [Math.max(0, speechAt - padding), Math.min(fed, last + padding)];
  const ranges = (): [number, number][] => {
    const all = speechAt < 0 ? [...closed] : [...closed, open()];
    const merged: [number, number][] = [];
    for (const range of all.sort((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
      else merged.push([...range] as [number, number]);
    }
    return merged;
  };
  async function step(count: number): Promise<VadFrame> {
    const window = new Float32Array(VAD_CONTEXT + VAD_WINDOW);
    for (let i = 0; i < VAD_CONTEXT; i++) window[i] = context[i];
    for (let i = 0; i < VAD_WINDOW; i++) window[VAD_CONTEXT + i] = (i < count ? pending[cursor + i] : 0) / 32768;
    const { probability, state: next } = await o.session.run(window, state);
    if (!Number.isFinite(probability) || !(next instanceof Float32Array) || next.length !== VAD_STATE) throw new AudioError('bad-model');
    state = next; context = window.subarray(VAD_WINDOW);
    const start = seen, end = seen + VAD_WINDOW, speech = probability >= o.threshold;
    seen = end; cursor += count;
    if (speech) { if (speechAt < 0) speechAt = start; last = end; }
    else if (speechAt >= 0 && end - last >= silence) { closed.push(open()); speechAt = -1; }
    return { startMs: start / VAD_RATE * 1000, endMs: end / VAD_RATE * 1000, probability, speech };
  }
  return {
    async push(pcm: Int16Array) {
      if (!(pcm instanceof Int16Array)) throw new AudioError('unsupported');
      if (!pcm.length) return [];
      fed += pcm.length;
      if (cursor) { pending = pending.slice(cursor); cursor = 0; }
      const buffered = new Int16Array(pending.length + pcm.length);
      buffered.set(pending); buffered.set(pcm, pending.length); pending = buffered;
      const frames: VadFrame[] = [];
      while (pending.length - cursor >= VAD_WINDOW) frames.push(await step(VAD_WINDOW));
      return frames;
    },
    async flush() { return pending.length - cursor ? [await step(pending.length - cursor)] : []; },
    ranges() { return ranges().map(([from, to]) => [from / VAD_RATE * 1000, to / VAD_RATE * 1000]); },
    reset() { context = new Float32Array(VAD_CONTEXT); state = null; pending = new Int16Array(0); cursor = seen = fed = speechAt = last = 0; closed = []; },
    async release() { this.reset(); await o.session.release?.(); },
  };
}