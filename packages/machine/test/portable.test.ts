// `.` is the portable side: it must bundle for `browser` and `react-native` with no Node
// import (docs/machine-kit.md D-6/13.2, same approach as packages/herdr/test/portable.test.ts).
// `./idle` joins this test in M7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

for (const condition of ['browser', 'react-native'] as const) {
  test(`. bundles for ${condition} with nothing from Node`, async () => {
    const bundle = await build({
      entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
      bundle: true, platform: 'browser', format: 'esm', conditions: [condition],
      write: false, logLevel: 'silent', metafile: true,
    });
    // Pure-JS third-party deps bundle in; only Node builtins are forbidden.
    const offending = Object.keys(bundle.metafile!.inputs).filter((f) => /(^|\/)node:/.test(f));
    assert.deepEqual(offending, [], 'the portable entry imports no Node module');
  });
}
