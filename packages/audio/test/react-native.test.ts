import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { AudioError, SILERO_VAD_5_1, VAD_CONTEXT, VAD_STATE, VAD_WINDOW, createVad } from '../src/index.ts';
import { sileroSession } from '../src/react-native.ts';
import { ortSession, type OrtRuntime } from '../src/ort-session.ts';
import { sha256Hex } from '../src/sha256.ts';

// A deterministic stand-in for onnxruntime-react-native: a window whose fresh samples are loud scores 0.9, else 0.05,
// and the "recurrent state" counts the windows run. No device, model file or native module is involved.
function fakeRuntime() {
  const log = { created: [] as { model: Uint8Array; options: unknown }[], feeds: [] as Record<string, { type: string; dims: number[] }>[], released: 0 };
  class Tensor {
    type: string; data: ArrayLike<number>; dims: number[];
    constructor(type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) { this.type = type; this.data = data as ArrayLike<number>; this.dims = dims; }
  }
  const runtime = {
    Tensor,
    InferenceSession: {
      async create(model: Uint8Array, options: unknown) {
        log.created.push({ model, options });
        return {
          async run(feeds: Record<string, Tensor>) {
            log.feeds.push(Object.fromEntries(Object.entries(feeds).map(([k, t]) => [k, { type: t.type, dims: t.dims }])));
            const input = feeds.input!.data as Float32Array, state = feeds.state!.data as Float32Array;
            const peak = Math.max(...input.subarray(VAD_CONTEXT).map(Math.abs));
            const next = new Float32Array(VAD_STATE); next[0] = state[0]! + 1;
            return { output: { data: [peak > 0.1 ? 0.9 : 0.05] }, stateN: { data: next } };
          },
          async release() { log.released++; },
        };
      },
    },
  } satisfies OrtRuntime;
  return { runtime, log };
}

test('the React Native entry bundles for a browser platform with no node: import', async () => {
  const out = await build({ entryPoints: [fileURLToPath(new URL('../src/react-native.ts', import.meta.url))], bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent' });
  assert.doesNotMatch(out.outputFiles[0]!.text, /node:|require\(/);
});
