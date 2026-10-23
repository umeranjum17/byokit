import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { cloudRecipe } from './cloud-m6.ts';

// Execute the actual demo export with inert native views/hooks and a fake machine.
// This checks callback/display behavior, not a painted or physical-phone journey.
test('M6 installs the host on the machine loopback with no network join, and pairs only through an SSH module', async () => {
  for (const ssh of [undefined, { transport: {}, publicKey: 'ssh-ed25519 AAAA lab' }]) {
    const notes: string[] = [], installed: unknown[] = [];
    const computer = {
      ref: { name: 'fixture' }, state: async () => 'on',
      install: async (r: unknown) => { installed.push(r); }, host: async () => 'running',
    };
    let state = 0;
    const jsx = (type: unknown, props: any) => ({ type, props });
    const modules: Record<string, unknown> = {
      react: { useEffect: () => {}, useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [++state === 2 ? 'fixture' : state === 3 ? true : initial,
          (value: unknown) => { if (typeof value === 'string') notes.push(value); }] },
      'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
      'react-native': { Pressable: 'Pressable', Text: 'Text', SafeAreaView: 'SafeAreaView', ScrollView: 'ScrollView',
        StatusBar: 'StatusBar', TextInput: 'TextInput' },
      'expo-secure-store': {}, 'expo-keep-awake': { useKeepAwake: () => {} },
      '@byokit/cloud': { boat: () => ({}), machine: () => computer, sshResolve: () => async (url: string) => url },
      '@byokit/pair': { secureDeviceStore: () => ({}) },
      '@byokit/accounts': { ResponseError: Error, ClaudePlanExpiredError: Error },
      './cloud-m6.ts': { cloudRecipe },
    };
    const module = { exports: {} as Record<string, unknown> };
    const output = transformSync(readFileSync(new URL('./CloudM6Demo.tsx', import.meta.url), 'utf8'), {
      loader: 'tsx', format: 'cjs', jsx: 'automatic', target: 'es2022', logLevel: 'silent',
    }).code;
    runInNewContext(output, { module, exports: module.exports, process: { env: {} }, crypto, require: (name: string) => {
      assert.ok(name in modules, `unexpected native import ${name}`); return modules[name];
    } });
    const find = (node: any, id: string): any => {
      if (node?.props?.testID === id) return node;
      for (const child of [node?.props?.children].flat()) {
        const found = child && find(child, id); if (found) return found;
      }
    };
    const demo = module.exports.CloudM6Demo as (props: { accounts: object; ssh?: object }) => any;
    const screen = demo({ accounts: {}, ssh });
    assert.equal(find(screen, 'm6-pair').props.disabled, ssh === undefined, 'Pair needs the app SSH module');
    const button = find(screen, 'm6-install');
    assert.equal(button.props.disabled, false);
    button.props.onPress();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(notes, ['Installing the cloud host…', 'Host installed and running. Ready to pair.']);
    assert.deepEqual(installed, [cloudRecipe('fixture')]);
    assert.doesNotMatch(JSON.stringify(installed), /tailscale|ts\.net|0\.0\.0\.0/, 'no network join and no public bind');
    assert.match(JSON.stringify(installed), /host: '127\.0\.0\.1', port: 7300/);
  }
});
