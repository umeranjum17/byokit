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
          ask: async () => 'Sure: {"intent": {"task": 0.05, "followup": 0.9, "chat": 0.05}}' })] });`,
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
  const sure = answerer({ name: 'm', leaves: false, ask: async () => '{"urgent": {"true": 0.8, "false": 0.2}}' });
  const r = await decide({ text: 'the roof is leaking' }, q, { privacy: 'stays-here', backends: [sure] });
  assert.deepEqual([r.urgent.answer, r.urgent.confidence], [true, 0.8]);
});
