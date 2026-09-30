// Every platform (docs/capability-kits.md 12.2, section 8): `.`, resolved through package.json's export map, bundles
// for browser and react-native with no Node import, and only rn.ts loads expo-modules-core. The default entry then
// loads and reports unsupported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

type Target = string | { [condition: string]: Target };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, Target> };

/** The source file an export resolves to under `condition` (dist/x.js ↔ src/x.ts). */
function source(target: Target, condition: string): string {
  while (typeof target !== 'string') target = target[condition] ?? target.default;
  return target.replace(/^\.\/dist\/(.*)\.js$/, 'src/$1.ts');
}

test('exports include the runtime, Expo config plugin and package metadata', () =>
  assert.deepEqual(Object.keys(pkg.exports), ['.', './app.plugin.js', './package.json']));

for (const platform of ['browser', 'react-native'] as const) {
  test(`. bundles for ${platform} with no Node import`, async () => {
    const file = source(pkg.exports['.'], platform);
    assert.equal(file.startsWith('src/'), true, file);
    const result = await build({
      entryPoints: [new URL(`../${file}`, import.meta.url).pathname], bundle: true, write: false, metafile: true,
      platform: 'browser', format: 'esm', conditions: [platform], external: ['expo-modules-core'], logLevel: 'silent',
    });
    const imports = Object.entries(result.metafile.inputs).flatMap(([from, i]) => i.imports.map((to) => ({ from, to: to.path })));
    assert.deepEqual(imports.filter((i) => i.to.startsWith('node:')), [], 'no node:* import');
    const native = imports.filter((i) => i.to === 'expo-modules-core' || i.to.startsWith('expo-modules-core/'));
    for (const i of native) assert.ok(i.from.endsWith('src/rn.ts'), `${i.from} imports expo-modules-core`);
    assert.equal(native.length, platform === 'react-native' ? 1 : 0, 'the native module only on react-native');
    if (platform === 'browser') {
      const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
      assert.equal(await mod.status.state(), 'unsupported');
    }
  });
}
