import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const peers = ['expo-modules-core', 'expo-share-intent', 'expo-linking', 'react', 'react-native'];
test('export map selects portable or RN plus plugin and metadata only', () => {
  assert.deepEqual(Object.keys(pkg.exports), ['.', './app.plugin.js', './package.json']);
  assert.equal(pkg.exports['.'].default, './dist/index.js');
  assert.equal(pkg.exports['.']['react-native'].default, './dist/rn.js');
});
for (const entry of ['index', 'rn']) test(`${entry} bundles with native runtimes only in rn.ts and no Node imports`, async () => {
  const result = await build({ entryPoints: [new URL(`../src/${entry}.ts`, import.meta.url).pathname],
    bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm', external: peers, logLevel: 'silent' });
  for (const [from, input] of Object.entries(result.metafile!.inputs)) for (const item of input.imports) {
    assert.equal(item.path.startsWith('node:'), false);
    if (peers.includes(item.path)) assert.ok(from.endsWith('/src/rn.ts'), `${item.path} imported by ${from}`);
  }
  if (entry === 'index') {
    const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
    assert.equal(mod.shareSupported, false);
    for (const peer of peers) assert.equal(Object.values(result.metafile!.outputs).some((o) => o.imports.some((i) => i.path === peer)), false);
  }
});
