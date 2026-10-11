// The focused field (docs/capability-kits.md 7.4): the default entry is never available, and the React Native entry
// calls the native module, with the native lookup stood in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as field from '../src/focused-field.ts';
import type { InsertResult } from '../src/focused-field.ts';

test('`./focused-field` default is never available', async () => {
  assert.equal(await field.focusedField.available(), false);
  assert.equal(await field.focusedField.read(), null);
  assert.equal(await field.focusedField.insert('hi'), 'failed');
  assert.equal(await field.focusedField.insert('hi', { replace: 'all' }), 'failed');
  const controller = new AbortController();
  controller.abort();
  assert.equal(await field.focusedField.insert('hi', { signal: controller.signal }), 'cancelled');
});

test('the React Native focused field calls the native module, replacing the selection by default', async () => {
  const result = await build({
    stdin: {
      contents: `export { focusedField } from './focused-field.rn.ts';`,
      resolveDir: new URL('../src', import.meta.url).pathname, sourcefile: 'field.ts', loader: 'ts',
    },
    bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent',
    plugins: [{
      name: 'native', setup(b) {
        b.onResolve({ filter: /^expo-modules-core$/ }, () => ({ path: 'expo-modules-core', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: `export const requireOptionalNativeModule = () => ({
            createInsert: () => 'operation',
            cancelInsert: () => { (globalThis.cancels ??= []).push('operation'); globalThis.finishInsert?.('cancelled'); },
            available: async () => true,
            read: async () => ({ app: 'a', text: 'hi', selection: { start: 0, end: 2 } }),
            insert: async (...args) => {
              (globalThis.inserted ??= []).push(args);
              if (args[0] === 'pending') return new Promise(resolve => { globalThis.finishInsert = resolve; });
              return 'inserted';
            },
          });`,
        }));
      },
    }],
  });
  const { focusedField } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assert.equal(await focusedField.available(), true);
  assert.deepEqual(await focusedField.read(), { app: 'a', text: 'hi', selection: { start: 0, end: 2 } });
  assert.equal(await focusedField.insert('x'), 'inserted');
  assert.equal(await focusedField.insert('y', { replace: 'all' }), 'inserted');
  assert.equal(await focusedField.insert('z', { attempts: 13, retryMs: 150, acceptNewlineLoss: true }), 'inserted');
  assert.deepEqual((globalThis as { inserted?: unknown[] }).inserted, [
    ['x', { operationId: 'operation', replace: 'selection', attempts: 2, retryMs: 150, acceptNewlineLoss: false }],
    ['y', { operationId: 'operation', replace: 'all', attempts: 2, retryMs: 150, acceptNewlineLoss: false }],
    ['z', { operationId: 'operation', replace: 'selection', attempts: 13, retryMs: 150, acceptNewlineLoss: true }],
  ]);
  const controller = new AbortController();
  let completions = 0;
  const pending = focusedField.insert('pending', { signal: controller.signal }).then((result: InsertResult) => {
    completions++;
    return result;
  });
  controller.abort();
  controller.abort();
  assert.equal(await pending, 'cancelled');
  assert.equal(completions, 1);
  assert.deepEqual((globalThis as { cancels?: string[] }).cancels, ['operation']);
  assert.equal(await focusedField.insert('already cancelled', { signal: controller.signal }), 'cancelled');
  assert.equal((globalThis as { inserted?: unknown[] }).inserted?.length, 4);
});
