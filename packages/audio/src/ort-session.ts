import { AudioError, type VadSession, type WakeSession } from './types.ts';
import { VAD_CONTEXT, VAD_RATE, VAD_STATE, VAD_WINDOW } from './vad.ts';
import { WAKE_WINDOW } from './wake.ts';

/** The parts of `onnxruntime-react-native` this adapter uses (its `InferenceSession.create` takes the
 * model bytes directly), so a host can hand in its own runtime. */
export type OrtRuntime = {
  InferenceSession: {
    create(model: Uint8Array, options: { executionProviders: string[]; graphOptimizationLevel?: string; intraOpNumThreads?: number; interOpNumThreads?: number }): Promise<{
      run(feeds: Record<string, { data: ArrayLike<number> | BigInt64Array; type: string; dims?: number[] }>): Promise<Record<string, { data: ArrayLike<number> }>>;
      release?(): Promise<void>;
    }>;
  };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) => { data: ArrayLike<number>; type: string; dims: number[] };
};

/** Run already-verified Silero bytes on `runtime`; the feeds are the ones `./node` sends. */
export async function ortSession(bytes: Uint8Array, runtime: OrtRuntime, threads: number): Promise<VadSession & { initMs: number }> {
  const started = performance.now();
  const { Tensor } = runtime;
  const session = await open(bytes, runtime, threads);
  const rate = BigInt64Array.from([BigInt(VAD_RATE)]);
  return {
    initMs: performance.now() - started,
    async run(window, state) {
      const out = await session.run({
        input: new Tensor('float32', window, [1, VAD_CONTEXT + VAD_WINDOW]),
        state: new Tensor('float32', state ?? new Float32Array(VAD_STATE), [2, 1, VAD_STATE / 2]),
        sr: new Tensor('int64', rate, []),
      });
      const probability = Number(out.output?.data[0]), next = out.stateN?.data;
      if (typeof next?.length !== 'number' || !Number.isFinite(probability)) throw new AudioError('bad-model');
      return { probability, state: Float32Array.from(next) };
    },
    async release() { await session.release?.(); },
  };
}

async function open(bytes: Uint8Array, { InferenceSession }: OrtRuntime, threads: number) {
  try {
    return await InferenceSession.create(bytes, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: threads });
  } catch (cause) { throw new AudioError('bad-model', { cause }); }
}

/** Run a caller-supplied wake graph (contract in `wake.ts`): `audio` float32 [1, WAKE_WINDOW] in, `score` out. */
export async function ortWakeSession(bytes: Uint8Array, runtime: OrtRuntime, threads: number): Promise<WakeSession> {
  const session = await open(bytes, runtime, threads);
  return {
    async run(window) {
      const out = await session.run({ audio: new runtime.Tensor('float32', window, [1, WAKE_WINDOW]) });
      const score = Number(out.score?.data[0]);
      if (!Number.isFinite(score)) throw new AudioError('bad-model');
      return score;
    },
    async release() { await session.release?.(); },
  };
}
