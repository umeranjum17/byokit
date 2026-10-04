// Executes the published SDK adapter; only the React Native/JSI device transport is stubbed.
// Grammar receipts were produced by real b10256 formatter/converter/recognizer, without model inference.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import proof from '../../packages/infer/test/fixtures/summary-grammar-b10256.json' with { type: 'json' };
import captured from '../../packages/infer/test/fixtures/final-explicit-result.json' with { type: 'json' };
import { LocalModel, model, summarizePane } from '../../packages/infer/src/index.ts';
import { REALISTIC_PANE } from './infer-pane-fixture.ts';
import type { InitLlama } from '../../packages/infer/src/model.ts';

test('kit -> published 0.12.9 formatter -> JSI dispatch carries the supported grammar, not just a JSON argument', async () => {
  assert.equal(JSON.parse(readFileSync(new URL('./node_modules/llama.rn/package.json', import.meta.url), 'utf8')).version, '0.12.9');
  const sdk = readFileSync(new URL('./node_modules/llama.rn/src/index.ts', import.meta.url), 'utf8');
  const keys = [...sdk.match(/const jsiBindingKeys = \[([\s\S]*?)\] as const/)![1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  const calls: any[] = [], formats: any[] = [];
  const sandbox: any = { console, setTimeout, clearTimeout, AbortController, TextEncoder };
  sandbox.global = sandbox;
  for (const key of keys) sandbox[key] = async () => undefined;
  sandbox.llamaInitContext = async () => ({ contextId: 1, gpu: false, devices: [], reasonNoGPU: '', model: {
    metadata: { 'tokenizer.chat_template': 'owned fixed template' }, chatTemplates: { jinja: { default: true } },
  } });
  sandbox.llamaTokenize = async () => ({ tokens: [1] });
  sandbox.llamaGetFormattedChat = async (_id: number, messages: string, _template: unknown, params: any) => {
    formats.push(params);
    assert.equal(params.jinja, true);
    const schema = JSON.parse(params.json_schema);
    assert.deepEqual(schema, proof.schema);
    for (const branch of schema.oneOf) assert.deepEqual(Object.keys(branch.properties), ['lines', 'enough'],
      'serialized member order must reach the real formatter, not just compare as equal JSON objects');
    assert.equal(JSON.parse(messages)[0].content, proof.system);
    return { ...proof.corrected.jinja };
  };
  sandbox.llamaCompletion = async (_id: number, params: any) => {
    calls.push(params);
    return { text: captured.text, tokens_evaluated: 1004, tokens_predicted: 75, stopped_eos: true, stopped_limit: 0 };
  };
  const bundled = await build({ entryPoints: [new URL('./node_modules/llama.rn/src/index.ts', import.meta.url).pathname],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'StockSDK', write: false, logLevel: 'silent',
    plugins: [{ name: 'device-transport-only', setup(b) {
      b.onResolve({ filter: /^react-native$/ }, () => ({ path: 'rn', namespace: 'transport' }));
      b.onLoad({ filter: /.*/, namespace: 'transport' }, () => ({ contents:
        "export const Platform={OS:'android'}; export const TurboModuleRegistry={get:()=>({install:async()=>true})};" }));
    } }],
  });
  runInNewContext(bundled.outputFiles[0].text, sandbox);
  const pinned = { ...model(), bytes: 4, sha256: 'a'.repeat(64) };
  const local = new LocalModel({ model: pinned, initLlama: sandbox.StockSDK.initLlama as InitLlama,
    store: { path: () => '/owned/fixed.gguf', size: async () => 4, sha256: async () => pinned.sha256,
      download: async () => {}, remove: async () => {} }, device: { platform: 'android' } });
  assert.deepEqual(await summarizePane(local, REALISTIC_PANE), { ok: false, code: 'invalid-output' });
  assert.equal(formats.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].grammar, proof.corrected.jinja.grammar);
  assert.equal(calls[0].grammar_lazy, false);
  assert.equal(calls[0].generation_prompt, proof.corrected.jinja.generation_prompt);
  assert.equal(calls[0].json_schema, undefined, 'SDK prefers actual formatted grammar over schema fallback');
  assert.equal(proof.old.checks.exact_native_raw_accepted_by_jinja, true);
  assert.equal(proof.corrected.checks.exact_native_raw_accepted_by_jinja, false);
  const positives = new Set(['true3', 'true4', 'false_empty', 'line100']);
  for (const [name, accepted] of Object.entries(proof.corrected.checks)) assert.equal(accepted, positives.has(name), name);
  await local.release();
});
