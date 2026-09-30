import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

test('default entry bundles for browsers without native or Node runtime imports', async () => {
  const result = await build({entryPoints:[fileURLToPath(new URL('../src/index.ts',import.meta.url))],bundle:true,write:false,platform:'browser',metafile:true});
  assert.ok(result.outputFiles.length);
  for (const path of Object.keys(result.metafile!.inputs)) assert.doesNotMatch(path,/expo-modules-core|pi-ai|node:/);
});
