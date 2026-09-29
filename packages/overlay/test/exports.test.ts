// The frozen names (docs/capability-kits.md 7.3, 7.4): `.` and its React Native twin export the same names, and
// `./focused-field` and its twin too, with the native lookup stood in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as kit from '../src/index.ts';
import * as field from '../src/focused-field.ts';
import type {
  AppRules, Edge, ForegroundNotice, HostKind, NativeOverlay, Overlay, OverlayEvent, OverlayEventType, OverlayState,
  StartOptions, TapEntry,
} from '../src/index.ts';
import type { FocusedField, FocusedText, InsertResult } from '../src/focused-field.ts';

const NAMES = ['createOverlay', 'overlay', 'resetApp', 'setApp', 'shownFor', 'stateWords', 'words'];

test('the `.` entry carries the frozen names, and its overlay is unsupported', async () => {
  assert.deepEqual(Object.keys(kit).sort(), NAMES);
  for (const n of NAMES.filter((n) => n !== 'overlay')) assert.equal(typeof kit[n as keyof typeof kit], 'function', n);
  assert.equal(await kit.overlay.state(), 'unsupported');
});

test('`./focused-field` default is never available', async () => {
  assert.deepEqual(Object.keys(field), ['focusedField']);
  assert.equal(await field.focusedField.available(), false);
  assert.equal(await field.focusedField.read(), null);
  assert.equal(await field.focusedField.insert('hi'), 'failed');
  assert.equal(await field.focusedField.insert('hi', { replace: 'all' }), 'failed');
});

test('the React Native entries export the same names over the native module', async () => {
  // Bundled with a stand-in expo-modules-core that records each lookup and finds no module, as on iOS.
  const result = await build({
    stdin: {
      contents: `export * as rn from './rn.ts'; export * as field from './focused-field.rn.ts';`,
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
  const { rn, field: rnField } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
  assert.deepEqual(Object.keys(rn).sort(), NAMES);
  assert.deepEqual(Object.keys(rnField), ['focusedField']);
  assert.deepEqual((globalThis as { looked?: string[] }).looked, ['ByokitOverlay', 'ByokitFocusedField']);
  assert.equal(await rn.overlay.state(), 'unsupported', 'no module (iOS) is unsupported');
  assert.equal(await rnField.focusedField.available(), false);
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
            available: async () => true,
            read: async () => ({ app: 'a', text: 'hi', selection: { start: 0, end: 2 } }),
            insert: async (...args) => { (globalThis.inserted ??= []).push(args); return 'inserted'; },
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
  assert.deepEqual((globalThis as { inserted?: unknown[] }).inserted, [['x', 'selection'], ['y', 'all']]);
});

test('public types keep their frozen shapes (7.3, 7.4)', () => {
  const state: OverlayState[] = ['on', 'off', 'stuck', 'needs-permission', 'unsupported'];
  const hosts: HostKind[] = ['window', 'accessibility'];
  const edges: Edge[] = ['left', 'right'];
  const rules: AppRules = { paused: false, on: ['a'], off: ['b'], defaults: ['c'] };
  const notice: ForegroundNotice = { channel: 'c', title: 't', text: 'x', icon: 'i' };
  const start: StartOptions = { host: 'window', mood: 'calm', notice, panel: 'Panel', hideWhilePanelOpen: true, spots: 'global' };
  const events: OverlayEvent[] = [
    { type: 'tap' }, { type: 'longPress' }, { type: 'moved', edge: 'left', y: 0.5 }, { type: 'state', state: 'on' }, { type: 'panel', open: true },
  ];
  const types: OverlayEventType[] = ['tap', 'longPress', 'moved', 'state', 'panel'];
  // @ts-expect-error the tap log has no text field (D-O)
  const tap: TapEntry = { app: 'a', at: 1, action: 'tap', text: 'x' };
  const text: FocusedText = { app: 'a', text: 'hi', selection: null };
  const results: InsertResult[] = ['inserted', 'copied', 'failed'];
  const o: Overlay = kit.createOverlay(null);
  o.on('moved', (e) => { const y: number = e.y; void y; });
  const n: Pick<NativeOverlay, 'say' | 'taps'> = { say: (_t, _m: string | null, _ms: number) => {}, taps: async (_since: number) => [] };
  const f: FocusedField = field.focusedField;
  void [state, hosts, edges, rules, start, events, types, tap, text, results, n, f];
});
