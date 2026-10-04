import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { AudioError, type VadSession } from './types.ts';
import { checkVadModel } from './model.ts';
import { VAD_CONTEXT, VAD_RATE, VAD_STATE, VAD_WINDOW } from './vad.ts';

/** The parts of `onnxruntime-node` this adapter uses, so a host can hand its own
 * session in instead of installing the published runtime. */
export type OnnxRuntime = {
  InferenceSession: {
    create(path: string, options: { executionProviders: string[]; graphOptimizationLevel?: string; intraOpNumThreads?: number; interOpNumThreads?: number }): Promise<{
      run(feeds: Record<string, { data: ArrayLike<number> | BigInt64Array; type: string; dims?: number[] }>): Promise<Record<string, { data: ArrayLike<number> }>>;
      release?(): Promise<void>;
    }>;
  };
  Tensor: new (type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) => { data: ArrayLike<number>; type: string; dims: number[] };
};

export type SileroOptions = {
  /** One thread: this runs beside a recognizer and a UI thread on the same core budget. */
  threads?: number;
};

/**
 * Run the pinned Silero v5.1 graph on `onnxruntime-node`, CPU only.
 * The model bytes are the app's own file or buffer; nothing is downloaded or discovered.
 */
export async function sileroSession(
  source: string | Uint8Array | ArrayBuffer,
  runtime: OnnxRuntime,
  options: SileroOptions = {},
): Promise<VadSession & { initMs: number }> {
  const threads = options.threads ?? 1;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 8) throw new AudioError('unsupported');
  let bytes: Uint8Array, path: string | undefined;
  if (typeof source === 'string') {
    path = source;
    try { bytes = new Uint8Array(await readFile(source)); }
    catch (cause) { throw new AudioError('bad-model', { cause }); }
  } else bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  checkVadModel({ bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') });
  const started = performance.now();
  const { Tensor, InferenceSession } = runtime;
  // onnxruntime-node needs a path; bytes the app already holds are written next to
  // the process rather than fetched, so a network call can never enter this path.
  const file = path ?? await writeTemp(bytes);
  let session;
  try {
    session = await InferenceSession.create(file, { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: threads, interOpNumThreads: threads });
  } catch (cause) { if (!path) await removeTemp(file); throw new AudioError('bad-model', { cause }); }
  const rate = BigInt64Array.from([BigInt(VAD_RATE)]);
  return {
    initMs: performance.now() - started,
    async run(window, state) {
      const out = await session.run({
        input: new Tensor('float32', window, [1, VAD_CONTEXT + VAD_WINDOW]),
        state: new Tensor('float32', state ?? new Float32Array(VAD_STATE), [2, 1, VAD_STATE / 2]),
        sr: new Tensor('int64', rate, []),
      });
      const probability = Number(out.output.data[0]), next = out.stateN?.data;
      if (typeof next?.length !== 'number') throw new AudioError('bad-model');
      return { probability, state: Float32Array.from(next) };
    },
    async release() { try { await session.release?.(); } finally { if (!path) await removeTemp(file); } },
  };
}

async function writeTemp(bytes: Uint8Array): Promise<string> {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'byokit-vad-'));
  const file = join(dir, 'silero.onnx');
  try { await writeFile(file, bytes); } catch (cause) { await rm(dir, { recursive: true, force: true }); throw cause; }
  return file;
}
async function removeTemp(file: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  await rm(dirname(file), { recursive: true, force: true });
}