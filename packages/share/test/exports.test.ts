import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as portable from '../src/index.ts';

test('portable and RN exported names are frozen; Android never looks up upstream native code', async () => {
  assert.deepEqual(Object.keys(portable).sort(), ['ShareError', 'WORDS', 'createUseShareIntent', 'errorWords', 'isValidShareUrl', 'shareSupported', 'words'].sort());
  const lookups: string[] = [];
  (globalThis as any).__shareLookups = lookups;
  try {
    const result = await build({ entryPoints: [new URL('../src/rn.ts', import.meta.url).pathname], bundle: true, write: false,
      platform: 'browser', format: 'esm', logLevel: 'silent', plugins: [{ name: 'native-stubs', setup(b) {
        b.onResolve({ filter: /^(react|react-native|expo-modules-core|expo-linking|expo-share-intent)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: ({
          react: `export const useState=()=>{},useEffect=()=>{},useRef=()=>{},useContext=()=>{},createContext=()=>({Consumer:()=>{},Provider:()=>{}}); export function createElement(){};`,
          'react-native': `export const Platform={OS:'android'},AppState={currentState:'active',addEventListener(){return {remove(){}}}};`,
          'expo-modules-core': `export function requireOptionalNativeModule(n){globalThis.__shareLookups.push(n);return null;}`,
          'expo-linking': `export const useLinkingURL=()=>null;`,
          'expo-share-intent': `export const ShareIntentModule=null,getScheme=()=>null,getShareExtensionKey=()=>'',parseShareIntent=()=>({});`,
        } as Record<string, string>)[path], loader: 'js' }));
      } }] });
    const mod = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString('base64')}`);
    assert.deepEqual(lookups, ['ByokitShare']); assert.equal(mod.shareSupported, false);
    assert.deepEqual(Object.keys(mod).filter((key) => !(key in portable)).sort(),
      ['useShareIntent', 'ShareIntentProvider', 'useShareIntentContext', 'ShareIntentContextConsumer', 'ShareIntentModule', 'getScheme', 'getShareExtensionKey', 'parseShareIntent'].sort());
    assert.equal(mod.ShareIntentModule, null);
  } finally { delete (globalThis as any).__shareLookups; }
});
