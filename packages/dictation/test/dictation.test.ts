import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import fixture from '../../../fixtures/conformance/dictation-typescript.json' with { type: 'json' };
import { Dictation, DictateError, settleWords, applyWordReplacements, routes, systemEngine, installModel, type DictateSegment } from '../src/index.ts';
import { chatgptEngine, openaiEngine, openrouterEngine, whisperEngine } from '../src/node.ts';
import { fakeEngine, fakeMic } from '../src/testing.ts';
import { wav, mergeOverlap } from '../src/text.ts';
import { whisperRnEngine, whisperSettings, type WhisperRnContext, type WhisperRnDecodeOptions, type WhisperSettings } from '../src/whisper.ts';
import { wordErrorRate, runWer, checkWerRegression } from '../src/wer.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.ok(fn(), 'flow did not reach checkpoint'); }

test('fixture: stable partials and whole-word final corrections', () => {
  for (const f of fixture.partials) assert.equal(settleWords(f.shown, f.previous, f.next), f.want);
  for (const f of fixture.joins) assert.equal(mergeOverlap(f.previous, f.next), f.want);
  assert.equal(applyWordReplacements(fixture.replacements.text, fixture.replacements.map), fixture.replacements.want);
  assert.equal(applyWordReplacements('c++ is useful, ac++b', { 'c++': 'C Plus Plus' }), 'C Plus Plus is useful, ac++b');
  assert.deepEqual(routes().filter(r => r.offer).map(r => r.id), ['system', 'whisper', 'chatgpt']);
});

test('live reread: stable partials, no silence fillers or extra inference on finish, final corrections', async () => {
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
});

test('cancel aborts an in-flight reading and releases capture without returning words', async () => {
  const mic = fakeMic(), fake = fakeEngine([]);
  let entered = false;
  fake.engine.transcribe = async (_input, options) => {
    entered = true;
    await new Promise<void>(r => options.signal!.addEventListener('abort', () => r(), { once: true }));
    return { text: 'discard me', segments: [], usage: { audioMs: 1000, basis: 'free' } };
  };
  const dictation = new Dictation({ engine: fake.engine, audio: mic.audio });
  const handle = dictation.listen(); await tick();
  mic.push({ data: new Int16Array(16000).fill(1000), at: 0 }); await until(() => entered);
  handle.cancel(); await assert.rejects(handle.finish(), (e: DictateError) => e.code === 'cancelled');
  assert.equal(mic.stops, 1); assert.equal(dictation.state.phase, 'idle');
});

test('system native receives local flag, settles finals, and maps missing packs; remote local-only never accesses credentials', async () => {
  let emit!: (s: DictateSegment) => void;
  const engine = systemEngine({
    available: async locale => locale === 'xx' ? 'needs-download' : 'ready',
    start(o, on) {
      assert.equal(o.onDevice, true); assert.equal(o.punctuation, false); emit = on;
      return { async stop() { on({ id: '0', text: 'hello kit', final: true, startMs: 0, endMs: 1000 }); }, cancel() {} };
    },
  });
  const dictation = new Dictation({ engine });
  assert.deepEqual(await dictation.available({ locale: 'xx' }), { ok: false, code: 'needs-download' });
  const handle = dictation.listen({ onDeviceOnly: true, punctuation: false, replacements: { kit: 'app' } }); await tick();
  emit({ id: '0', text: 'hello kit', final: false }); emit({ id: '0', text: 'hello kit again', final: false });
  assert.equal((await handle.finish()).text, 'hello app');
  let accesses = 0;
  const remote = new Dictation({ engine: chatgptEngine({ access: async () => { accesses++; return { access: 'must-not-be-read' }; } }) });
  await assert.rejects(remote.transcribe(new Uint8Array(), { onDeviceOnly: true }), (e: DictateError) => e.code === 'not-local');
  assert.equal(accesses, 0);
});

test('child HTTP adapters use explicit credentials and wire options, preserve usage/timestamps and distinguish refusal', async () => {
  let status = 200;
  const seen: { url?: string; headers: Record<string, unknown>; body: string }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body });
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '2' });
    res.end(JSON.stringify({ text: 'hello kit', language: 'en', duration: 1, segments: [{ id: 0, text: 'hello kit', start: 0, end: 1 }], words: [{ word: 'hello', start: 0, end: 0.5 }], usage: { seconds: 1, cost: 0.012, input_tokens: 5 } }));
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const endpoint = `http://127.0.0.1:${port}/transcribe`;
  // Explicit test environment propagates the repository's egress fence into children.
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
    await assert.rejects(new Dictation({ engine: openaiEngine({ key: 'fixture', endpoint: 'https://example.com' }) }).transcribe(wav([])), (e: DictateError) => e.code === 'unsupported');
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('app-passed Whisper CLI runs isolated, reads WAV boundaries and removes temporary audio; corrupt models removed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dictate-fixture-'));
  const before = (await readdir(tmpdir())).filter(s => s.startsWith('dictate-'));
  try {
    const binary = join(dir, 'whisper'), modelPath = join(dir, 'model.bin');
    await writeFile(modelPath, 'fixture');
    await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs'); const a = process.argv; const input = a[a.indexOf('-f')+1]; const data = fs.readFileSync(input); if(data.readInt16LE(44)!==-32768 || data.readInt16LE(46)!==32767 || process.env.HOME) process.exit(1); fs.writeFileSync(a[a.indexOf('-of')+1]+'.json', JSON.stringify({result:{language:'en'}, transcription:[{text:'hello', offsets:{from:0,to:1000}}]}));\n`);
    await chmod(binary, 0o700);
    const dictate = new Dictation({ engine: whisperEngine({ binary, modelPath }) });
    const result = await dictate.transcribe(wav([new Int16Array([-32768, 32767])]));
    assert.equal(result.text, 'hello'); assert.equal(result.segments[0].endMs, 1000); assert.equal(result.usage.basis, 'free');
    assert.deepEqual((await readdir(tmpdir())).filter(s => s.startsWith('dictate-')), before);
    let removed = false;
    await assert.rejects(installModel({ id: 'fixture', url: 'https://example.com/model', bytes: 3, sha256: 'a'.repeat(64), multilingual: true }, {
      size: async () => 3, download: async () => {}, sha256: async () => 'b'.repeat(64), remove: async () => { removed = true; },
    }), (e: DictateError) => e.code === 'bad-model');
    assert.equal(removed, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('main entry bundles for browser and React Native without Node imports', async () => {
  for (const condition of ['browser', 'react-native']) {
    const result = await build({ entryPoints: ['packages/dictation/src/index.ts'], bundle: true, write: false, platform: 'browser', conditions: [condition], metafile: true, logLevel: 'silent' });
    assert.ok(Object.keys(result.metafile!.inputs).every(p => !p.includes('/node.') && !p.includes('/worker.') && !p.includes('/wer.') && !p.includes('whisper.rn')));
  }
});

test('Whisper settings validate decoder and preprocessing bounds before native access', () => {
  assert.deepEqual(whisperSettings(), { language: 'en', initialPrompt: '', vocabulary: [], threads: 6, gain: 1, chunkMs: 0,
    beamSize: -1, bestOf: 5, temperature: 0, temperatureInc: 0.2, vad: { enabled: false, threshold: 0.0025, relativeThreshold: 0.1, silenceMs: 500, paddingMs: 200 } });
  assert.equal(whisperSettings({}, true).language, 'auto');
  const invalid: WhisperSettings[] = [{ threads: 0 }, { threads: 65 }, { gain: NaN }, { gain: 0 }, { chunkMs: 30001 }, { chunkMs: 99 },
    { beamSize: 1 }, { beamSize: 0 }, { bestOf: 0 }, { temperature: -1 }, { temperatureInc: Infinity }, { language: 'en-US' },
    { vocabulary: [''] }, { vad: { threshold: 1.1 } }, { vad: { relativeThreshold: 1.1 } }, { vad: { silenceMs: 0 } }, { vad: { paddingMs: -1 } }];
  for (const settings of invalid) assert.throws(() => whisperSettings(settings), (e: DictateError) => e.code === 'bad-model');
  for (const model of ['', 'https://example.com/model.bin', -1]) {
    assert.throws(() => whisperRnEngine({ model, initWhisper: async () => { throw new Error('never reached'); } }), (e: DictateError) => e.code === 'bad-model');
  }
});

test('whisper.rn wiring: PCM gain/clipping, chunk offsets, vocabulary and context prompts, lazy warm model', async () => {
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
  assert.deepEqual(calls[0].decode, { language: 'en', maxThreads: 6, audioCtx: 0, tokenTimestamps: false, maxLen: 0,
    prompt: 'Hint. Byokit extra native', beamSize: 5, bestOf: 3, temperature: 0.1, temperatureInc: 0 });
  assert.equal(calls[1].decode.prompt, 'Hint. Byokit extra native hello kit');
  assert.equal(result.text, 'hello app hello app'); assert.equal(result.segments[1].startMs, 100); assert.equal(result.durationMs, 200);
  await dictation.transcribe(wav([new Int16Array([30000])])); assert.equal(loads, 1);
  assert.equal(new DataView(calls[2].bytes).getInt16(0, true), 32767);
  await engine.release(); assert.equal(releases, 1);
});

test('whisper.rn energy VAD discards silence without loading; live gain/threshold settings govern capture', async () => {
  let calls = 0;
  const engine = whisperRnEngine({ model: '/app/model.bin', settings: { gain: 2, vad: { enabled: true, threshold: 0.02, silenceMs: 100, paddingMs: 0 } },
    async initWhisper() { return { release: async () => {}, transcribeData(bytes) {
      calls++; return { stop: async () => {}, promise: Promise.resolve({ result: 'speech', segments: [{ text: 'speech', t0: 0, t1: bytes.byteLength / 320 }] }) };
    } }; } });
  const dictate = new Dictation({ engine });
  assert.equal((await dictate.transcribe(wav([new Int16Array(16000)]))).text, ''); assert.equal(calls, 0);
  const pcm = new Int16Array(6400); pcm.fill(400, 3200, 4800);
  const result = await dictate.transcribe(wav([pcm]));
  assert.equal(result.segments[0].startMs, 200); assert.equal(result.durationMs, 400);
  const mic = fakeMic(), live = new Dictation({ engine, audio: mic.audio }).listen(); await tick();
  mic.push({ data: new Int16Array(16000).fill(400), at: 0 }); await until(() => calls === 2);
  let finals = 0, levels = 0; live.on('final', () => { finals++; }); live.on('level', () => { levels++; });
  mic.push({ data: new Int16Array(1600), at: 1000 }); await until(() => levels === 1);
  assert.equal(finals, 0);
  assert.equal((await live.finish()).text, 'speech'); await engine.release();
  const high = whisperRnEngine({ model: '/app/model.bin', settings: { vad: { threshold: 0.6 } },
    async initWhisper() { return { release: async () => {}, transcribeData() {
      calls++; return { stop: async () => {}, promise: Promise.resolve({ result: 'loud speech', segments: [] }) };
    } }; } });
  const loudMic = fakeMic(), loud = new Dictation({ engine: high, audio: loudMic.audio }).listen(); await tick();
  loudMic.push({ data: new Int16Array(16000).fill(25000), at: 0 });
  await until(() => calls === 4);
  assert.equal((await loud.finish()).text, 'loud speech'); await high.release();
});

test('whisper.rn serializes inference, cancels through stop, drains before release, rejects malformed WAV and unsupported word offsets', async () => {
  let loads = 0, stops = 0, releases = 0, active = 0;
  let complete!: () => void;
  const context: WhisperRnContext = { release: async () => { assert.equal(active, 0); releases++; },
    transcribeData() {
      active++; assert.equal(active, 1);
      const promise = new Promise<{ result: string; segments: []; isAborted: boolean }>(resolve => {
        complete = () => { active--; resolve({ result: '', segments: [], isAborted: true }); };
      });
      return { promise, stop: async () => { stops++; complete(); } };
    } };
  const engine = whisperRnEngine({ model: 'file:///app/model.bin', initWhisper: async () => { loads++; return context; } });
  await assert.rejects(engine.transcribe(new Uint8Array([1, 2]), {}), (e: DictateError) => e.code === 'unsupported');
  await assert.rejects(engine.transcribe(wav([]), { timestamps: 'word' }), (e: DictateError) => e.code === 'unsupported');
  assert.equal(loads, 0);
  const a = new AbortController(), b = new AbortController();
  const first = engine.transcribe(wav([new Int16Array(320)]), { signal: a.signal });
  const second = engine.transcribe(wav([new Int16Array(320)]), { signal: b.signal });
  const rejectingFirst = assert.rejects(first, (e: DictateError) => e.code === 'cancelled');
  const rejectingSecond = assert.rejects(second, (e: DictateError) => e.code === 'cancelled');
  await until(() => active === 1); b.abort(); a.abort();
  await Promise.all([rejectingFirst, rejectingSecond, engine.release()]);
  assert.equal(stops, 1); assert.equal(loads, 1); assert.equal(releases, 1);
});

test('tuned Whisper keeps quiet audio across pauses, rereads the whole recording for finals, and never uses previews as final text', async () => {
  const reads: { bytes: number; decode: WhisperRnDecodeOptions }[] = [];
  const engine = whisperRnEngine({ model: '/app/ggml-base.en-q5_1.bin', settings: { vocabulary: ['AppWord'] },
    async initWhisper() { return { release: async () => {}, transcribeData(data, decode) {
      reads.push({ bytes: data.byteLength, decode });
      const text = decode.prompt ? 'complete recording' : 'preview guess';
      // Deliberately late/uncertain timestamps must never cause an audio cut.
      return { stop: async () => {}, promise: Promise.resolve({ result: text, segments: [{ text, t0: 90, t1: 100 }] }) };
    } }; } });
  const mic = fakeMic(), dictate = new Dictation({ engine, audio: mic.audio }), handle = dictate.listen({ prompt: 'Context', keywords: ['ExtraWord'] });
  let finals = 0, levels = 0;
  handle.on('final', () => { finals++; }); handle.on('level', () => { levels++; });
  await tick();
  mic.push({ data: new Int16Array(16000).fill(150), at: 0 }); await until(() => reads.length === 1);
  mic.push({ data: new Int16Array(31 * 16000), at: 1000 }); await until(() => levels === 2);
  assert.equal(finals, 0);
  mic.push({ data: new Int16Array(16000).fill(150), at: 32000 }); await until(() => reads.length === 3);
  assert.equal(reads[0].decode.prompt, ''); assert.equal(reads[1].decode.prompt, '');
  const result = await handle.finish();
  assert.equal(reads.length, 5); assert.equal(reads[3].bytes, 30 * 16000 * 2); assert.equal(reads[4].bytes, 8 * 16000 * 2);
  assert.equal(reads[3].decode.prompt, 'AppWord Context ExtraWord');
  assert.equal(reads[3].decode.language, 'en'); assert.equal(reads[3].decode.audioCtx, 0);
  assert.ok(!('beamSize' in reads[3].decode)); assert.equal(reads[3].decode.tokenTimestamps, false); assert.equal(reads[3].decode.maxLen, 0);
  assert.equal(result.text, 'complete recording'); assert.equal(result.durationMs, 33000); assert.equal(finals, 1);
  await engine.release();
});

test('long live Whisper finals cover every sample, merge joins, and enforce the configurable complete capture limit', async () => {
  const reads: { seconds: number; first: number; last: number; decode: WhisperRnDecodeOptions }[] = [];
  const readings = ['Begin here. Open the settings and press sa', 'the settings and press save. Then read the report and send it', 'read the report and send it tomorrow.'];
  const engine = whisperRnEngine({ model: 42, settings: { vocabulary: ['AppWord'] }, async initWhisper() {
    return { async release() {}, transcribeData(data, decode) {
      const view = new DataView(data), text = readings[reads.length % readings.length];
      reads.push({ seconds: data.byteLength / 32000, first: view.getInt16(0, true), last: view.getInt16(data.byteLength - 2, true), decode });
      return { async stop() {}, promise: Promise.resolve({ result: text, segments: [{ text, t0: 9999, t1: 10000 }] }) };
    } };
  } });
  const mic = fakeMic(), dictation = new Dictation({ engine, audio: mic.audio });
  for (const maxSeconds of [0, -1, NaN, Infinity]) {
    assert.throws(() => dictation.listen({ maxSeconds }), (e: DictateError) => e.code === 'unsupported');
    assert.equal(dictation.state.phase, 'idle');
  }
  const handle = dictation.listen(); await tick();
  const pcm = new Int16Array(61 * 16000);
  for (let second = 0; second < 61; second++) pcm.fill(second + 1, second * 16000, (second + 1) * 16000);
  let frames = 0; handle.on('level', () => frames++);
  mic.push({ data: pcm, at: 0 }); await until(() => frames === 1);
  const result = await handle.finish();
  assert.deepEqual(reads.map(r => [r.seconds, r.first, r.last]), [[30, 1, 30], [30, 26, 55], [11, 51, 61]]);
  assert.equal(result.text, 'Begin here. Open the settings and press save. Then read the report and send it tomorrow.');
  assert.equal(result.segments.map(s => s.text).join(' '), result.text);
  assert.equal(result.durationMs, 61000); assert.equal(mic.stops, 1);
  for (const { decode } of reads) {
    assert.equal(decode.audioCtx, 0); assert.equal(decode.tokenTimestamps, false); assert.equal(decode.maxLen, 0);
    assert.equal(decode.language, 'en'); assert.ok(!('beamSize' in decode)); assert.equal(decode.prompt, 'AppWord');
  }
  // Exact default/custom boundaries pass; one additional sample fails before inference.
  for (const [maxSeconds, seconds, reject] of [[undefined, 300, false], [undefined, 300 + 1 / 16000, true], [360, 360, false], [90, 90, false], [60, 61, true]] as const) {
    const silent = fakeMic(), live = new Dictation({ engine, audio: silent.audio }).listen({ maxSeconds });
    let levels = 0; live.on('level', () => levels++); await tick();
    silent.push({ data: new Int16Array(Math.round(seconds * 16000)), at: 0 }); await until(() => levels === 1);
    if (reject) await assert.rejects(live.finish(), (e: DictateError) => e.code === 'too-large');
    else assert.equal((await live.finish()).durationMs, seconds * 1000);
    assert.equal(silent.stops, 1); assert.equal(reads.length, 3);
  }
  const silent = fakeMic(), fake = fakeEngine([]), live = new Dictation({ engine: fake.engine, audio: silent.audio }).listen({ maxSeconds: 2 });
  let framesSeen = 0; live.on('level', () => framesSeen++); await tick();
  silent.push({ data: new Int16Array(2 * 16000), at: 0 }); await until(() => framesSeen === 1);
  silent.push({ data: new Int16Array(1), at: 2000 }); await until(() => framesSeen === 2);
  await assert.rejects(live.finish(), (e: DictateError) => e.code === 'too-large');
  assert.equal(silent.stops, 1); assert.equal(fake.calls.length, 0);
  await engine.release();
});

test('stopping during a Whisper preview drains all queued capture into one fresh final pass', async () => {
  const reads: Int16Array[] = [];
  let settlePreview!: () => void;
  const engine = whisperRnEngine({ model: 1, async initWhisper() {
    return { async release() {}, transcribeData(data) {
      const view = new DataView(data), pcm = new Int16Array(data.byteLength / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
      reads.push(pcm);
      const promise = reads.length === 1 ? new Promise<{ result: string; segments: [] }>(resolve => {
        settlePreview = () => resolve({ result: 'first', segments: [] });
      }) : Promise.resolve({ result: 'complete final', segments: [] });
      return { async stop() { settlePreview(); }, promise };
    } };
  } });
  const mic = fakeMic(), dictate = new Dictation({ engine, audio: mic.audio }), handle = dictate.listen({ onDeviceOnly: true });
  await tick();
  mic.push({ data: new Int16Array(16000).fill(1000), at: 0 }); await until(() => reads.length === 1);
  mic.push({ data: new Int16Array(16000).fill(2000), at: 1000 });
  mic.push({ data: new Int16Array(16000).fill(3000), at: 2000 });
  const finishing = handle.finish(); assert.equal(handle.finish(), finishing);
  settlePreview();
  const result = await finishing;
  assert.equal(reads.length, 2); assert.equal(reads[1].length, 3 * 16000);
  assert.deepEqual([reads[1][0], reads[1][16000], reads[1][32000]], [1000, 2000, 3000]);
  assert.equal(result.text, 'complete final'); assert.equal(result.durationMs, 3000); assert.equal(result.usage.audioMs, 3000);
  assert.equal(mic.stops, 1); assert.equal(dictate.state.phase, 'idle');
  // Cancel, without a following finish(), also stops capture but discards its queue.
  const cancelledMic = fakeMic(), cancelling = new Dictation({ engine, audio: cancelledMic.audio });
  const cancelled = cancelling.listen(); await tick(); cancelled.cancel();
  await until(() => cancelling.state.phase === 'idle'); assert.equal(cancelledMic.stops, 1);
  await assert.rejects(cancelled.finish(), (e: DictateError) => e.code === 'cancelled');
  assert.equal(reads.length, 2);
  await engine.release();
});

test('WER harness scores edit counts and runs all attributed clip categories through an explicit fake desktop CLI', async () => {
  assert.deepEqual(wordErrorRate('one two three', 'ONE, too four three!'), { substitutions: 1, deletions: 0, insertions: 1, errors: 2, referenceWords: 3, wer: 2 / 3 });
  assert.equal(wordErrorRate('one two', 'one').deletions, 1);
  assert.equal(wordErrorRate('', 'extra').wer, null);
  assert.equal(wordErrorRate('worktree', 'work-tree').errors, 2);
  const dir = await mkdtemp(join(tmpdir(), 'wer-fixture-'));
  try {
    const binary = join(dir, 'fake-cli');
    await writeFile(binary, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv;if(process.env.HOME||a[a.indexOf('-bs')+1]!=='-1'||a[a.indexOf('-t')+1]!=='2')process.exit(1);fs.writeFileSync(a[a.indexOf('-of')+1]+'.json',JSON.stringify({result:{language:'en'},transcription:[{text:'Please open the project',offsets:{from:0,to:1000}}]}));\n`);
    await chmod(binary, 0o700);
    const progress: string[] = [];
    const report = await runWer({ binary, model: join(dir, 'fake-model.bin'), manifest: 'packages/dictation/fixtures/wer/manifest.json', profiles: ['default'], threads: 2, onProgress: message => progress.push(message) });
    assert.equal(report.profiles[0].settings.threads, 2);
    assert.equal(progress.length, 4); assert.match(progress[0], /repeat 1\/1: \d+ ms/);
    await assert.rejects(runWer({ binary, model: join(dir, 'fake-model.bin'), manifest: 'packages/dictation/fixtures/wer/manifest.json', profiles: ['default'], threads: 0 }), (e: DictateError) => e.code === 'bad-model');
    assert.deepEqual(report.profiles[0].clips.map(c => c.category), ['clean', 'noisy', 'fast', 'technical-names']);
    assert.ok(report.profiles[0].summary.wer! > 0); assert.ok(report.profiles[0].summary.latencyMs > 0);
    assert.equal(report.profiles[0].summary.referenceWords, 46);
    const baseline = structuredClone(report);
    assert.deepEqual(checkWerRegression(report, baseline), []);
    report.profiles[0].summary.wer! += 0.0101;
    assert.match(checkWerRegression(report, baseline)[0], /exceeds baseline/);
    report.profiles[0].summary.wer = baseline.profiles[0].summary.wer;
    report.profiles[0].clips[0].reference = 'changed reference';
    assert.match(checkWerRegression(report, baseline)[0], /Changed fixture/);
    await assert.rejects(runWer({ binary, model: join(dir, 'fake-model.bin'), manifest: 'packages/dictation/fixtures/wer/manifest.json', profiles: ['missing'] }), /Unknown settings profile/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
