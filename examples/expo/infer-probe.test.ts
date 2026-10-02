import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeLlama } from '../../packages/infer/src/testing.ts';
import { completionProbe } from './infer-probe.ts';
import type { LlamaRnCompletionParams } from '../../packages/infer/src/model.ts';

test('own-lab completion observer preserves options/context/output and records before the caller parses', async () => {
  const llama = fakeLlama({ reply: () => ({ text: '{"enough":true,"lines":["A fixed demo line."]}', content: 'different filtered content',
    tokens_predicted: 7, tokens_evaluated: 12, stopped_limit: 0 }) });
  const params = { model: '/own-lab/fixed.gguf', n_ctx: 2048, n_threads: 4, n_gpu_layers: 0, use_mlock: false, use_mmap: true };
  const native = await llama.initLlama(params);
  const release = native.release, tokenize = native.tokenize, stop = native.stopCompletion;
  const records: Record<string, unknown>[] = [];
  const ctx = await completionProbe(async p => { assert.strictEqual(p, params); return native; }, async entry => { records.push(entry); })(params);
  assert.strictEqual(ctx, native);
  assert.strictEqual(ctx.release, release);
  assert.strictEqual(ctx.tokenize, tokenize);
  assert.strictEqual(ctx.stopCompletion, stop);
  const options: LlamaRnCompletionParams = { messages: [{ role: 'user', content: 'Fixed synthetic pane.' }], jinja: true,
    enable_thinking: false, n_predict: 200, temperature: 0, seed: 0,
    response_format: { type: 'json_schema', json_schema: { strict: true, schema: { type: 'object' } } } };
  const result = await ctx.completion(options);
  assert.strictEqual(llama.contexts[0].completions[0], options);
  assert.deepEqual(records[0], { kind: 'request', options });
  assert.equal(records[1].kind, 'result');
  assert.equal(records[1].text, result.text);
  assert.equal(records[1].content, result.content);
  assert.equal(records[1].adapterText, 'different filtered content');
  assert.equal(records[1].tokens_evaluated, 12);
  assert.equal(records[1].tokens_predicted, 7);
  assert.equal(records[1].stopped_limit, 0);
  assert.equal(typeof records[1].elapsedMs, 'number');
  assert.equal(records.length, 2, 'request/result already captured before any caller parsing');
  await ctx.release();
  assert.equal(llama.contexts[0].released, true);
});
