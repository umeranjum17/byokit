import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

test('the entry bundles for browsers and React Native without Node imports', async () => {
  const result = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true, platform: 'neutral', format: 'esm', conditions: ['react-native'], write: false, logLevel: 'silent',
  });
  assert.doesNotMatch(result.outputFiles[0].text, /\bfrom ["']node:|require\(["']node:/);
});
