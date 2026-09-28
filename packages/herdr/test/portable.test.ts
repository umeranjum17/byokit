// `./device` is the phone, browser and React Native side: it must bundle with no Node import under the `browser`
// and `react-native` conditions (docs/runtime-kits.md 9, same approach as packages/accounts/test/portable.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

for (const condition of ['browser', 'react-native'] as const) {
  test(`./device bundles for ${condition} with nothing from Node`, async () => {
    const bundle = await build({
      entryPoints: [new URL('../src/device.ts', import.meta.url).pathname],
      bundle: true, platform: 'browser', format: 'esm', conditions: [condition],
      write: false, logLevel: 'silent', metafile: true,
    });
    const offending = Object.keys(bundle.metafile!.inputs).filter((f) => /(^|\/)(node:|node_modules\/)/.test(f));
    assert.deepEqual(offending, [], 'the device side imports no Node module');
  });
}
