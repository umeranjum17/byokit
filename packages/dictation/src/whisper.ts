import { DictateError, type DictateEngine, type DictateInput, type DictateOptions, type DictateSegment, type DictateTranscript } from './types.ts';
import { mergeOverlap } from './text.ts';

/** Recommended model identity; the host still supplies its file/asset, never a discovered path. */
export const DEFAULT_WHISPER_MODEL = 'base.en-q5_1';

export type WhisperSettings = {
  language?: string;
  initialPrompt?: string;
  vocabulary?: readonly string[];
  threads?: number;
  gain?: number;
  chunkMs?: number;
  beamSize?: number;
  bestOf?: number;
  temperature?: number;
  temperatureInc?: number;
  vad?: { enabled?: boolean; threshold?: number; relativeThreshold?: number; silenceMs?: number; paddingMs?: number };
};
export type ResolvedWhisperSettings = Required<Omit<WhisperSettings, 'vad'>> & { vad: Required<NonNullable<WhisperSettings['vad']>> };

/** Decoder defaults match whisper.rn's greedy path; capture remains app-owned. */
export function whisperSettings(o: WhisperSettings = {}, multilingual = false): ResolvedWhisperSettings {
  if (!Array.isArray(o.vocabulary ?? [])) throw new DictateError('bad-model');
  const s: ResolvedWhisperSettings = {
    language: o.language ?? (multilingual ? 'auto' : 'en'), initialPrompt: o.initialPrompt ?? '', vocabulary: [...(o.vocabulary ?? [])],
    threads: o.threads ?? 6, gain: o.gain ?? 1, chunkMs: o.chunkMs ?? 0,
    beamSize: o.beamSize ?? -1, bestOf: o.bestOf ?? 5, temperature: o.temperature ?? 0, temperatureInc: o.temperatureInc ?? 0.2,
    vad: { enabled: o.vad?.enabled ?? false, threshold: o.vad?.threshold ?? 0.0025, relativeThreshold: o.vad?.relativeThreshold ?? 0.1, silenceMs: o.vad?.silenceMs ?? 500, paddingMs: o.vad?.paddingMs ?? 200 },
  };
  const integer = (n: number, min: number, max: number) => Number.isSafeInteger(n) && n >= min && n <= max;
  const range = (n: number, min: number, max: number) => Number.isFinite(n) && n >= min && n <= max;
  if (!/^(auto|[a-z]{2,3})$/.test(s.language) || typeof s.initialPrompt !== 'string'
    || !Array.isArray(o.vocabulary ?? []) || s.vocabulary.some(w => typeof w !== 'string' || !w.trim())
    || !integer(s.threads, 1, 64) || !range(s.gain, 0.01, 16) || !(s.chunkMs === 0 || integer(s.chunkMs, 100, 30_000))
    || !(s.beamSize === -1 || integer(s.beamSize, 2, 100)) || !integer(s.bestOf, 1, 100)
    || !range(s.temperature, 0, 1) || !range(s.temperatureInc, 0, 1)
    || typeof s.vad.enabled !== 'boolean' || !range(s.vad.threshold, 0, 1)
    || !range(s.vad.relativeThreshold, 0, 1)
    || !integer(s.vad.silenceMs, 20, 10_000) || !integer(s.vad.paddingMs, 0, 5_000)) {
    throw new DictateError('bad-model');
  }
  return s;
}

/** Structural subset of whisper.rn 0.7.2; no runtime or type import of React Native. */
export type WhisperRnDecodeOptions = {
  language: string; maxThreads: number; prompt: string; tokenTimestamps: boolean; maxLen: number;
  audioCtx: 0; beamSize?: number; bestOf: number; temperature: number; temperatureInc: number;
};
export type WhisperRnResult = { result: string; language?: string; isAborted?: boolean; segments: { text: string; t0: number; t1: number }[] };
export type WhisperRnContext = {
  /** Signed PCM16 LE, mono, 16 kHz (not WAV or Float32). */
  transcribeData(data: ArrayBuffer, options: WhisperRnDecodeOptions): { stop(): Promise<void>; promise: Promise<WhisperRnResult> };
  release(): Promise<void>;
};

function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new DictateError('cancelled'); }

/** Strict WAV decoding shared by the phone adapter and desktop fixture runner. */
export async function whisperPcm(input: DictateInput, gain: number): Promise<Int16Array> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new DictateError('too-large');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || view.getUint32(4, true) + 8 !== bytes.length) throw new DictateError('unsupported');
  let valid = false, data: Uint8Array | undefined;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = view.getUint32(at + 4, true), end = at + 8 + size;
    if (end > bytes.length) throw new DictateError('unsupported');
    if (tag(at) === 'fmt ') {
      valid = size >= 16 && view.getUint16(at + 8, true) === 1 && view.getUint16(at + 10, true) === 1
        && view.getUint32(at + 12, true) === 16000 && view.getUint16(at + 20, true) === 2 && view.getUint16(at + 22, true) === 16;
    }
    if (tag(at) === 'data') data = bytes.subarray(at + 8, end);
    at = end + (size % 2);
  }
  if (!valid || !data || data.length % 2) throw new DictateError('unsupported');
  const pcm = new Int16Array(data.length / 2), samples = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(samples.getInt16(i * 2, true) * gain)));
  return pcm;
}

function speechRanges(pcm: Int16Array, s: ResolvedWhisperSettings): [number, number][] {
  if (!s.vad.enabled) return pcm.length ? [[0, pcm.length]] : [];
  const ranges: [number, number][] = [];
  const padding = s.vad.paddingMs * 16, silence = s.vad.silenceMs * 16;
  let start = -1, last = 0;
  const keep = () => {
    const from = Math.max(0, start - padding), to = Math.min(pcm.length, last + padding);
    const previous = ranges.at(-1);
    if (previous && from <= previous[1]) previous[1] = to;
    else ranges.push([from, to]);
    start = -1;
  };
  for (let at = 0; at < pcm.length; at += 320) {
    const end = Math.min(pcm.length, at + 320);
    let sum = 0;
    for (let i = at; i < end; i++) sum += (pcm[i] / 32768) ** 2;
    if (Math.sqrt(sum / (end - at)) > s.vad.threshold) { if (start < 0) start = at; last = end; }
    else if (start >= 0 && end - last >= silence) keep();
  }
  if (start >= 0) keep();
  return ranges;
}

export function whisperDecodeOptions(s: ResolvedWhisperSettings, o: DictateOptions, previous = ''): WhisperRnDecodeOptions {
  const language = o.languages?.[0] ?? s.language;
  // Per-call hints receive the same validation as construction settings.
  whisperSettings({ language, initialPrompt: o.prompt, vocabulary: o.keywords });
  return {
    language, maxThreads: s.threads, audioCtx: 0, tokenTimestamps: false, maxLen: 0,
    prompt: [s.initialPrompt, ...s.vocabulary, o.prompt, ...(o.keywords ?? []), previous.slice(-200), o.punctuation === false ? 'Do not add punctuation.' : ''].filter(Boolean).join(' '),
    ...(s.beamSize > 0 ? { beamSize: s.beamSize } : {}), bestOf: s.bestOf, temperature: s.temperature, temperatureInc: s.temperatureInc,
  };
}

/** Shared segmentation, gain, energy VAD, prompting and timestamp offsets. */
export async function transcribeWhisper(input: DictateInput, s: ResolvedWhisperSettings, o: DictateOptions,
  run: (pcm: Int16Array, options: WhisperRnDecodeOptions) => Promise<WhisperRnResult>): Promise<Omit<DictateTranscript, 'engine'>> {
  checkAbort(o.signal);
  if (o.timestamps === 'word') throw new DictateError('unsupported'); // RN returns segments, not word offsets.
  const pcm = await whisperPcm(input, s.gain);
  checkAbort(o.signal);
  const segments: DictateSegment[] = [];
  let text = '', language: string | undefined;
  const chunkSamples = (s.chunkMs || 30_000) * 16;
  for (const [start, end] of speechRanges(pcm, s)) {
    const prefix = segments.map(segment => segment.text).join(' ');
    const overlap = !s.chunkMs && end - start > chunkSamples ? 5_000 * 16 : 0;
    let rangeText = '';
    for (let at = start; at < end; at += chunkSamples - overlap) {
      checkAbort(o.signal);
      const chunk = pcm.slice(at, Math.min(end, at + chunkSamples));
      // Automatic overlapping windows are fresh final readings. Feeding their
      // overlap back as a prompt makes Whisper suppress it as already-known text.
      const result = await run(chunk, whisperDecodeOptions(s, o, s.chunkMs ? text : ''));
      checkAbort(o.signal);
      if (result.isAborted) throw new DictateError('cancelled');
      language = result.language ?? language;
      rangeText = overlap && at > start ? mergeOverlap(rangeText, result.result) : [rangeText, result.result.trim()].filter(Boolean).join(' ');
      text = [prefix, rangeText].filter(Boolean).join(' ');
      if (overlap) {
        // A merged range has range-level offsets, not fabricated word cuts from
        // native segment metadata. Its text must agree with transcript.text.
        if (at + chunkSamples >= end) {
          segments.push({ id: String(segments.length), text: rangeText, final: true, language, startMs: start / 16, endMs: end / 16 });
          break;
        }
        continue;
      }
      const nativeSegments = result.segments.length ? result.segments : [{ text: result.result, t0: 0, t1: chunk.length / 160 }];
      for (const segment of nativeSegments) {
        segments.push({ id: String(segments.length), text: segment.text.trim(), final: true, language,
          startMs: at / 16 + segment.t0 * 10, endMs: at / 16 + segment.t1 * 10 });
      }
    }
  }
  text = segments.map(segment => segment.text).join(' ').trim();
  return { text, segments, language, durationMs: pcm.length / 16, usage: { audioMs: pcm.length / 16, basis: 'free' } };
}

/** Host injects initWhisper; one cached context, serialized inference, explicit disposal. */
export function whisperRnEngine(o: { model: string | number; multilingual?: boolean; initWhisper(options: { filePath: string | number }): Promise<WhisperRnContext>; settings?: WhisperSettings }): DictateEngine & { release(): Promise<void> } {
  if (!(typeof o.model === 'string' && o.model.trim() && !/^[a-z]+:\/\//i.test(o.model.replace(/^file:\/\//, ''))
    || typeof o.model === 'number' && Number.isSafeInteger(o.model) && o.model >= 0)) throw new DictateError('bad-model');
  const settings = whisperSettings(o.settings, o.multilingual);
  let context: Promise<WhisperRnContext> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = queue.then(fn); queue = result.catch(() => {}); return result;
  };
  const acquire = () => {
    context ??= o.initWhisper({ filePath: o.model }).catch(cause => { context = undefined; throw new DictateError('bad-model', { cause }); });
    return context;
  };
  const transcribe = (input: DictateInput, options: DictateOptions, preview = false) => enqueue(() => transcribeWhisper(input,
    preview ? { ...settings, initialPrompt: '', vocabulary: [] } : settings,
    preview ? { ...options, prompt: undefined, keywords: undefined } : options, async (pcm, decode) => {
      const native = await acquire();
      checkAbort(options.signal);
      // Encode LE explicitly; do not pass a WAV header or rely on host endianness.
      const buffer = new ArrayBuffer(pcm.length * 2), view = new DataView(buffer);
      for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
      const job = native.transcribeData(buffer, decode);
      const abort = () => { void job.stop().catch(() => {}); };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      try { return await job.promise; }
      catch (cause) { checkAbort(options.signal); throw new DictateError('bad-model', { cause }); }
      finally { options.signal?.removeEventListener('abort', abort); }
    }));
  return {
    info: { id: 'whisper', model: String(o.model), onDevice: true, streaming: 'reread', account: 'none' },
    capture: { speechThreshold: settings.vad.threshold / settings.gain, relativeThreshold: settings.vad.relativeThreshold, silenceMs: settings.vad.silenceMs, finalReading: 'recording' },
    transcribe: (input, options) => transcribe(input, options),
    preview: (input, options) => transcribe(input, options, true),
    release: () => enqueue(async () => { const current = context; context = undefined; await (await current)?.release(); }),
  };
}
