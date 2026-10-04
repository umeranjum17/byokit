import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { Compose, ComposeError } from '../src/portable.ts';
import type { ComposeOptions } from '../src/portable.ts';
import { fakeEngine } from '../src/testing/fake-engine.ts';
import { composeContract } from '../src/testing/contract.ts';

composeContract(async () => {
  const fake = fakeEngine();
  return { compose: new Compose({ engine: fake }), fake };
}, {
  test: (name, fn) => test(`portable: ${name}`, fn),
});

test('the portable constructor requires an app engine, in types and at runtime', () => {
  if (false) {
    // @ts-expect-error portable callers cannot omit their engine
    new Compose();
    // @ts-expect-error the portable options require an engine
    const options: ComposeOptions = {};
    void options;
  }
  for (const options of [undefined, {}, { engine: {} }]) {
    assert.throws(() => new Compose(options as never), (e: unknown) => e instanceof ComposeError && e.code === 'invalid');
  }
});

test('built React Native and explicit portable exports run the protocol flow without Node or the default engine', async () => {
  for (const entry of ['@byokit/write', '@byokit/write/portable']) {
    const bundle = await build({
      stdin: { contents: readFileSync(new URL('./fixtures/portable.ts', import.meta.url), 'utf8')
        .replace("'@byokit/write'", JSON.stringify(entry)) + '\nglobalThis.result = portableFixture();', resolveDir: new URL('./fixtures/', import.meta.url).pathname, loader: 'ts' },
      bundle: true, platform: 'browser', conditions: ['react-native'], format: 'iife', target: 'es2019',
      write: false, metafile: true, logLevel: 'silent',
    });
    const inputs = Object.keys(bundle.metafile!.inputs);
    assert.ok(inputs.some(f => f.endsWith('/dist/portable.js')), 'the published built portable entry was selected');
    assert.deepEqual(inputs.filter(f => /node:|ownvoice-engine|\/engine\.[jt]s$|\/cli\.[jt]s$|\/compose\.[jt]s$/.test(f)), []);
    assert.doesNotMatch(bundle.outputFiles[0].text, /\brequire\(|\bprocess\.|\bBuffer\b/);
    const sandbox: { result?: Promise<any> } = {};
    runInNewContext(bundle.outputFiles[0].text, sandbox);
    const result = JSON.parse(JSON.stringify(await sandbox.result));
    assert.deepEqual(result.hello, { protocol: 1, version: '0.0.0-fixture' });
    assert.equal(result.guide, 'No em dashes.');
    assert.equal(result.platforms, 1);
    assert.deepEqual(result.checked.voice, ['says “delve” from your never-say list']);
    assert.deepEqual(result.checked.added, ['42']);
    assert.deepEqual(result.checked.dropped, ['41']);
    assert.deepEqual(result.posts, ['1/1 Hello there.']);
    assert.equal(result.invalid, 'invalid');
    assert.deepEqual(result.requests[5], { verb: 'check', params: { drafts: ['We delve into 42 tasks.'],
      platform: 'x', rules: { never: ['delve'], noDashes: false, statementEndings: false, note: '' },
      original: 'We had 41 tasks.' } });
    assert.deepEqual(result.verbs, ['hello', 'voice.parse', 'voice.guide', 'platforms', 'brief', 'check', 'split']);
  }
});
