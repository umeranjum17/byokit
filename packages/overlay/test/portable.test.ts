// Every platform (docs/capability-kits.md section 8): `.` and `./focused-field`, resolved through package.json's export
// map, bundle for browser and react-native with no Node import, and only rn.ts and focused-field.rn.ts load
// expo-modules-core. The default entries then load and report unsupported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

type Target = string | { [condition: string]: Target };
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, Target> };
const NATIVE = ['src/rn.ts', 'src/focused-field.rn.ts'];

/** The source file an export resolves to under `condition` (dist/x.js ↔ src/x.ts). */
function source(target: Target, condition: string): string {
  while (typeof target !== 'string') target = target[condition] ?? target.default;
  return target.replace(/^\.\/dist\/(.*)\.js$/, 'src/$1.ts');
}

for (const platform of ['browser', 'react-native'] as const) {
  for (const [entry, target] of Object.entries(pkg.exports)) {
    test(`${entry} bundles for ${platform} with no Node import`, async () => {
      const file = source(target, platform);
      assert.equal(file.startsWith('src/'), true, file);
      const result = await build({
        entryPoints: [new URL(`../${file}`, import.meta.url).pathname], bundle: true, write: false, metafile: true,
        platform: 'browser', format: 'esm', conditions: [platform], external: ['expo-modules-core'], logLevel: 'silent',
      });
      const imports = Object.entries(result.metafile.inputs).flatMap(([from, i]) => i.imports.map((to) => ({ from, to: to.path })));
      assert.deepEqual(imports.filter((i) => i.to.startsWith('node:')), [], 'no node:* import');
      const native = imports.filter((i) => i.to === 'expo-modules-core' || i.to.startsWith('expo-modules-core/'));
      for (const i of native) assert.ok(NATIVE.some((n) => i.from.endsWith(n)), `${i.from} imports expo-modules-core`);
      assert.equal(native.length, platform === 'react-native' ? 1 : 0, 'the native module only on react-native');
      if (platform === 'browser') {
        const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
        if (entry === '.') assert.equal(await mod.overlay.state(), 'unsupported');
        else assert.equal(await mod.focusedField.available(), false);
      }
    });
  }
}
