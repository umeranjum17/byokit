// decide's published generate() over the on-device model: the structural backend type is decide's GenerationBackend,
// stays-here keeps it, and a cut-off answer is reported incomplete instead of as data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generate, type GenerationBackend } from '@byokit/decide';
import { LocalModel, generationBackend, model, type InferGenerationBackend, type InferModel } from '../src/index.ts';
import { fakeLlama, memoryModelStore } from '../src/testing.ts';

const BYTES = new TextEncoder().encode('GGUF');
const REV = 'b'.repeat(40);
const TINY: InferModel = { ...model(), id: 'tiny', revision: REV, url: `https://example.test/${REV}/tiny.gguf`, bytes: 4,
  sha256: createHash('sha256').update(BYTES).digest('hex') };
const assignable: GenerationBackend = null as unknown as InferGenerationBackend;
void assignable;

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
