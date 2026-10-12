// The slim install story: a tool depending on @byokit/decide for rules, any host-owned model or Jev
// installs no account, OpenAI SDK or pairing tree. The slim source graph is only sibling kit files, the
// manifest carries those trees as optional peers, and account billing without the peer names it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { decide as slimDecide, rules as slimRules, jev as slimJev, MemoryCache as SlimCache } from '../src/slim.ts';
import { decide, openai, UnsupportedAccountError } from '@byokit/decide';
import { jev as mainJev } from '@byokit/decide';
import * as slimBuilt from '@byokit/decide/slim';

test('the slim source graph is only sibling kit files, and decides in a sandbox with no peers', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { decide, rules, jev, MemoryCache } from '../src/slim.ts';
        const cache = new MemoryCache();
        const backends = [rules((s) => (/^thanks\\b/i.test(s.text) ? 'chat' : undefined)),
          jev({ key: 'slim-key', fetch: async () => ({ ok: true, json: async () => ({ answers: {
            intent: { choice: 'followup', probabilities: { task: 0.05, followup: 0.9, chat: 0.05 }, confidence: 0.9 } },
            usage: { input_tokens: 4, output_tokens: 2 } }) }) })];
        const questions = { intent: { kind: 'choice', options: { task: 'New', followup: 'Earlier', chat: 'Talking' } } };
        globalThis.result = (async () => {
          const first = await decide({ text: 'can you check if the plumber replied?' }, questions, { privacy: 'may-leave', backends, cache });
          const again = await decide({ text: 'can you check if the plumber replied?' }, questions, { privacy: 'may-leave', backends, cache });
          const local = await decide({ text: 'thanks, that worked!' }, questions, { privacy: 'stays-here', backends });
          return { first, again, local };
        })();`,
      resolveDir: import.meta.dirname, sourcefile: 'slim-phone.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, logLevel: 'silent', metafile: true,
  });
  const inputs = Object.keys(bundle.metafile!.inputs).map((f) => f.split('/').slice(-2).join('/'))
    .filter((f) => f !== 'test/slim-phone.ts');
  assert.deepEqual([...inputs].sort(), ['src/account-error.ts', 'src/core.ts', 'src/http.ts', 'src/images.ts',
    'src/jev.ts', 'src/paired-errors.ts', 'src/prompt.ts', 'src/slim.ts'].sort(),
    'slim bundles only sibling kit files: no peers, no Node, no other entry');
  const sandbox: any = { setTimeout, clearTimeout, AbortController, JSON, Object, Math, Date, Promise };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const { first, again, local } = await sandbox.result;
  assert.equal(first.intent.answer, 'followup');
  assert.equal(first.intent.by, 'jev');
  assert.equal(first.intent.usage.input_tokens, 4);
  assert.equal(first.intent.source, 'api');
  assert.equal(again.intent.source, 'cache');
  assert.equal(local.intent.answer, 'chat');
  assert.equal(local.intent.by, 'rules');
});

test('the slim source entry and the packed export agree with the main entry', async () => {
  assert.equal(typeof slimDecide, 'function');
  assert.equal(typeof slimRules, 'function');
  assert.equal(typeof slimJev, 'function');
  assert.equal(typeof SlimCache, 'function');
  assert.equal(typeof slimBuilt.decide, 'function');
  assert.equal(typeof slimBuilt.rules, 'function');
  assert.equal(typeof slimBuilt.jev, 'function');
  const backends = [slimRules(() => 'chat')];
  const questions = { intent: { kind: 'choice' as const, options: { task: 'New', followup: 'Earlier', chat: 'Talking' } } };
  const viaSlim = await slimBuilt.decide({ text: 'hi' }, questions, { privacy: 'stays-here', backends });
  const viaMain = await decide({ text: 'hi' }, questions, { privacy: 'stays-here', backends });
  assert.equal(viaSlim.intent.answer, 'chat');
  assert.equal(viaMain.intent.answer, 'chat');
  assert.equal(typeof mainJev, 'function');
});

test('the manifest installs no tree: optional peers only, with the slim export', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>; exports?: Record<string, unknown>;
  };
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'no runtime dependencies: nothing to install');
  assert.deepEqual(manifest.peerDependencies, { '@byokit/accounts': '0.21.0', openai: '7.25.0', '@byokit/pair': '0.9.0' });
  for (const peer of Object.keys(manifest.peerDependencies!)) {
    assert.equal(manifest.peerDependenciesMeta?.[peer]?.optional, true, `${peer} stays optional`);
  }
  assert.ok(manifest.exports?.['./slim'], 'the slim export is published');
});

test('account billing without the account peer names the missing package', async () => {
  const questions = { urgent: { kind: 'yesno' as const, question: 'Is this urgent?' } };
  assert.throws(() => openai({ model: 'gpt-6.1-sol', auth: 'account', account: undefined as never }),
    (e: unknown) => e instanceof UnsupportedAccountError && /@byokit\/accounts/.test((e as Error).message));
  await assert.rejects(
    decide({ text: 'hi' }, questions, { privacy: 'may-leave',
      config: { backend: 'openai', auth: 'account', model: 'gpt-6.1-sol' }, host: {} }),
    (e: unknown) => e instanceof UnsupportedAccountError && /@byokit\/accounts/.test((e as Error).message));
});
