import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { words, type TailnetStep } from '@byokit/cloud';

// Execute the actual demo export with inert native views/hooks and a fake machine.
// This checks callback/display behavior, not a painted or physical-phone journey.
test('M6 install shows the keyed approval message once, with or without an earlier sign-in link', async () => {
  for (const steps of [
    [{ step: 'open-page', url: 'https://login.tailscale.com/a/fixture' }, { step: 'approve', name: 'fixture' }],
    [{ step: 'approve', name: 'fixture' }],
  ] satisfies TailnetStep[][]) {
    const notes: string[] = [], links: string[] = [];
    const computer = {
      ref: { name: 'fixture' }, state: async () => 'on',
      joinTailnet: async (_o: unknown, onStep: (s: TailnetStep) => void) => {
        assert.equal(notes.at(-1), words('tailnet.joining'), 'joining is displayed before the join starts');
        steps.forEach(onStep); return { name: 'fixture.tail.ts.net' };
      }, install: async () => {}, host: async () => 'running',
    };
    let state = 0;
    const jsx = (type: unknown, props: any) => ({ type, props });
    const modules: Record<string, unknown> = {
      react: { useEffect: () => {}, useRef: (current: unknown) => ({ current }),
        useState: (initial: unknown) => [++state === 2 ? 'fixture' : state === 3 ? true : initial,
          (value: unknown) => { if (typeof value === 'string') notes.push(value); }] },
      'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'Fragment' },
      'react-native': { Pressable: 'Pressable', Text: 'Text', SafeAreaView: 'SafeAreaView', ScrollView: 'ScrollView',
        StatusBar: 'StatusBar', TextInput: 'TextInput', Linking: { openURL: async (url: string) => { links.push(url); } } },
      'expo-secure-store': {}, 'expo-keep-awake': { useKeepAwake: () => {} },
      '@byokit/cloud': { boat: () => ({}), machine: () => computer, words },
      '@byokit/pair': { secureDeviceStore: () => ({}) },
      '@byokit/accounts': { ResponseError: Error, ClaudePlanExpiredError: Error },
      './cloud-m6.ts': { cloudRecipe: () => ({}) },
    };
    const exports: any = {};
    const output = ts.transpileModule(readFileSync(new URL('./CloudM6Demo.tsx', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    runInNewContext(output, { exports, process: { env: {} }, require: (name: string) => {
      assert.ok(name in modules, `unexpected native import ${name}`); return modules[name];
    } });
    const findInstall = (node: any): any => {
      if (node?.props?.testID === 'm6-install') return node;
      for (const child of [node?.props?.children].flat()) {
        const found = child && findInstall(child); if (found) return found;
      }
    };
    const button = findInstall(exports.CloudM6Demo({ accounts: {} }));
    assert.equal(button.props.disabled, false);
    button.props.onPress();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(notes, ['Installing the cloud host…', words('tailnet.joining'), words('tailnet.approvalNeeded'), 'Host installed and running. Ready to pair.']);
    assert.deepEqual(links, steps.flatMap(s => s.step === 'open-page' ? [s.url] : []));
  }
});
