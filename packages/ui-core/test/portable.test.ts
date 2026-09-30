// ui-core draws in browsers and React Native too: every entry bundles under the `browser` and `react-native`
// conditions with nothing from Node, and `./kits` with no React either. The kits' real device clients fit the hooks
// and stores as they are (checked by `npm run check`; `fits` never runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import type { DeviceLink } from '@byokit/link';
import { herdrDevice } from '../../herdr/src/device.ts';
import { openclawDevice } from '../../openclaw/src/device.ts';
import { words as ocWords } from '../../openclaw/src/words.ts';
import { approvalsStore, herdrStore, runStore, useApprovals, useBlocked, useHerdrTree, useRun } from '../src/index.ts';

for (const condition of ['browser', 'react-native'] as const) {
  for (const entry of ['index', 'kits', 'phase', 'route', 'link', 'steps']) {
    test(`${entry} bundles for ${condition} with nothing from Node${entry === 'kits' ? ' and no React' : ''}`, async () => {
      const bundle = await build({
        entryPoints: [new URL(`../src/${entry}.ts`, import.meta.url).pathname],
        bundle: true, platform: 'browser', format: 'esm', conditions: [condition], external: ['react'],
        write: false, logLevel: 'silent', metafile: true,
      });
      const inputs = Object.keys(bundle.metafile!.inputs);
      assert.deepEqual(inputs.filter((f) => /(^|\/)node:/.test(f)), [], 'no Node module');
      const imports = Object.values(bundle.metafile!.outputs).flatMap((o) => o.imports.map((i) => i.path));
      if (entry === 'kits') assert.deepEqual(imports, [], 'nothing left to import, React included');
    });
  }
}

export const fits = (link: DeviceLink) => {
  const oc = openclawDevice(link);
  const hd = herdrDevice(link);
  runStore(oc);
  approvalsStore(oc);
  herdrStore(hd);
  useRun(oc, { words: ocWords, name: 'ChatGPT' });
  useApprovals(oc);
  useHerdrTree(hd);
  useBlocked(hd);
};
