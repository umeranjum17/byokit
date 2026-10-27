import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioError, WAKE_HOP, WAKE_RATE, WAKE_WINDOW, createWake } from '../src/index.ts';
import { wakeSession } from '../src/react-native.ts';
import type { OrtRuntime } from '../src/ort-session.ts';

// A deterministic stand-in for onnxruntime-react-native running a caller-supplied wake graph: `score` is the
// peak of the newest hop, so a loud burst "says" the wake word. It checks the documented input contract.
function fakeRuntime(bad?: 'score') {
  const log = { feeds: [] as { type: string; dims: number[] }[], released: 0 };
  class Tensor {
    type: string; data: ArrayLike<number>; dims: number[];
    constructor(type: string, data: ArrayLike<number> | BigInt64Array, dims: number[]) { this.type = type; this.data = data as ArrayLike<number>; this.dims = dims; }
  }
  const runtime = {
    Tensor,
    InferenceSession: {
      async create() {
        return {
          async run(feeds: Record<string, Tensor>) {
            const audio = feeds.audio!; log.feeds.push({ type: audio.type, dims: audio.dims });
            const tail = (audio.data as Float32Array).subarray(WAKE_WINDOW - WAKE_HOP);
            return { score: { data: bad ? [Number.NaN] : [Math.max(...tail.map(Math.abs)) > 0.1 ? 0.9 : 0.05] } };
          },
          async release() { log.released++; },
        };
      },
    },
  } satisfies OrtRuntime;
  return { runtime, log };
}

test('the wake word fires once per utterance on the Android session, with cooldown and the documented feed', async () => {
  const { runtime, log } = fakeRuntime(), wake = createWake({ session: await wakeSession(new Uint8Array([1]), runtime) });
  const pcm = new Int16Array(WAKE_RATE * 6);
  pcm.fill(20000, WAKE_RATE, WAKE_RATE * 1.5); // burst A at 1.0-1.5 s
  pcm.fill(20000, WAKE_RATE * 1.8, WAKE_RATE * 2.2); // burst B inside the 2 s cooldown
  pcm.fill(20000, WAKE_RATE * 4, WAKE_RATE * 4.5); // burst C after it
  const hits: number[] = [];
  for (let i = 0; i < pcm.length; i += 777) hits.push(...(await wake.push(pcm.subarray(i, i + 777))).map((d) => d.atMs)); // odd chunking
  assert.equal(hits.length, 2, `${hits}`);
  assert.ok(hits[0]! >= 1000 && hits[0]! < 1400 && hits[1]! >= 4000 && hits[1]! < 4400, `${hits}`);
  assert.deepEqual(log.feeds[0], { type: 'float32', dims: [1, WAKE_WINDOW] });
  await wake.release(); assert.equal(log.released, 1);
});

test('a single loud hop is below patience; bad graphs and bad input are refused', async () => {
  const { runtime } = fakeRuntime(), wake = createWake({ session: await wakeSession(new Uint8Array([1]), runtime), patience: 2 });
  const blip = new Int16Array(WAKE_HOP * 4); blip.fill(20000, WAKE_HOP, WAKE_HOP * 2);
  assert.deepEqual(await wake.push(blip), []);
  await assert.rejects(wake.push(new Float32Array(1) as never), (e: unknown) => e instanceof AudioError && e.code === 'unsupported');
  const broken = createWake({ session: await wakeSession(new Uint8Array([1]), fakeRuntime('score').runtime) });
  await assert.rejects(broken.push(new Int16Array(WAKE_HOP)), (e: unknown) => e instanceof AudioError && e.code === 'bad-model');
  for (const threads of [0, 9]) await assert.rejects(wakeSession(new Uint8Array(1), runtime, { threads }), (e: unknown) => e instanceof AudioError && e.code === 'unsupported');
  await assert.rejects(wakeSession(new Uint8Array(0), runtime), (e: unknown) => e instanceof AudioError && e.code === 'bad-model');
  assert.throws(() => createWake({ session: { run: async () => 0 }, threshold: 1 }), (e: unknown) => e instanceof AudioError);
});
