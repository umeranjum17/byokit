// The main entry on a phone: bundled as React Native's bundler would, with nothing from Node, no network API used,
// and llama.rn supplied by the app (here the fake), never imported by the kit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

test('the main entry bundles for React Native with nothing from Node and never touches the network', async () => {
  const bundle = await build({
    stdin: {
      contents: `import { LocalModel, summarizePane, model } from '../src/index.ts';
        import { fakeLlama } from '../src/testing.ts';
        const bytes = new Uint8Array([71, 71, 85, 70]);
        const m = { ...model(), bytes: 4, sha256: 'b21c6d3dcc5c08ba2b0b8ac9e2b0a26fd4c7f6e5d7e0c86b0d1c7c0e44a8a2b0' };
        const store = { path: () => '/m.gguf', size: async () => 4, download: async () => {}, sha256: async () => m.sha256, remove: async () => {} };
        const local = new LocalModel({ model: m, store, initLlama: fakeLlama({ reply: () => JSON.stringify({ enough: true, lines: ['Tests are running.'] }) }).initLlama });
        globalThis.result = summarizePane(local, ['$ npm test', 'running 42 tests in packages/accounts, 12 done so far']);`,
      resolveDir: import.meta.dirname, sourcefile: 'phone.ts',
    },
    bundle: true, platform: 'browser', format: 'iife', conditions: ['react-native'], write: false, logLevel: 'silent', metafile: true,
  });
  assert.deepEqual(Object.keys(bundle.metafile!.inputs).filter(f => /node:|node_modules/.test(f)), []);
  const sandbox: any = { setTimeout, clearTimeout, AbortController, JSON, Object, Math, Date, Promise, Array, Map, String, Number, TextEncoder };
  runInNewContext(bundle.outputFiles[0].text, sandbox);
  const r = await sandbox.result;
  assert.deepEqual({ ok: r.ok, lines: [...r.lines] }, { ok: true, lines: ['Tests are running.'] });
  assert.doesNotMatch(bundle.outputFiles[0].text, /\bfetch\(|XMLHttpRequest|WebSocket/);
});
