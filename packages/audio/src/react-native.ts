import { AudioError, type VadSession } from './types.ts';
import { checkVadModel } from './model.ts';
import { ortSession, ortWakeSession, type OrtRuntime } from './ort-session.ts';
import type { WakeSession } from './types.ts';
import { sha256Hex } from './sha256.ts';

export type { OrtRuntime } from './ort-session.ts';
export type SileroOptions = {
  /** One thread: this runs beside a recognizer and a UI thread on the same core budget. */
  threads?: number;
};

/**
 * Run the pinned Silero v5.1 graph on `onnxruntime-react-native`, CPU only, mirroring `./node`.
 * The model bytes are the app's own bundled asset; nothing is downloaded or discovered, and the
 * runtime is the app's own optional peer, passed in, so this entry imports no native module.
 */
export async function sileroSession(
  source: Uint8Array | ArrayBuffer,
  runtime: OrtRuntime,
  options: SileroOptions = {},
): Promise<VadSession & { initMs: number }> {
  const threads = options.threads ?? 1;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 8) throw new AudioError('unsupported');
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  checkVadModel({ bytes: bytes.byteLength, sha256: sha256Hex(bytes) });
  return ortSession(bytes, runtime, threads);
}

/**
 * Run the app's own wake graph (contract in `wake.ts`) on `onnxruntime-react-native`, CPU only. No model is
 * bundled or pinned: the bytes are whatever the app supplies, so a graph that breaks the contract surfaces
 * as `bad-model` on the first window rather than being checked here.
 */
export async function wakeSession(source: Uint8Array | ArrayBuffer, runtime: OrtRuntime, options: SileroOptions = {}): Promise<WakeSession> {
  const threads = options.threads ?? 1;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 8) throw new AudioError('unsupported');
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (!bytes.byteLength) throw new AudioError('bad-model');
  return ortWakeSession(bytes, runtime, threads);
}
