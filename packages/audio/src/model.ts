import { AudioError } from './types.ts';

/**
 * The measured winner, pinned by content. The app supplies these bytes from its own
 * store; the kit never downloads a model, and no microphone or credential is involved.
 * Provenance: published tag `v5.1` of snakers4/silero-vad, plain MIT, pretrained VAD
 * stated unrestricted by upstream. See README.md for the measurement that chose it.
 */
export const SILERO_VAD_5_1 = {
  id: 'silero-vad-5.1',
  url: 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1/src/silero_vad/data/silero_vad.onnx',
  bytes: 2_327_524,
  sha256: '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f',
} as const;

/** Reject bytes that are not the pinned graph before any inference runs: a different
 * or truncated graph segments silently and wrongly, which no later check would catch. */
export function checkVadModel(found: { bytes: number; sha256: string }): void {
  if (found.bytes !== SILERO_VAD_5_1.bytes || found.sha256.toLowerCase() !== SILERO_VAD_5_1.sha256) throw new AudioError('bad-model');
}