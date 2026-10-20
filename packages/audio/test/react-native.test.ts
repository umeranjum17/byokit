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

test('the session feeds the graph its published inputs and carries state between windows', async () => {
  const { runtime, log } = fakeRuntime(), bytes = new Uint8Array([1, 2, 3]);
  const session = await ortSession(bytes, runtime, 1);
  const first = await session.run(new Float32Array(VAD_CONTEXT + VAD_WINDOW).fill(0.5), null);
  const second = await session.run(new Float32Array(VAD_CONTEXT + VAD_WINDOW), first.state);
  assert.equal(first.probability, 0.9); assert.equal(second.probability, 0.05);
  assert.equal(first.state[0], 1); assert.equal(second.state[0], 2);
  assert.equal(log.created[0]!.model, bytes);
  assert.deepEqual(log.created[0]!.options, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 1, interOpNumThreads: 1 });
  assert.deepEqual(log.feeds[0], { input: { type: 'float32', dims: [1, VAD_CONTEXT + VAD_WINDOW] }, state: { type: 'float32', dims: [2, 1, VAD_STATE / 2] }, sr: { type: 'int64', dims: [] } });
  await session.release?.(); assert.equal(log.released, 1);
});

test('the kit segments speech identically through the React Native session', async () => {
  const { runtime } = fakeRuntime(), vad = createVad({ session: await ortSession(new Uint8Array(1), runtime, 1), paddingMs: 0, silenceMs: 100 });
  const pcm = new Int16Array(16000 * 3);
  pcm.fill(20000, 16000, 32000); // loud second 1 of 3
  await vad.push(pcm); await vad.flush();
  const [[start, end]] = vad.ranges() as [[number, number]];
  assert.ok(Math.abs(start - 1000) <= 32 && Math.abs(end - 2000) <= 132, `${start}..${end}`);
  await vad.release();
});

test('bytes that are not the pinned graph are refused before the runtime is touched', async () => {
  const { runtime, log } = fakeRuntime();
  for (const source of [new Uint8Array(SILERO_VAD_5_1.bytes), new Uint8Array(10).buffer, new Uint8Array(0)]) {
    await assert.rejects(sileroSession(source, runtime), (e: unknown) => e instanceof AudioError && e.code === 'bad-model');
  }
  for (const threads of [0, 9, 1.5]) await assert.rejects(sileroSession(new Uint8Array(1), runtime, { threads }), (e: unknown) => e instanceof AudioError && e.code === 'unsupported');
  assert.equal(log.created.length, 0);
});

test('a runtime that cannot load the graph is a bad-model error', async () => {
  const runtime: OrtRuntime = { Tensor: fakeRuntime().runtime.Tensor, InferenceSession: { create: async () => { throw new Error('native'); } } };
  await assert.rejects(ortSession(new Uint8Array(1), runtime, 1), (e: unknown) => e instanceof AudioError && e.code === 'bad-model');
});

test('the pure-JS SHA-256 matches node:crypto, including padding edges', () => {
  for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 100_000]) {
    const b = randomBytes(n); assert.equal(sha256Hex(b), createHash('sha256').update(b).digest('hex'), `${n} bytes`);
  }
  assert.equal(sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the React Native entry bundles for a browser platform with no node: import', async () => {
  const out = await build({ entryPoints: [fileURLToPath(new URL('../src/react-native.ts', import.meta.url))], bundle: true, platform: 'neutral', format: 'esm', write: false, logLevel: 'silent' });
  assert.doesNotMatch(out.outputFiles[0]!.text, /node:|require\(/);
});
