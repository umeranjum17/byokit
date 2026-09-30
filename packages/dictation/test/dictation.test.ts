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
import { wav } from '../src/text.ts';
const tick = () => new Promise<void>(r => setImmediate(r));
async function until(fn: () => boolean) { for (let i = 0; i < 200; i++) { if (fn()) return; await tick(); } assert.ok(fn(), 'flow did not reach checkpoint'); }

test('fixture: stable partials and whole-word final corrections', () => {
  for (const f of fixture.partials) assert.equal(settleWords(f.shown, f.previous, f.next), f.want);
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
    assert.ok(Object.keys(result.metafile!.inputs).every(p => !p.includes('/node.') && !p.includes('/worker.')));
  }
});
