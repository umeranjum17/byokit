// The frozen names: `.` and its React Native twin export the same names, with the native lookup stood in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as kit from '../src/index.ts';

const NAMES = ['SpeakError', 'browserEngine', 'createSpeaker', 'nativeEngine', 'speaker'];

test('the `.` entry carries the frozen names, and its speaker is unsupported', async () => {
  assert.deepEqual(Object.keys(kit).sort(), [...NAMES].sort());
  assert.equal(await kit.speaker.voices().then((v) => v.length), 0);
  await assert.rejects(kit.speaker.speak('Hi Umer').done, (e: unknown) => e instanceof kit.SpeakError && e.code === 'unavailable');
});

test('the React Native entry exports the same names over the native module', async () => {
  const result = await build({
    stdin: {
      contents: `export * as rn from './rn.ts';`,
      resolveDir: new URL('../src', import.meta.url).pathname, sourcefile: 'entries.ts', loader: 'ts',
    },
    bundle: true, write: false, platform: 'browser', format: 'esm', logLevel: 'silent',
    plugins: [{
      name: 'no-native', setup(b) {
        b.onResolve({ filter: /^expo-modules-core$/ }, () => ({ path: 'expo-modules-core', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const requireOptionalNativeModule = (name) => { (globalThis.looked ??= []).push(name); return null; };',
        }));
      },
    }],
  });
  const { rn } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assert.deepEqual(Object.keys(rn).sort(), [...NAMES].sort());
  assert.deepEqual((globalThis as { looked?: string[] }).looked, ['ByokitSpeak']);
  assert.deepEqual(await rn.speaker.voices(), [], 'no module is unsupported');
});
