// Consumer journeys for the published @byokit/dictation surface, driven the way a host app uses it. Every import is a
// published entry (`@byokit/dictation`, `/node`, `/testing`) or the published `@byokit/audio`; no src, no internals. The
// seams are the ones the README documents: ./testing's fake mic/engine, an app-supplied native recognizer, whisper.rn's
// initWhisper, a host-run VAD session, an explicit provider key/endpoint, and an explicitly passed whisper.cpp binary.
// The security and correctness contracts the old unit, mock-heavy and fixture cases held survive as assertions inside a
// journey: previews never leak the final replacement and finishing never re-reads unchanged speech; cancelling returns
// nothing and releases capture; a local-only request refuses a remote engine without ever reading its credential; the
// on-device phone path clips to the PCM rails, carries every sample into the decoder exactly once, bounds its settings
// and capture limit, and gates silence with either the energy gate or a supplied neural detector; provider engines use
// exactly the caller's credential and an arbitrary endpoint is refused; the app-passed CLI runs with no environment and
// leaves no temporary audio; the word-error-rate harness measures the committed fixtures against their committed
// baselines through the installed CLI and gate; and the entry bundles and runs for a phone with no Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, chmod, readFile, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import fixture from '../../../fixtures/conformance/dictation-typescript.json' with { type: 'json' };
import { Dictation, DictateError, settleWords, applyWordReplacements, routes, systemEngine, whisperRnEngine, whisperSettings, installModel, type WhisperRnContext, type WhisperRnDecodeOptions } from '@byokit/dictation';
import { chatgptEngine, openaiEngine, openrouterEngine, whisperEngine } from '@byokit/dictation/node';
import { fakeEngine, fakeMic } from '@byokit/dictation/testing';
import { createVad, VAD_STATE, VAD_WINDOW, type VadSession } from '@byokit/audio';

const run = promisify(execFile);
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.ok(fn(), 'flow did not reach checkpoint'); }
/** WAV transport identical to the kit's own, for the app-injected PCM the host would record. */
function wav(samples: readonly Int16Array[]): Uint8Array {
  const count = samples.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(44 + count * 2), v = new DataView(out.buffer);
  const str = (at: number, s: string) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); v.setUint32(4, out.length - 8, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, count * 2, true);
  let at = 44; for (const s of samples) for (const x of s) { v.setInt16(at, x, true); at += 2; }
  return out;
}
const wavOf = (name: string) => readFileSync(join(import.meta.dirname, '..', 'fixtures', 'wer', 'regression', `${name}.wav`));
function decodePcm(bytes: Uint8Array): Int16Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = (bytes.length - 44) / 2, pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) pcm[i] = view.getInt16(44 + i * 2, true);
  return pcm;
}
const stubContext = () => ({ transcribeData: () => ({ stop: async () => {}, promise: Promise.resolve({ result: '', segments: [] }) }), release: async () => {} }) as WhisperRnContext;

test('a person dictates and the app finalizes exactly the words shown; a local-only request reads no credential', async () => {
  // The shared conformance fixture owns partial stability and whole-word final replacements.
  for (const f of fixture.partials) assert.equal(settleWords(f.shown, f.previous, f.next), f.want);
  // A live take that starts silent then speaks: two silence readings show the sentinel, then it drops when words
  // arrive; a sentinel between two spoken parts never sticks, and a silence-only take keeps showing it.
  const silentThenSpeech = settleWords(settleWords('', '', '[BLANK_AUDIO]'), '[BLANK_AUDIO]', '[BLANK_AUDIO]');
  assert.equal(silentThenSpeech, '[BLANK_AUDIO]');
  assert.equal(settleWords(silentThenSpeech, '[BLANK_AUDIO]', 'Okay so the dictation'), '');
  const spoken = settleWords('', 'Okay so the dictation quality', 'Okay so the dictation quality');
  assert.equal(spoken, 'Okay so the dictation quality');
  assert.equal(settleWords(spoken, 'Okay so the dictation quality', '[BLANK_AUDIO]'), 'Okay so the dictation quality');
  assert.equal(applyWordReplacements(fixture.replacements.text, fixture.replacements.map), fixture.replacements.want);
  assert.equal(applyWordReplacements('c++ is useful, ac++b', { 'c++': 'C Plus Plus' }), 'C Plus Plus is useful, ac++b');
  assert.deepEqual(routes().filter(r => r.offer).map(r => r.id), ['system', 'whisper', 'chatgpt']);

  // Live reread: previews never show the replacement, finishing corrects, and unchanged speech is not re-read.
  const mic = fakeMic(), fake = fakeEngine(['hello kit', 'hello kit again']);
  const dictation = new Dictation({ engine: fake.engine, audio: mic.audio });
  const handle = dictation.listen({ replacements: { kit: 'app' } });
  const partials: string[] = [], finals: string[] = [];
  handle.on('partial', e => partials.push(e.segment.text));
  handle.on('final', e => finals.push(e.segment.text));
  await tick();
  mic.push({ data: new Int16Array(16000).fill(1000), at: 0 }); await until(() => fake.calls.length === 1);
  mic.push({ data: new Int16Array(16000).fill(1000), at: 1000 }); await until(() => fake.calls.length === 2);
  mic.push({ data: new Int16Array(8000), at: 2000 }); await until(() => finals.length === 1);
  const reads = fake.calls.length;
  const finishing = handle.finish(); assert.equal(handle.finish(), finishing);
  const result = await finishing;
  assert.equal(fake.calls.length, reads); assert.equal(result.text, 'hello app again');
  assert.ok(partials.includes('hello kit')); assert.ok(!partials.join(' ').includes('app'));
  assert.equal(result.usage.audioMs, 2500); assert.equal(mic.stops, 1); assert.equal(dictation.state.phase, 'idle');
  const silent = fakeMic(), empty = fakeEngine(['uh']);
  const stop = new Dictation({ engine: empty.engine, audio: silent.audio }).listen(); await tick();
  silent.push({ data: new Int16Array(16000), at: 0 }); await tick(); await tick();
  assert.equal((await stop.finish()).text, ''); assert.equal(empty.calls.length, 0);

  // Cancel aborts an in-flight reading and releases capture without returning words.
  const cancelMic = fakeMic(), blocking = fakeEngine([]);
  let entered = false;
  blocking.engine.transcribe = async (_input, options) => {
    entered = true;
    await new Promise<void>(r => options.signal!.addEventListener('abort', () => r(), { once: true }));
    return { text: 'discard me', segments: [], usage: { audioMs: 1000, basis: 'free' } };
  };
  const cancelling = new Dictation({ engine: blocking.engine, audio: cancelMic.audio });
  const cHandle = cancelling.listen(); await tick();
  cancelMic.push({ data: new Int16Array(16000).fill(1000), at: 0 }); await until(() => entered);
  cHandle.cancel(); await assert.rejects(cHandle.finish(), (e: DictateError) => e.code === 'cancelled');
  assert.equal(cancelMic.stops, 1); assert.equal(cancelling.state.phase, 'idle');

  // The app's own native recognizer: on-device flag, settled finals, missing packs; local-only never reads a credential.
  let emit!: (s: { id: string; text: string; final: boolean; startMs?: number; endMs?: number }) => void;
  const native = systemEngine({
    available: async locale => locale === 'xx' ? 'needs-download' : 'ready',
    start(o, on) {
      assert.equal(o.onDevice, true); assert.equal(o.punctuation, false); emit = on;
      return { async stop() { on({ id: '0', text: 'hello kit', final: true, startMs: 0, endMs: 1000 }); }, cancel() {} };
    },
  });
  const nativeDictation = new Dictation({ engine: native });
  assert.deepEqual(await nativeDictation.available({ locale: 'xx' }), { ok: false, code: 'needs-download' });
  const nHandle = nativeDictation.listen({ onDeviceOnly: true, punctuation: false, replacements: { kit: 'app' } }); await tick();
  emit({ id: '0', text: 'hello kit', final: false }); emit({ id: '0', text: 'hello kit again', final: false });
  assert.equal((await nHandle.finish()).text, 'hello app');
  let accesses = 0;
  const remote = new Dictation({ engine: chatgptEngine({ access: async () => { accesses++; return { access: 'must-not-be-read' }; } }) });
  await assert.rejects(remote.transcribe(new Uint8Array(), { onDeviceOnly: true }), (e: DictateError) => e.code === 'not-local');
  assert.equal(accesses, 0);

  // The same published entry bundles and runs for a browser / React Native phone with no Node.
  const bundled = await build({
    stdin: { contents: `import { routes, settleWords } from '@byokit/dictation';
      globalThis.result = { ids: routes().map(r => r.id), settled: settleWords('', 'hello world', 'Hello world again') };`,
      resolveDir: import.meta.dirname, sourcefile: 'phone-dictation.ts' },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, metafile: true, logLevel: 'silent',
  });
  assert.ok(Object.keys(bundled.metafile!.inputs).every(p => !p.includes('/node.') && !p.includes('/worker.') && !p.includes('/wer.') && !p.includes('whisper.rn')));
  const sandbox: any = {};
  runInNewContext(bundled.outputFiles[0].text, sandbox);
  assert.deepEqual(Array.from(sandbox.result.ids as string[]), ['system', 'whisper', 'chatgpt', 'openai', 'openrouter']);
  assert.equal(sandbox.result.settled, 'Hello world');
});

test('a phone transcribes offline with whisper.rn: bounded settings, exact PCM at the rails, real VAD gating', async () => {
  // Settings the app gets wrong are refused before native access.
  assert.equal(whisperSettings({}, true).language, 'auto');
  const invalid: object[] = [{ threads: 0 }, { threads: 65 }, { gain: NaN }, { gain: 0 }, { chunkMs: 30001 }, { chunkMs: 99 },
    { beamSize: 1 }, { beamSize: 0 }, { bestOf: 0 }, { temperature: -1 }, { temperatureInc: Infinity }, { language: 'en-US' },
    { vocabulary: [''] }, { vad: { threshold: 1.1 } }, { vad: { relativeThreshold: 1.1 } }, { vad: { silenceMs: 0 } }, { vad: { paddingMs: -1 } }];
  for (const settings of invalid) assert.throws(() => whisperSettings(settings), (e: DictateError) => e.code === 'bad-model');
  for (const model of ['', 'https://example.com/model.bin', -1]) {
    assert.throws(() => whisperRnEngine({ model, initWhisper: async () => { throw new Error('never reached'); } }), (e: DictateError) => e.code === 'bad-model');
  }

  // Gain clips at the PCM rails, chunk offsets align, the app's vocabulary/prompt reach the decoder, model loads once.
  const calls: { bytes: ArrayBuffer; decode: WhisperRnDecodeOptions }[] = [];
  let loads = 0, releases = 0;
  const engine = whisperRnEngine({ model: 42, settings: { gain: 2, chunkMs: 100, language: 'en', initialPrompt: 'Hint.', vocabulary: ['Byokit'], beamSize: 5, bestOf: 3, temperature: 0.1, temperatureInc: 0 },
    async initWhisper(options) {
      loads++; assert.equal(options.filePath, 42);
      return { transcribeData(bytes, decode) {
        calls.push({ bytes, decode });
        return { stop: async () => {}, promise: Promise.resolve({ result: 'hello kit', language: 'en', segments: [{ text: 'hello kit', t0: 0, t1: 10 }] }) };
      }, async release() { releases++; } };
    } });
  const dictation = new Dictation({ engine });
  const result = await dictation.transcribe(new Blob([wav([new Int16Array(3200).fill(-30000)]) as Uint8Array<ArrayBuffer>]),
    { prompt: 'extra', keywords: ['native'], replacements: { kit: 'app' } });
  assert.equal(loads, 1); assert.equal(calls.length, 2);
  assert.equal(calls[0].bytes.byteLength, 3200); assert.equal(new DataView(calls[0].bytes).getInt16(0, true), -32768);
  assert.equal(calls[0].decode.prompt, 'Hint. Byokit extra native');
  assert.equal(calls[1].decode.prompt, 'Hint. Byokit extra native hello kit');
  assert.equal(result.text, 'hello app hello app'); assert.equal(result.segments[1].startMs, 100); assert.equal(result.durationMs, 200);
  await dictation.transcribe(wav([new Int16Array([30000])])); assert.equal(loads, 1);
  assert.equal(new DataView(calls[2].bytes).getInt16(0, true), 32767);
  await engine.release(); assert.equal(releases, 1);

  // The energy gate discards silence without loading, and live gain/threshold govern capture.
  let decodes = 0;
  const gated = whisperRnEngine({ model: '/app/model.bin', settings: { gain: 2, vad: { enabled: true, threshold: 0.02, silenceMs: 100, paddingMs: 0 } },
    async initWhisper() { return { release: async () => {}, transcribeData(bytes) {
      decodes++; return { stop: async () => {}, promise: Promise.resolve({ result: 'speech', segments: [{ text: 'speech', t0: 0, t1: bytes.byteLength / 320 }] }) };
    } }; } });
  const gatedDictation = new Dictation({ engine: gated });
  assert.equal((await gatedDictation.transcribe(wav([new Int16Array(16000)]))).text, ''); assert.equal(decodes, 0);
  const pcm = new Int16Array(6400); pcm.fill(400, 3200, 4800);
  assert.equal((await gatedDictation.transcribe(wav([pcm]))).segments[0].startMs, 200);
  await gated.release();

  // A shipped Silero gate skips the final decode when it finds no speech, and keeps the recording when it does.
  let sileroDecodes = 0, vadReleases = 0, vadCreated = 0;
  const found: { t0: number; t1: number }[][] = [];
  const silero = whisperRnEngine({ model: 1, initWhisper: async () => ({ release: async () => {}, transcribeData() {
    sileroDecodes++; return { stop: async () => {}, promise: Promise.resolve({ result: 'made-up sentence', segments: [] }) };
  } }), speech: { model: '/app/ggml-silero-v6.2.0.bin', async initWhisperVad({ filePath }) {
    assert.equal(filePath, '/app/ggml-silero-v6.2.0.bin'); vadCreated++;
    return { async detectSpeechData() { return found.shift() ?? []; }, async release() { vadReleases++; } };
  } } });
  const sileroMic = fakeMic(), sileroHandle = new Dictation({ engine: silero, audio: sileroMic.audio }).listen(); await tick();
  sileroMic.push({ data: new Int16Array(16000).fill(150), at: 0 }); await until(() => sileroDecodes === 1); // previews are not gated
  const quiet = await sileroHandle.finish();
  assert.equal(quiet.text, ''); assert.equal(sileroDecodes, 1);
  found.push([{ t0: 0, t1: 50 }]);
  assert.equal((await silero.transcribe(wav([new Int16Array(16000).fill(150)]), {})).text, 'made-up sentence');
  assert.equal(sileroDecodes, 2); assert.equal(vadCreated, 1);
  await silero.release(); assert.equal(vadReleases, 1);
  const broken = whisperRnEngine({ model: 1, initWhisper: async () => stubContext(), speech: { model: 2, initWhisperVad: async () => { throw new Error('no model'); } } });
  await assert.rejects(broken.transcribe(wav([new Int16Array(16000)]), {}), (e: DictateError) => e.code === 'bad-model');
});

test('a long dictation is reread over the whole recording; previews never become final and the capture limit is enforced', async () => {
  // Serialization and cancellation: malformed input and word offsets are refused before the model loads, and one
  // inference runs at a time with a drain before release.
  let loads = 0, stops = 0, releases = 0, active = 0, complete!: () => void;
  const context: WhisperRnContext = { release: async () => { assert.equal(active, 0); releases++; },
    transcribeData() {
      active++; assert.equal(active, 1);
      const promise = new Promise<{ result: string; segments: []; isAborted: boolean }>(resolve => { complete = () => { active--; resolve({ result: '', segments: [], isAborted: true }); }; });
      return { promise, stop: async () => { stops++; complete(); } };
    } };
  const busy = whisperRnEngine({ model: 'file:///app/model.bin', initWhisper: async () => { loads++; return context; } });
  await assert.rejects(busy.transcribe(new Uint8Array([1, 2]), {}), (e: DictateError) => e.code === 'unsupported');
  await assert.rejects(busy.transcribe(wav([]), { timestamps: 'word' }), (e: DictateError) => e.code === 'unsupported');
  assert.equal(loads, 0);
  const a = new AbortController(), b = new AbortController();
  const first = busy.transcribe(wav([new Int16Array(320)]), { signal: a.signal });
  const second = busy.transcribe(wav([new Int16Array(320)]), { signal: b.signal });
  const rejectsFirst = assert.rejects(first, (e: DictateError) => e.code === 'cancelled');
  const rejectsSecond = assert.rejects(second, (e: DictateError) => e.code === 'cancelled');
  await until(() => active === 1); b.abort(); a.abort();
  await Promise.all([rejectsFirst, rejectsSecond, busy.release()]);
  assert.equal(stops, 1); assert.equal(loads, 1); assert.equal(releases, 1);

  // Tuned Whisper keeps quiet audio across pauses, rereads the whole recording for finals, and never uses previews as final.
  const reads: { bytes: number; decode: WhisperRnDecodeOptions }[] = [];
  const tuned = whisperRnEngine({ model: '/app/ggml-base.en-q5_1.bin', settings: { vocabulary: ['AppWord'] },
    async initWhisper() { return { release: async () => {}, transcribeData(data, decode) {
      reads.push({ bytes: data.byteLength, decode });
      const text = decode.prompt ? 'complete recording' : 'preview guess';
      return { stop: async () => {}, promise: Promise.resolve({ result: text, segments: [{ text, t0: 90, t1: 100 }] }) };
    } }; } });
  const mic = fakeMic(), dictate = new Dictation({ engine: tuned, audio: mic.audio }), tunedHandle = dictate.listen({ prompt: 'Context', keywords: ['ExtraWord'] });
  let finals = 0, levels = 0;
  tunedHandle.on('final', () => { finals++; }); tunedHandle.on('level', () => { levels++; });
  await tick();
  mic.push({ data: new Int16Array(16000).fill(150), at: 0 }); await until(() => reads.length === 1);
  mic.push({ data: new Int16Array(31 * 16000), at: 1000 }); await until(() => levels === 2);
  assert.equal(finals, 0);
  mic.push({ data: new Int16Array(16000).fill(150), at: 32000 }); await until(() => reads.length === 3);
  assert.equal(reads[0].decode.prompt, ''); assert.equal(reads[1].decode.prompt, '');
  const tunedResult = await tunedHandle.finish();
  assert.equal(reads.length, 5); assert.equal(reads[3].bytes, 30 * 16000 * 2); assert.equal(reads[4].bytes, 8 * 16000 * 2);
  assert.equal(reads[3].decode.prompt, 'AppWord Context ExtraWord'); assert.equal(reads[3].decode.language, 'en');
  assert.equal(tunedResult.text, 'complete recording'); assert.equal(tunedResult.durationMs, 33000); assert.equal(finals, 1);
  await tuned.release();

  // Long live finals cover every sample, merge joins, and enforce the configurable complete-capture limit.
  const longReads: { seconds: number; first: number; last: number }[] = [];
  const readings = ['Begin here. Open the settings and press sa', 'the settings and press save. Then read the report and send it', 'read the report and send it tomorrow.'];
  const long = whisperRnEngine({ model: 42, settings: { vocabulary: ['AppWord'] }, async initWhisper() {
    return { async release() {}, transcribeData(data) {
      const view = new DataView(data), text = readings[longReads.length % readings.length];
      longReads.push({ seconds: data.byteLength / 32000, first: view.getInt16(0, true), last: view.getInt16(data.byteLength - 2, true) });
      return { async stop() {}, promise: Promise.resolve({ result: text, segments: [{ text, t0: 9999, t1: 10000 }] }) };
    } };
  } });
  const longMic = fakeMic(), longDictation = new Dictation({ engine: long, audio: longMic.audio });
  for (const maxSeconds of [0, -1, NaN, Infinity]) {
    assert.throws(() => longDictation.listen({ maxSeconds }), (e: DictateError) => e.code === 'unsupported');
    assert.equal(longDictation.state.phase, 'idle');
  }
  const longHandle = longDictation.listen(); await tick();
  const longPcm = new Int16Array(61 * 16000);
  for (let second = 0; second < 61; second++) longPcm.fill(second + 1, second * 16000, (second + 1) * 16000);
  let frames = 0; longHandle.on('level', () => frames++);
  longMic.push({ data: longPcm, at: 0 }); await until(() => frames === 1);
  const longResult = await longHandle.finish();
  assert.deepEqual(longReads.map(r => [r.seconds, r.first, r.last]), [[30, 1, 30], [30, 26, 55], [11, 51, 61]]);
  assert.equal(longResult.text, 'Begin here. Open the settings and press save. Then read the report and send it tomorrow.');
  assert.equal(longResult.segments.map(s => s.text).join(' '), longResult.text);
  assert.equal(longResult.durationMs, 61000); assert.equal(longMic.stops, 1);
  for (const [maxSeconds, seconds, reject] of [[undefined, 300, false], [undefined, 300 + 1 / 16000, true], [360, 360, false], [90, 90, false], [60, 61, true]] as const) {
    const capMic = fakeMic(), limited = new Dictation({ engine: long, audio: capMic.audio }).listen({ maxSeconds });
    let seen = 0; limited.on('level', () => seen++); await tick();
    capMic.push({ data: new Int16Array(Math.round(seconds * 16000)), at: 0 }); await until(() => seen === 1);
    if (reject) await assert.rejects(limited.finish(), (e: DictateError) => e.code === 'too-large');
    else assert.equal((await limited.finish()).durationMs, seconds * 1000);
    assert.equal(capMic.stops, 1); assert.equal(longReads.length, 3);
  }
  await long.release();

  // Stopping during a preview drains every queued frame into one fresh final pass; cancel discards instead.
  const drained: Int16Array[] = [];
  let settle!: () => void;
  const draining = whisperRnEngine({ model: 1, async initWhisper() {
    return { async release() {}, transcribeData(data) {
      const view = new DataView(data), queued = new Int16Array(data.byteLength / 2);
      for (let i = 0; i < queued.length; i++) queued[i] = view.getInt16(i * 2, true);
      drained.push(queued);
      const promise = drained.length === 1 ? new Promise<{ result: string; segments: [] }>(resolve => { settle = () => resolve({ result: 'first', segments: [] }); }) : Promise.resolve({ result: 'complete final', segments: [] });
      return { async stop() { settle(); }, promise };
    } };
  } });
  const drainMic = fakeMic(), drain = new Dictation({ engine: draining, audio: drainMic.audio }), drainHandle = drain.listen(); await tick();
  drainMic.push({ data: new Int16Array(16000).fill(1000), at: 0 }); await until(() => drained.length === 1);
  drainMic.push({ data: new Int16Array(16000).fill(2000), at: 1000 });
  drainMic.push({ data: new Int16Array(16000).fill(3000), at: 2000 });
  const finishing = drainHandle.finish(); assert.equal(drainHandle.finish(), finishing);
  settle();
  const drainedResult = await finishing;
  assert.equal(drained.length, 2); assert.equal(drained[1].length, 3 * 16000);
  assert.deepEqual([drained[1][0], drained[1][16000], drained[1][32000]], [1000, 2000, 3000]);
  assert.equal(drainedResult.text, 'complete final'); assert.equal(drainedResult.durationMs, 3000);
  await draining.release();
});

test('a shipped speech detector decides live turns and offline ranges, and is disposed with the listen', async () => {
  // One session per stream, as the kit requires: a session carries recurrent state, so each counts from zero.
  const detector = (quietWindows: number) => {
    const sessions: { windows: number; open: boolean }[] = [];
    return {
      handOut: () => { const state = { windows: 0, open: true }; sessions.push(state);
        return { async run() { state.windows++; return { probability: state.windows > quietWindows ? 0.95 : 0.05, state: new Float32Array(VAD_STATE) }; }, async release() { state.open = false; } } as VadSession; },
      windows: () => sessions.at(-1)!.windows,
      leaked: () => sessions.filter(s => s.open).length,
    };
  };
  const engineOf = (o: { handOut?: () => VadSession; record?: number[] } = {}) => whisperRnEngine({ model: 'base.en-q5_1',
    initWhisper: async () => ({ release: async () => {}, transcribeData(bytes) { o.record?.push(bytes.byteLength / 2); return { stop: async () => {}, promise: Promise.resolve({ result: '', segments: [] }) }; } }),
    settings: { vad: { enabled: true } }, vad: o.handOut ? async () => o.handOut!() : undefined });

  // No factory means exactly today's energy behaviour: the unchanged threshold, and the hiss still reaches the decoder.
  const plain = engineOf();
  assert.equal(plain.capture?.detect, undefined, 'no factory means no detector on the live gate');
  assert.equal(whisperSettings({ vad: { enabled: true } }).vad.threshold, 0.0025, 'the unchanged energy threshold');
  const kept: number[] = [];
  await new Dictation({ engine: engineOf({ record: kept }) }).transcribe(wavOf('x-hiss-15'), {});
  assert.ok(kept.reduce((a, b) => a + b, 0) > decodePcm(wavOf('x-hiss-15')).length * 0.9, 'the energy gate keeps the hiss');

  // Offline segmentation hands the decoder exactly the supplied detector's ranges, in samples.
  const offline = detector(12);
  const decoded: number[] = [];
  await new Dictation({ engine: engineOf({ handOut: offline.handOut, record: decoded }) }).transcribe(wavOf('clean-short'), {});
  const settings = whisperSettings({ vad: { enabled: true } });
  const expected = createVad({ session: offline.handOut(), silenceMs: settings.vad.silenceMs, paddingMs: settings.vad.paddingMs });
  await expected.push(decodePcm(wavOf('clean-short'))); await expected.flush();
  assert.deepEqual(decoded, [expected.ranges().reduce((sum, [from, to]) => sum + (to - from) * 16, 0)], 'samples, not milliseconds, reach the decoder');
  assert.ok(decoded[0] > 0 && decoded[0] < decodePcm(wavOf('clean-short')).length, 'the lead silence is dropped');
  await expected.release();
  assert.equal(offline.leaked(), 0, 'offline segmentation disposes every session it consumed');

  // A supplied detector decides live turns: a loud frame it rejects opens nothing; the next opens the turn.
  const live = detector(1), liveEngine = engineOf({ handOut: live.handOut });
  assert.ok(liveEngine.capture?.detect, 'the factory is exposed to the live gate');
  const mic = fakeMic(), dictation = new Dictation({ engine: liveEngine, audio: mic.audio });
  const turns: string[] = [];
  const handle = dictation.listen();
  handle.on('turn', e => turns.push(e.phase));
  await tick();
  const loud = new Int16Array(VAD_WINDOW).fill(20000);
  mic.push({ data: loud, at: 0 }); await until(() => live.windows() === 1);
  assert.deepEqual(turns, [], 'the level gate alone would have opened a turn on this frame');
  mic.push({ data: loud, at: 32 }); await until(() => turns.length === 1);
  assert.deepEqual(turns, ['start'], 'the detector opened the turn');
  await handle.finish();
  assert.equal(live.leaked(), 0, 'every session this listen took is disposed with it');

  // A cancelled listen disposes its detector too.
  const cancelled = detector(0), cancelEngine = engineOf({ handOut: cancelled.handOut });
  const cancelMic = fakeMic(), cancelling = new Dictation({ engine: cancelEngine, audio: cancelMic.audio });
  const cancelHandle = cancelling.listen(); await tick(); cancelHandle.cancel();
  await assert.rejects(cancelHandle.finish(), (e: DictateError) => e.code === 'cancelled');
  assert.equal(cancelled.leaked(), 0, 'a cancelled listen disposes its detector');
});

test('provider and CLI engines use exactly the caller credential, refuse arbitrary endpoints, and run isolated', async () => {
  let status = 200;
  const seen: { url?: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body });
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ text: 'hello kit', language: 'en', duration: 1, segments: [{ id: 0, text: 'hello kit', start: 0, end: 1 }],
      words: [{ word: 'hello', start: 0, end: 0.5 }], usage: { seconds: 1, cost: 0.012, input_tokens: 5 } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/transcribe`;
  // An explicit test environment propagates the repository's egress fence into the child.
  const env = { NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' };
  try {
    const cloud = new Dictation({ engine: openaiEngine({ key: 'fixture-key', endpoint, env }) });
    const result = await cloud.transcribe(wav([new Int16Array(16000)]), { languages: ['en'], timestamps: 'word', punctuation: false, replacements: { kit: 'app' } });
    assert.equal(result.text, 'hello app'); assert.equal(result.segments[0].words?.[0].endMs, 500);
    assert.equal(result.usage.costUsd, 0.012); assert.equal(result.usage.inputTokens, 5);
    assert.match(seen[0].body, /name="language"\r\n\r\nen/); assert.match(seen[0].body, /name="timestamp_granularities\[\]"/);
    assert.equal(seen[0].headers.authorization, 'Bearer fixture-key');
    const router = new Dictation({ engine: openrouterEngine({ access: async () => ({ access: 'router-sign-in' }), model: 'openai/whisper-1', endpoint, env }) });
    assert.equal((await router.transcribe(wav([]))).usage.basis, 'minutes');
    const chatgpt = new Dictation({ engine: chatgptEngine({ access: async () => ({ access: 'fixture-plan', accountId: 'Umer' }), endpoint, env }) });
    assert.equal((await chatgpt.transcribe(wav([]))).usage.basis, 'subscription');
    assert.equal(seen.at(-1)?.headers.originator, 'byokit'); assert.equal(seen.at(-1)?.headers['chatgpt-account-id'], 'Umer');
    assert.ok(!seen.at(-1)?.body.includes('name="model"'));
    status = 403; await assert.rejects(chatgpt.transcribe(wav([])), (e: DictateError) => e.code === 'not-included');
    status = 429; await assert.rejects(cloud.transcribe(wav([])), (e: DictateError) => e.code === 'rate-limited' && e.until! > Date.now());
    // An endpoint that is not loopback is refused, so a plan credential cannot be exfiltrated.
    await assert.rejects(new Dictation({ engine: openaiEngine({ key: 'fixture', endpoint: 'https://example.com' }) }).transcribe(wav([])), (e: DictateError) => e.code === 'unsupported');
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }

  // The app-passed whisper.cpp CLI runs with no environment and removes its temporary audio; a corrupt model is removed.
  const dir = await mkdtemp(join(tmpdir(), 'dictate-journey-'));
  const before = (await readdir(tmpdir())).filter(s => s.startsWith('dictate-'));
  try {
    const binary = join(dir, 'whisper'), modelPath = join(dir, 'model.bin');
    await writeFile(modelPath, 'fixture');
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv; const input = a[a.indexOf('-f')+1]; const data = fs.readFileSync(input); if(data.readInt16LE(44)!==-32768 || data.readInt16LE(46)!==32767 || process.env.HOME) process.exit(1); fs.writeFileSync(a[a.indexOf('-of')+1]+'.json', JSON.stringify({result:{language:'en'}, transcription:[{text:'hello', offsets:{from:0,to:1000}}]}));\n`);
    await chmod(binary, 0o700);
    const dictate = new Dictation({ engine: whisperEngine({ binary, modelPath }) });
    const transcript = await dictate.transcribe(wav([new Int16Array([-32768, 32767])]));
    assert.equal(transcript.text, 'hello'); assert.equal(transcript.segments[0].endMs, 1000); assert.equal(transcript.usage.basis, 'free');
    assert.deepEqual((await readdir(tmpdir())).filter(s => s.startsWith('dictate-')), before);
    let removed = false;
    await assert.rejects(installModel({ id: 'fixture', url: 'https://example.com/model', bytes: 3, sha256: 'a'.repeat(64), multilingual: true },
      { size: async () => 3, download: async () => {}, sha256: async () => 'b'.repeat(64), remove: async () => { removed = true; } }),
      (e: DictateError) => e.code === 'bad-model');
    assert.equal(removed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('the installed WER CLI measures the committed fixtures against their committed baseline', async () => {
  const cli = join(import.meta.dirname, '..', 'dist', 'wer-cli.js'), gatePath = join(import.meta.dirname, '..', 'scripts', 'bench', 'gate.mjs');
  const longManifest = join(import.meta.dirname, '..', 'fixtures', 'wer', 'long', 'manifest.json');
  const longBaseline = join(import.meta.dirname, '..', 'fixtures', 'wer', 'long', 'baseline.json');
  const dir = await mkdtemp(join(tmpdir(), 'dictation-wer-journey-'));
  const exec = async (args: string[]) => { try { return (await run(process.execPath, args, { maxBuffer: 64 * 1024 * 1024 })).stdout; } catch (e: unknown) { throw new Error(String((e as { stderr?: string }).stderr || (e as Error).message)); } };
  try {
    // The published bin drives an explicitly passed binary and model; nothing is discovered, downloaded or read from HOME.
    const binary = join(dir, 'fake-whisper'), model = join(dir, 'fake-model.bin');
    await writeFile(model, 'fixture');
    await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;if(process.env.HOME)process.exit(1);fs.writeFileSync(a[a.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'en'},transcription:[{text:'Please open the project',offsets:{from:0,to:1000}}]}));\n`);
    await chmod(binary, 0o700);
    const report = JSON.parse(await exec([cli, '--binary', binary, '--model', model, '--manifest', longManifest]));
    const committed = JSON.parse(await readFile(longManifest, 'utf8'));
    assert.deepEqual(report.profiles.map((p: { id: string }) => p.id), ['default', 'application-vocabulary'], 'the committed profile set is measured');
    assert.deepEqual(report.profiles[0].clips.map((c: { id: string }) => c.id), committed.clips.map((c: { id: string }) => c.id));
    for (const clip of report.profiles[0].clips) {
      assert.equal(clip.reference, committed.clips.find((c: { id: string }) => c.id === clip.id).reference, 'the measured reference set is the committed one');
      assert.equal(clip.errors, clip.substitutions + clip.deletions + clip.insertions, 'edit counts come from the word-error-rate alignment');
      assert.equal(clip.referenceWords, clip.reference.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean).length);
      assert.equal(clip.wer, clip.errors / clip.referenceWords);
    }
    // The gate reads a report file; the committed baseline is a real gate the fake decoder's words far exceed, so it rejects...
    const reportPath = join(dir, 'report.json');
    await writeFile(reportPath, JSON.stringify(report));
    await assert.rejects(exec([gatePath, reportPath, longBaseline]), /exceeds baseline/);
    // ...while it accepts a report that matches its own baseline, and the committed baseline names the committed fixtures.
    const acceptedBaseline = join(dir, 'accepted.json');
    await writeFile(acceptedBaseline, JSON.stringify(report));
    await exec([gatePath, reportPath, acceptedBaseline]);
    const committedBaseline = JSON.parse(await readFile(longBaseline, 'utf8'));
    assert.deepEqual(committedBaseline.profiles.map((p: { id: string }) => p.id), ['default', 'application-vocabulary']);
    assert.deepEqual(committedBaseline.profiles[0].clips.map((c: { id: string }) => c.id), committed.clips.map((c: { id: string }) => c.id));
    // A tampered fixture manifest is refused before inference.
    const tampered = join(dir, 'tampered.json');
    await writeFile(tampered, JSON.stringify({ ...committed, clips: [{ ...committed.clips[0], file: join(import.meta.dirname, '..', 'fixtures', 'wer', 'long', committed.clips[0].file), sha256: '0'.repeat(64) }], profiles: committed.profiles.slice(0, 1) }));
    await assert.rejects(exec([cli, '--binary', binary, '--model', model, '--manifest', tampered]), /checksum mismatch/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
