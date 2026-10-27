import { AudioError, type WakeSession } from './types.ts';

/**
 * The graph contract a wake model must meet (the kit bundles none):
 * input `audio`, float32 [1, WAKE_WINDOW]: the trailing 1.5 s of 16 kHz mono PCM scaled to [-1, 1],
 * zero-filled before the stream began; output `score`, float32, first element a wake score in [0, 1].
 * The graph is stateless and does its own feature extraction; it is scored once per `WAKE_HOP`.
 */
export const WAKE_RATE = 16000;
export const WAKE_HOP = 1280;
export const WAKE_WINDOW = 24000;

export type WakeOptions = {
  session: WakeSession;
  /** Score at or above which a hop counts. Finite in (0, 1); defaults to 0.5. */
  threshold?: number;
  /** Consecutive hops at or above the threshold that make a detection (80 ms each). Integer in [1, 20]; defaults to 2. */
  patience?: number;
  /** Silence after a detection during which none is reported, in milliseconds. Integer in [0, 60000]; defaults to 2000. */
  cooldownMs?: number;
};
export type WakeDetection = { atMs: number; score: number };
export interface Wake {
  /** Feed signed PCM16 mono at `WAKE_RATE`, any length. Returns the detections completed by this audio. */
  push(pcm: Int16Array): Promise<WakeDetection[]>;
  /** Drop buffered audio and the hit streak; the session is kept. */
  reset(): void;
  /** Dispose this detector and its session. */
  release(): Promise<void>;
}

/** Streaming wake-word detection over one host-run graph; every decision a consumer sees is made here. */
export function createWake(options: WakeOptions): Wake {
  const { session, threshold = 0.5, patience = 2, cooldownMs = 2000 } = options;
  if (!session || typeof session.run !== 'function'
    || !Number.isFinite(threshold) || threshold <= 0 || threshold >= 1
    || !Number.isSafeInteger(patience) || patience < 1 || patience > 20
    || !Number.isSafeInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 60_000) throw new AudioError('unsupported');
  const cooldown = cooldownMs * WAKE_RATE / 1000;
  let window = new Float32Array(WAKE_WINDOW), fresh = 0, seen = 0, streak = 0, quietUntil = 0;
  return {
    async push(pcm) {
      if (!(pcm instanceof Int16Array)) throw new AudioError('unsupported');
      const found: WakeDetection[] = [];
      for (let i = 0; i < pcm.length;) {
        const take = Math.min(WAKE_HOP - fresh, pcm.length - i);
        // Slide by whole samples: the newest `fresh` samples sit at the end of the window.
        if (fresh === 0) window.copyWithin(0, WAKE_HOP);
        for (let j = 0; j < take; j++) window[WAKE_WINDOW - WAKE_HOP + fresh + j] = pcm[i + j]! / 32768;
        fresh += take; i += take; seen += take;
        if (fresh < WAKE_HOP) break;
        fresh = 0;
        const score = await session.run(window);
        if (!Number.isFinite(score) || score < 0 || score > 1) throw new AudioError('bad-model');
        streak = score >= threshold ? streak + 1 : 0;
        if (streak >= patience && seen >= quietUntil) {
          found.push({ atMs: seen / WAKE_RATE * 1000, score });
          streak = 0; quietUntil = seen + cooldown;
        }
      }
      return found;
    },
    reset() { window = new Float32Array(WAKE_WINDOW); fresh = seen = streak = quietUntil = 0; },
    async release() { this.reset(); await session.release?.(); },
  };
}
