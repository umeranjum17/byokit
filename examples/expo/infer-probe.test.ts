import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { REALISTIC_PANE } from './infer-pane-fixture.ts';
import { LocalModel, InferError, paneText, model } from '../../packages/infer/src/index.ts';
import { memoryModelStore } from '../../packages/infer/src/testing.ts';
import { fakeLlama } from '../../packages/infer/src/testing.ts';
import { completionProbe } from './infer-probe.ts';
import type { LlamaRnCompletionParams } from '../../packages/infer/src/model.ts';

test('fixed realistic pane fits unchanged line/character preparation limits without dropping lines', () => {
  assert.ok(REALISTIC_PANE.length <= 80);
  assert.ok(REALISTIC_PANE.join('\n').length <= 6000);
  assert.deepEqual(paneText(REALISTIC_PANE), REALISTIC_PANE.map(line => line.replace(/</g, '‹').replace(/>/g, '›')),
    'normal chat-token neutralization only; no dropped, truncated or redacted lines');
});

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

test('own-lab rejection receipt is bounded and precedes the safe kit wrapper without replacing the cause', async () => {
  const failure = new Error('synthetic native rejection ' + 'x'.repeat(5000));
  failure.stack = 'synthetic stack ' + 'y'.repeat(10000);
  const bytes = new TextEncoder().encode('fixed synthetic weights');
  const pinned = { ...model(), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const llama = fakeLlama({ reply: () => Promise.reject(failure) });
  const records: Record<string, unknown>[] = [], order: string[] = [];
  const init = completionProbe(llama.initLlama, async entry => { records.push(entry); order.push(String(entry.kind)); });
  const local = new LocalModel({ model: pinned, store: memoryModelStore({ [pinned.url]: bytes }).store, initLlama: init,
    onState: state => { if (state.phase === 'failed') order.push('safe-failed'); } });
  await local.install();
  await assert.rejects(local.complete({ prompt: 'Fixed synthetic pane.' }), e =>
    e instanceof InferError && e.code === 'failed' && e.cause === failure);
  assert.deepEqual(order, ['request', 'rejection', 'safe-failed']);
  assert.equal(records[1].name, 'Error');
  assert.equal(records[1].message, failure.message.slice(0, 4096));
  assert.equal(records[1].stack, failure.stack.slice(0, 8192));
  assert.equal(records[1].truncated, true);
  assert.equal(typeof records[1].elapsedMs, 'number');
  await local.release();
  const ctx = await completionProbe(llama.initLlama, async entry => {
    if (entry.kind === 'rejection') throw new Error('synthetic recorder failure');
  })({ model: '/own-lab/fixed.gguf', n_ctx: 2048, n_threads: 4, n_gpu_layers: 0, use_mlock: false, use_mmap: true });
  await assert.rejects(ctx.completion({ messages: [], jinja: true, enable_thinking: false, n_predict: 200, temperature: 0, seed: 0 }), e => e === failure);
  await ctx.release();
});
