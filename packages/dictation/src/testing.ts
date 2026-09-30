import type { DictateEngine, DictateEngineInfo, DictateTranscript, AudioFrame, AudioMic } from './types.ts';
/** Offline engine: records inference calls for silence/cancellation flow assertions. */
export function fakeEngine(readings: string[], info: Partial<DictateEngineInfo> = {}) {
  const calls: Uint8Array[] = [];
  const engine: DictateEngine = {
    info: { id: 'whisper', onDevice: true, account: 'none', streaming: 'reread', ...info },
    async transcribe(input) {
      calls.push(input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input);
      const text = readings[Math.min(calls.length - 1, readings.length - 1)] ?? '';
      const result: Omit<DictateTranscript, 'engine'> = { text, segments: [{ id: '0', text, final: true }], usage: { audioMs: 0, basis: 'free' } };
      return result;
    },
  };
  return { engine, calls };
}
/** Push-driven microphone; stop unblocks an outstanding iterator read. */
export function fakeMic() {
  const queue: AudioFrame[] = [];
  let wake: (() => void) | undefined, stopped = false, stops = 0;
  const audio: AudioMic = { async open() {
    return {
      async stop() { if (!stopped) { stops++; stopped = true; wake?.(); } },
      async *[Symbol.asyncIterator]() {
        while (!stopped) {
          if (!queue.length) await new Promise<void>(r => { wake = r; });
          wake = undefined;
          if (!stopped && queue.length) yield queue.shift()!;
        }
      },
    };
  } };
  return { audio, push(frame: AudioFrame) { queue.push(frame); wake?.(); }, get stops() { return stops; } };
}
