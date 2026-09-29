// The frozen names (docs/capability-kits.md 12.3): `.` and its React Native twin export the same names, with the
// native lookup stood in for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as kit from '../src/index.ts';
import type {
  NativeStatus, ShowOptions, Status, StatusAction, StatusEvent, StatusEventType, StatusState,
} from '../src/index.ts';

const NAMES = ['createStatus', 'stateWords', 'status', 'words'];

test('the `.` entry carries the frozen names, and its status is unsupported', async () => {
  assert.deepEqual(Object.keys(kit).sort(), NAMES);
  for (const n of NAMES.filter((n) => n !== 'status')) assert.equal(typeof kit[n as keyof typeof kit], 'function', n);
  assert.equal(await kit.status.state(), 'unsupported');
});

test('the React Native entry exports the same names over the native module', async () => {
  // Bundled with a stand-in expo-modules-core that records each lookup and finds no module, as on iOS.
  const result = await build({
    stdin: { contents: `export * as rn from './rn.ts';`, resolveDir: new URL('../src', import.meta.url).pathname, sourcefile: 'entries.ts', loader: 'ts' },
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
  assert.deepEqual(Object.keys(rn).sort(), NAMES);
  assert.deepEqual((globalThis as { looked?: string[] }).looked, ['ByokitStatus']);
  assert.equal(await rn.status.state(), 'unsupported', 'no module (iOS) is unsupported');
});

test('public types keep their frozen shapes (12.3)', () => {
  const states: StatusState[] = ['on', 'off', 'needs-permission', 'unsupported'];
  const action: StatusAction = { id: 'open', label: 'Open' };
  const show: ShowOptions = { title: 't', text: 'x', chip: 'c', publicText: 'p', promote: true, actions: [action], timeoutMs: 1000, icon: 'i' };
  const events: StatusEvent[] = [{ type: 'action', id: 'open' }, { type: 'dismissed' }];
  const types: StatusEventType[] = ['action', 'dismissed'];
  const s: Status = kit.createStatus(null);
  s.on('action', (e) => { const id: string = e.id; void id; });
  const n: Pick<NativeStatus, 'show'> = { show: (o: ShowOptions & { channel: string }) => { void o; } };
  void [states, show, events, types, n];
});
