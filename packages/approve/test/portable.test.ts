import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import type { ApprovalsOptions } from '../src/index.ts';

// Compile-time proof: the options are plain data with no platform seams.
const options: ApprovalsOptions = { ttlMs: 60_000, now: () => 0 };
void options;

test('the entry bundles for browsers and React Native without Node imports', async () => {
  const result = await build({
    entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
    bundle: true, platform: 'neutral', format: 'esm', conditions: ['react-native'], write: false, logLevel: 'silent',
  });
  assert.doesNotMatch(result.outputFiles[0].text, /\bfrom ["']node:|require\(["']node:/);
});
