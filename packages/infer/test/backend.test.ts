// decide's published generate() over the on-device model: the structural backend type is decide's GenerationBackend,
// stays-here keeps it, and a cut-off answer is reported incomplete instead of as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generate, type GenerationBackend } from '@byokit/decide';
import { LocalModel, NanoModel, InferError, generationBackend, inferBackend, model, stateWords, summarizePane, whereWords, type InferGenerationBackend,
  type InferLocalBackend, type InferModel, errorWords } from '../src/index.ts';
import { fakeLlama, fakeNano, memoryModelStore } from '../src/testing.ts';

const BYTES = new TextEncoder().encode('GGUF');
const REV = 'b'.repeat(40);
const TINY: InferModel = { ...model(), id: 'tiny', revision: REV, url: `https://example.test/${REV}/tiny.gguf`, bytes: 4,
  sha256: createHash('sha256').update(BYTES).digest('hex') };
const pins: GenerationBackend[] = [null as unknown as InferGenerationBackend, null as unknown as InferLocalBackend];
void pins;
const SCHEMA = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } as const;

async function local(reply: NonNullable<Parameters<typeof fakeLlama>[0]>['reply']) {
  const { store } = memoryModelStore({ [TINY.url]: BYTES });
  const m = new LocalModel({ model: TINY, store, initLlama: fakeLlama({ reply }).initLlama });
  await m.install();
  return m;
}

test('decide generate() with privacy stays-here uses the on-device backend and validates its JSON', async () => {
  const backend = generationBackend(await local(() => '{"title":"Fix login"}'));
  assert.equal(backend.leaves, false);
  assert.equal(backend.model, `tiny@${REV}`);
  const r = await generate<{ title: string }>({ state: { pane: 'npm test' } },
    { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    { backends: [backend], privacy: 'stays-here', budget: { maxOutputTokens: 100 } });
  assert.deepEqual(r.data, { title: 'Fix login' });
  assert.equal(r.by, 'on-device');
});

test('a cut-off on-device answer is incomplete, never partial data', async () => {
  const backend = generationBackend(await local(() => ({ text: '{"title":"Fi', content: '{"title":"Fi', stopped_limit: 1 })));
  const r = await generate({ state: {} }, { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    { backends: [backend], privacy: 'stays-here' });
  assert.equal(r.data, null);
  assert.equal(r.failure?.code, 'incomplete');
});

test('local is Gemini Nano when AICore has it ready, else the GGUF model; absent, silent or failing AICore never hangs', async () => {
  const gguf = await local(() => '{"title":"from gguf"}');
  const ready = fakeNano({ reply: r => { assert.match(r.systemInstruction ?? '', /JSON only/); return '{"title":"from nano"}'; } });
  const nano = new NanoModel({ binding: ready.binding });
  const b = await inferBackend({ where: 'local', gguf, nano });
  assert.deepEqual([b.name, b.model, b.billing, b.leaves, b.local === nano], ['on-device-nano', 'gemini-nano@nano-fake', 'local', false, true]);
  const r = await generate<{ title: string }>({ state: {} }, SCHEMA, { backends: [b], privacy: 'stays-here' });
  assert.deepEqual([r.data, r.by], [{ title: 'from nano' }, 'on-device-nano']);
  assert.deepEqual(ready.requests[0], { ...ready.requests[0], temperature: 0, topK: 1, seed: 0 });
  assert.equal(whereWords(b), 'Runs on this phone with its built-in model.');
  const unnamed = new NanoModel({ binding: { ...fakeNano().binding, getBaseModelName: () => new Promise(() => {}) }, statusMs: 20 });
  assert.equal((await inferBackend({ where: 'local', gguf, nano: unnamed })).model, 'gemini-nano', 'a silent name lookup is only a label');

  for (const [nanoModel, why] of [
    [undefined, undefined], [new NanoModel(), 'binding'], [new NanoModel({ binding: fakeNano({ status: 0 }).binding }), 'device'],
    [new NanoModel({ binding: fakeNano({ status: 1 }).binding }), undefined],
    [new NanoModel({ binding: fakeNano({ status: new Promise(() => {}) }).binding, statusMs: 20 }), 'binding'],
  ] as const) {
    const g = await inferBackend({ where: 'local', gguf, nano: nanoModel });
    assert.deepEqual([g.name, g.billing, g.local === gguf], ['on-device', 'local', true]);
    if (nanoModel) assert.equal(nanoModel.state.why, why);
    assert.equal(whereWords(g), 'Runs on this phone with the downloaded model.');
    if (nanoModel) assert.doesNotMatch(stateWords(nanoModel.state, { nano: true }), /[Dd]ownload/);
    assert.equal((await generate<{ title: string }>({ state: {} }, SCHEMA, { backends: [g], privacy: 'stays-here' })).data?.title, 'from gguf');
  }
  await assert.rejects(new NanoModel().complete({ prompt: 'hi' }), (e: InferError) => e.code === 'unsupported');

  // AICore can report AVAILABLE while every inference fails: that Nano stays failed and the next resolve picks GGUF.
  const broken = new NanoModel({ binding: fakeNano({ failCode: -1 }).binding });
  await assert.rejects((await inferBackend({ where: 'local', gguf, nano: broken })).generate({ prompt: 'hi' }), (e: InferError) =>
    e.code === 'failed' && !/fake/.test(e.message));
  assert.equal((await inferBackend({ where: 'local', gguf, nano: broken })).name, 'on-device');
  for (const [code, want, phase] of [[9, 'busy', 'ready'], [30, 'busy', 'ready'], [12, 'too-large', 'ready'], [-100, 'failed', 'ready'],
    [606, 'unsupported', 'unsupported']] as const) {
    const n = new NanoModel({ binding: fakeNano({ failCode: code }).binding });
    await assert.rejects(n.complete({ prompt: 'hi' }), (e: InferError) => e.code === want);
    assert.equal(n.state.phase, phase, `a request-level ${code} keeps a working Nano`);
  }
});

test('Nano: abort cancels the native call, one call at a time, cut-off is never a summary, free text without a schema', async () => {
  const slow = fakeNano({ reply: () => new Promise(() => {}) });
  const nano = new NanoModel({ binding: slow.binding });
  const ctl = new AbortController();
  const running = nano.complete({ prompt: 'hi', signal: ctl.signal });
  await assert.rejects(nano.complete({ prompt: 'again' }), (e: InferError) => e.code === 'busy');
  assert.equal((await inferBackend({ where: 'local', gguf: await local(() => 'x'), nano })).local, nano, 'resolving during a call keeps Nano');
  await new Promise(r => setTimeout(r, 5));
  ctl.abort(new Error('stop'));
  await assert.rejects(running, /stop/);
  assert.equal(slow.cancels, 1);
  for (const code of ['not-installed', 'unsupported', 'failed'] as const) assert.match(errorWords(new InferError(code, 'x'), { nano: true }), /built-in/);
  await nano.release();
  assert.equal(slow.closed, 1);

  const cut = new NanoModel({ binding: fakeNano({ reply: () => ({ text: '{"enough":true,"lines":["Ru', finishReason: 1 }) }).binding });
  assert.deepEqual(await summarizePane(cut, ['$ npm test', 'running 42 tests in packages/accounts', 'not ok 1 - login refresh']), { ok: false, code: 'incomplete' });
  const lines = ['Running the accounts tests.', 'One test failed.', 'Login refresh is failing.'];
  // Nano v3 on a real phone answered "matching this JSON Schema" with the schema itself, verbatim in a json fence.
  // This fake does the same unless told the schema is not the answer; the echo must never pass as a summary.
  const echoed = '```json\n{"oneOf":[{"type":"object","additionalProperties":false,"required":["enough","lines"],"properties":{"lines":{"type":"array","minItems":3,"maxItems":4,"items":{"type":"string","minLength":1,"maxLength":100,"pattern":"^[^\\"\\\\\\\\\\\\r\\\\n]{1,100}$"}},"enough":{"const":true}}},{"type":"object","additionalProperties":false,"required":["enough","lines"],"properties":{"lines":{"const":[]},"enough":{"const":false}}}]}\n```';
  const phone = (r: { systemInstruction?: string }) => /it is not the answer/.test(r.systemInstruction ?? '')
    ? '```json\n' + JSON.stringify({ enough: true, lines }) + '\n```' : echoed;
  const ok = new NanoModel({ binding: fakeNano({ reply: phone }).binding });
  const s = await summarizePane(ok, ['$ npm test', 'running 42 tests in packages/accounts', 'not ok 1 - login refresh']);
  assert.deepEqual(s.ok && [s.lines, s.model], [lines, 'gemini-nano@nano-fake'], 'Nano is told the schema is not the answer');
  const echo = new NanoModel({ binding: fakeNano({ reply: () => echoed }).binding });
  assert.deepEqual(await summarizePane(echo, ['$ npm test', 'running 42 tests in packages/accounts', 'not ok 1 - login refresh']),
    { ok: false, code: 'invalid-output' }, 'an echoed schema is rejected, never a summary');
  const free = await (await inferBackend({ where: 'local', gguf: await local(() => 'x'), nano: new NanoModel({ binding: fakeNano({ reply: () => 'Plain words.' }).binding }) }))
    .generate({ prompt: 'hi' });
  assert.deepEqual([free.data, free.text], [null, 'Plain words.']);
});
