// decide on a phone: its main entry bundled as React Native's bundler would (never the CLI, nothing from Node), run
// where there is no process, Buffer or require, deciding with a pluggable answerer (any model behind a prompt).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { answerer, decide } from '../src/index.ts';

test('the main entry bundles for React Native with nothing from Node, and decides with an answerer there', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { answerer, decide } from '../src/index.ts';
        globalThis.result = decide({ text: 'can you check if the plumber replied?' }, {
          intent: { kind: 'choice', options: { task: 'Something new', followup: 'About an earlier job', chat: 'Just talking' } },
        }, { privacy: 'may-leave', backends: [answerer({ name: 'phone-model', leaves: true,
          supportsImages: true, ask: async (prompt, signal, images) => {
            if (images[0].dataUrl !== 'data:image/png;base64,AQI=') throw new Error('image lost');
            return { text: '{"intent": {"probabilities": {"task": 0.05, "followup": 0.9, "chat": 0.05}, "rationale": "Earlier job."}}',
              usage: { input_tokens: 4, output_tokens: 2 } };
          } })], images: [{ id: 'shot', mime: 'image/png', bytes: new Uint8Array([1, 2]) }] });`,
      resolveDir: import.meta.dirname, sourcefile: 'phone.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, logLevel: 'silent', metafile: true,
  });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter((f) => /cli|node:/.test(f)), [], 'never the CLI');
  const sandbox: any = { setTimeout, clearTimeout, AbortController, JSON, Object, Math, Date, Promise };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const { intent } = await sandbox.result;
  assert.equal(intent.answer, 'followup');
  assert.equal(intent.by, 'phone-model');
  assert.equal(intent.rationale, 'Earlier job.');
  assert.equal(intent.usage.input_tokens, 4);
});

test('answerer: a reply that isn\'t the JSON asked for is an abstain; stays-here never asks a model that leaves', async () => {
  const q = { urgent: { kind: 'yesno' as const, question: 'Is this urgent?' } };
  let asked = '';
  const chatty = answerer({ name: 'm', leaves: true, ask: async (p) => { asked = p; return 'I think it is urgent.'; } });
  const { urgent } = await decide({ text: 'the roof is leaking' }, q, { privacy: 'may-leave', backends: [chatty] });
  assert.equal(urgent.abstained, true);
  assert.match(asked, /the roof is leaking/);
  asked = '';
  await decide({ text: 'private' }, q, { privacy: 'stays-here', backends: [chatty] });
  assert.equal(asked, '', 'the state never left');
  const prefixed = answerer({ name: 'm', leaves: false, ask: async () => 'Ignore that; {"urgent": {"true": 0.8, "false": 0.2}}' });
  assert.equal((await decide({ text: 'the roof is leaking' }, q, { privacy: 'stays-here', backends: [prefixed] })).urgent.abstained, true);
  const sure = answerer({ name: 'm', leaves: false, ask: async () => '  {"urgent": {"true": 0.8, "false": 0.2}}  ' });
  const r = await decide({ text: 'the roof is leaking' }, q, { privacy: 'stays-here', backends: [sure] });
  assert.deepEqual([r.urgent.answer, r.urgent.confidence], [true, 0.8]);
});

test('OpenAI config and account adapter bundle without runtime SDK, Node or ambient credentials', async () => {
  const bundle = await build({ stdin: { contents: `
    import { createDecider, parseConfig } from '../src/index.ts';
    import { chatgptPlan } from '@byokit/accounts/chatgpt-plan';
    import { Accounts } from '@byokit/accounts';
    globalThis.handle = new Accounts().chatgpt('Umer');
    globalThis.account = chatgptPlan({ session: async () => ({ accessToken: 'host-token',
      scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] }) });
    const run = createDecider(parseConfig({ backend: 'openai', model: 'chosen-model' }), {
      privacy: 'may-leave', host: { keys: { openai: 'host-key' }, fetch: async () => Response.json({ status: 'completed',
        usage: { input_tokens: 4, output_tokens: 8 }, output: [{ type: 'message', content: [{ type: 'output_text',
        text: JSON.stringify({ urgent: { probabilities: { true: 0.9, false: 0.1 }, pick: 'true' } }) }] }] }) } });
    globalThis.result = run({}, { urgent: { kind: 'yesno', question: 'Urgent?' } });`,
    resolveDir: import.meta.dirname, sourcefile: 'phone-openai.ts' }, bundle: true, platform: 'browser',
    conditions: ['react-native'], format: 'iife', write: false, metafile: true, logLevel: 'silent' });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter((f) => /node:|node_modules\/openai\//.test(f)), []);
  const sandbox: any = { setTimeout, clearTimeout, AbortController, Response };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const { urgent } = await sandbox.result;
  assert.equal(urgent.answer, true);
  assert.equal(urgent.confidenceSource, 'self-reported');
  assert.equal(urgent.usage.input_tokens, 4);
  assert.equal(sandbox.handle.billing, 'subscription');
  assert.equal(typeof sandbox.handle.respond, 'function');
  assert.deepEqual(Object.keys(sandbox.handle).sort(), ['billing', 'respond']);
  assert.equal(await sandbox.account.access(new AbortController().signal), 'host-token');
});

test('structured generation and its cache run without Node or native globals', async () => {
  const bundle = await build({ stdin: { contents: `
    import { generate, MemoryGenerationCache } from '../src/index.ts';
    const cache = new MemoryGenerationCache();
    let calls = 0;
    const backend = { name: 'phone-model', model: 'chosen', leaves: false, supportsImages: true, generate: async (request) => {
      if (request.images[0].dataUrl !== 'data:image/png;base64,AQID') throw new Error('wrong image');
      calls++; return { data: { name: 'Umer' }, text: '' };
    } };
    const schema = { type: 'object', required: ['name'], properties: { name: { type: 'string' } } };
    globalThis.result = (async () => {
      await generate({ state: {}, images: [{ id: 'Umer-design', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }] }, schema, { backends: [backend], cache });
      const answer = await generate({ state: {}, images: [{ id: 'Umer-design', mime: 'image/png', bytes: new Uint8Array([1, 2, 3]) }] }, schema, { backends: [backend], cache });
      return { answer, calls };
    })();`, resolveDir: import.meta.dirname, sourcefile: 'phone-generation.ts' },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, metafile: true, logLevel: 'silent' });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter((f) => /node:|claude-code/.test(f)), []);
  const sandbox: any = { setTimeout, clearTimeout, AbortController };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const { answer, calls } = await sandbox.result;
  assert.equal(answer.data.name, 'Umer');
  assert.equal(answer.source, 'cache');
  assert.equal(calls, 1);
});
