// Consumer journeys for the published @byokit/share surface, driven the way an app uses it. Every import is a
// published entry — `@byokit/share` (the portable default), the `react-native` condition of the same specifier, and
// `@byokit/share/app.plugin.js` — with no `src` or internals. The security and correctness contracts the old
// unit/mock-heavy/snapshot/internal suites held survive as assertions inside a journey: share-link validation
// (unsafe, malformed, forged, foreign or scheme-less input refused; scheme metacharacters literal), the plain
// user-facing words for every error code, the Android hook (subscribe before the first read, a newer share wins,
// reset/background/disabled/unmount ordering, upstream's parser shapes and counts), the iOS guard (only the
// extension's own link reaches native; a forged link is refused with plain words), the config-plugin contract
// (singleTask, no duplicate plugins, foreign extensions hidden then restored, the two Gradle inserts) and the
// packaging contract (the default entry bundles native-free with no Node code; the RN entry reports support only
// with a linked native module and maps its reads to upstream's events).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import plain from '../../../fixtures/conformance/plain-words.json' with { type: 'json' };
import {
  ShareError, WORDS, words, errorWords, isValidShareUrl, createUseShareIntent, shareSupported,
  type NativeShare, type NativeShareRead, type ShareIntentModuleLike, type ShareIntentOptions, type ShareIntentState,
} from '@byokit/share';
// @ts-expect-error Plain ESM config plugin has no emitted declaration.
import withShare, { sanitize, ownedTargetNames, hideForeignExtensions, assertNoOrphanSibling, restoreHidden, insertShareExclude, insertDesklinkGradle } from '@byokit/share/app.plugin.js';
import { parseShareIntent } from './fixtures/esi-utils.js';

type Deps = Parameters<typeof createUseShareIntent>[0];

// A synchronous React stand-in: effects run right after render, setState re-renders at once, and StrictMode replays
// its mount, cleanup, mount.
type Effect = { fn: () => void | (() => void); deps: unknown[] | undefined; prev: unknown[] | undefined; cleanup: unknown };
function stubReact(strict = false) {
  type Ctx = { fn: () => unknown; result: unknown; states: unknown[]; refs: { current: unknown }[]; effects: Effect[]; si: number; ri: number; ei: number; live: boolean };
  let ctx: Ctx | undefined;
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const flush = (c: Ctx) => { for (const e of c.effects) {
    if (e.prev !== undefined && same(e.prev, e.deps)) continue;
    const first = e.prev === undefined; e.prev = e.deps;
    if (typeof e.cleanup === 'function') e.cleanup();
    e.cleanup = e.fn();
    if (strict && first) { if (typeof e.cleanup === 'function') e.cleanup(); e.cleanup = e.fn(); }
  } };
  const render = (c: Ctx) => { if (!c.live) return; const outer = ctx; ctx = c; c.si = c.ri = c.ei = 0; c.result = c.fn(); ctx = outer; flush(c); };
  const react = {
    useState<S>(init: S): [S, (v: S | ((p: S) => S)) => void] { const c = ctx!, i = c.si++; if (i >= c.states.length) c.states.push(init);
      return [c.states[i] as S, (v) => { c.states[i] = typeof v === 'function' ? (v as (p: S) => S)(c.states[i] as S) : v; render(c); }]; },
    useRef<T>(init: T): { current: T } { const c = ctx!, i = c.ri++; if (i >= c.refs.length) c.refs.push({ current: init }); return c.refs[i] as { current: T }; },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) { const c = ctx!, i = c.ei++; if (i >= c.effects.length) c.effects.push({ fn, deps, prev: undefined, cleanup: undefined }); else Object.assign(c.effects[i], { fn, deps }); },
  };
  const mount = <T>(fn: () => T) => { const c: Ctx = { fn, result: undefined, states: [], refs: [], effects: [], si: 0, ri: 0, ei: 0, live: true }; render(c);
    return { result: () => c.result as T, unmount: () => { c.live = false; for (const e of c.effects) if (typeof e.cleanup === 'function') e.cleanup(); } }; };
  return { react: react as unknown as Deps['react'], mount };
}

type Deferred = { resolve(r: NativeShareRead): void; reject(e: unknown): void };
function fakeNative() {
  const log: string[] = []; const reads: Deferred[] = []; let onShare: (() => void) | null = null;
  const native: NativeShare = {
    read: () => { log.push('read'); return new Promise((res, rej) => reads.push({ resolve: res, reject: rej })); },
    clear: (seq) => { log.push(`clear(${seq})`); }, hasPending: () => false,
    addListener: (_e, f) => { log.push('addListener(onShare)'); onShare = f; return { remove: () => { onShare = null; } }; },
  };
  return { native, log, reads, emitShare: () => onShare?.() };
}
function fakeAppState() {
  const subs = new Set<(s: string) => void>();
  return { currentState: 'active',
    addEventListener: (_e: 'change', f: (s: string) => void) => { subs.add(f); return { remove: () => { subs.delete(f); } }; },
    emit: (s: string) => { for (const f of [...subs]) f(s); } };
}
const tick = () => new Promise((r) => setImmediate(r));
const text = (seq: number, t: string): NativeShareRead => ({ kind: 'shared', seq, text: t, title: null, files: [], skipReasons: [] });
const NONE: NativeShareRead = { kind: 'none', seq: 0 };

function android(options?: ShareIntentOptions, strict = false) {
  const n = fakeNative(), app = fakeAppState(), r = stubReact(strict); const parsed: ShareIntentOptions[] = [];
  const use = createUseShareIntent({ module: null, native: n.native, parse: (v, o) => { parsed.push(o); return parseShareIntent(v, o); },
    getScheme: () => 'app', getShareExtensionKey: () => 'appShareKey', react: r.react, appState: app, os: 'android' });
  return { ...n, app, parsed, mount: () => r.mount(() => use(options)), h: r.mount(() => use(options)) };
}
function iosHook(url: string | null, options?: ShareIntentOptions) {
  const calls: string[] = [], clears: string[] = [], r = stubReact(), app = fakeAppState(), link = { url };
  const module = { getShareIntent: async (u: string) => { calls.push(u); }, clearShareIntent: async (k: string) => { clears.push(k); }, addListener: () => ({ remove() {} }) } as unknown as ShareIntentModuleLike;
  const use = createUseShareIntent({ module, useLinkingURL: () => link.url, parse: parseShareIntent, getScheme: () => 'myapp', getShareExtensionKey: () => 'myappShareKey', react: r.react, appState: app, os: 'ios' });
  return { calls, clears, app, link, h: r.mount(() => use(options)) };
}
const shown = (s: ShareIntentState) => s.shareIntent.text;

test('an app validates the share-extension link and shows only plain words', () => {
  assert.equal(shareSupported, false);
  for (const kind of ['media', 'text', 'weburl', 'file']) for (const q of ['', '?v=1'])
    assert.equal(isValidShareUrl(`demo://dataUrl=demoShareKey${q}#${kind}`, 'demo'), true);
  for (const url of ['demo://dataUrl=demoShareKey', 'demo://dataUrl=demoShareKey#unknown', 'demo://dataUrl=foreign#text',
    'other://dataUrl=demoShareKey#text', 'demo://dataUrl=demoShareKey#text\n', 'demo://dataUrl=demoShareKey?x=#text#file'])
    assert.equal(isValidShareUrl(url, 'demo'), false, url);
  assert.equal(isValidShareUrl('demo://dataUrl=demoShareKey#text', null), false);
  assert.equal(isValidShareUrl('a.b+://dataUrl=a.b+ShareKey#text', 'a.b+'), true);   // metacharacters are literal
  assert.equal(isValidShareUrl('axb://dataUrl=axbShareKey#text', 'a.b'), false);
  const pattern = new RegExp(plain.pattern, 'i');
  for (const sentence of Object.values(WORDS)) assert.doesNotMatch(sentence, pattern);
  for (const [code, key] of [['unreadable', 'share.unreadable'], ['partial', 'share.partial'], ['failed', 'share.failed'], ['invalid_share_url', 'share.invalid_link']] as const) {
    const error = new ShareError(code, 'developer detail', { cause: new Error('original'), detail: { stage: 'read' } });
    assert.equal(errorWords(error), words(key));
    assert.equal(error.message, 'developer detail');
    assert.deepEqual(error.detail, { stage: 'read' });
    assert.ok(error.cause instanceof Error);
  }
});

test('a host on Android receives one share, ignores older reads, and resets or keeps it as configured', async () => {
  const t = android();
  assert.deepEqual(t.log.slice(0, 2), ['addListener(onShare)', 'read']);   // subscribe before the first read
  assert.equal(t.h.result().isReady, true);
  // A newer share that resolves first is never replaced by an older read, and the share applies exactly once.
  t.app.emit('active'); t.emitShare();
  t.reads[1].resolve(NONE); t.reads[2].resolve(text(2, 'hello B')); t.reads[0].resolve(text(1, 'hello A')); await tick();
  assert.equal(shown(t.h.result()), 'hello B');
  assert.equal(t.parsed.length, 1);
  // A background reset clears the applied sequence only, and a new share still lands.
  t.app.emit('background');
  t.emitShare(); t.reads[3].resolve(text(3, 'hello C')); await tick();
  assert.deepEqual(t.log.filter((l) => l.startsWith('clear')), ['clear(2)']);
  assert.equal(shown(t.h.result()), 'hello C');
  // A reset beats a stale read of the same sequence; a newer read across the reset is still delivered.
  const u = android(); u.reads[0].resolve(text(1, 'hello A')); await tick();
  u.emitShare(); u.h.result().resetShareIntent(); u.reads[1].resolve(text(1, 'hello A')); await tick();
  assert.equal(u.h.result().hasShareIntent, false); assert.ok(u.log.includes('clear(1)'));
  const v = android(); v.reads[0].resolve(text(1, 'hello A')); await tick();
  v.emitShare(); v.h.result().resetShareIntent(); v.reads[1].resolve(text(2, 'hello B')); await tick();
  assert.equal(shown(v.h.result()), 'hello B');
  // A `none` read never clears what is shown; a stale rejection never hides a newer share.
  const w = android(); w.reads[0].resolve(text(1, 'hello A')); await tick();
  w.app.emit('active'); w.reads[1].resolve(NONE); await tick();
  assert.equal(shown(w.h.result()), 'hello A');
  // Nothing applies after unmount; a remount reads the share again.
  const x = android(); x.h.unmount(); x.reads[0].resolve(text(1, 'hello A')); await tick();
  assert.equal(x.parsed.length, 0);
  const xr = x.mount(); x.reads[1].resolve(text(1, 'hello A')); await tick();
  assert.equal(shown(xr.result()), 'hello A');
  // Disabled: no read, no subscription, reset does nothing.
  let resets = 0; const d = android({ disabled: true, onResetShareIntent: () => { resets++; } });
  d.h.result().resetShareIntent();
  assert.deepEqual(d.log, []); assert.equal(resets, 0); assert.equal(d.h.result().isReady, false);
  // resetOnBackground: false keeps the share; onResetShareIntent fires once when a value is reset.
  let kept = 0; const k = android({ resetOnBackground: false, onResetShareIntent: () => { kept++; } });
  k.reads[0].resolve(text(1, 'hello A')); await tick(); k.app.emit('background');
  assert.ok(!k.log.some((l) => l.startsWith('clear'))); assert.equal(shown(k.h.result()), 'hello A');
  k.h.result().resetShareIntent(); k.h.result().resetShareIntent();
  assert.equal(kept, 1);
  // Upstream's parser shapes and counts: unreadable, partial files and a text URL map to the kit's words and counts.
  const bad = android(); bad.reads[0].resolve({ kind: 'unreadable', seq: 1, skipReasons: ['unreadable', 'own_provider'] }); await tick();
  assert.deepEqual([bad.h.result().errorCode, bad.h.result().error, bad.h.result().skipped], ['unreadable', WORDS['share.unreadable'], 2]);
  const img = (n: string) => ({ contentUri: `content://p/${n}`, filePath: `/cache/byokit-share/1/${n}`, fileName: n, mimeType: 'image/png', fileSize: '10', width: 2, height: 3, duration: null });
  const p = android(); p.reads[0].resolve({ kind: 'shared', seq: 1, text: null, title: null, files: [img('a.png')], skipReasons: ['too_large'] }); await tick();
  assert.deepEqual([p.h.result().errorCode, p.h.result().error, p.h.result().skipped, p.h.result().shareIntent.type], ['partial', null, 1, 'media']);
  assert.equal(p.h.result().shareIntent.files?.[0].path, 'file:///cache/byokit-share/1/a.png');
  const web = android(); web.reads[0].resolve(text(1, 'see https://example.com/x')); await tick();
  assert.equal(web.h.result().shareIntent.type, 'weburl'); assert.equal(web.h.result().shareIntent.webUrl, 'https://example.com/x');
  assert.ok(web.parsed.every((o) => o.debug === false), 'parse always gets merged options');
});

test('on iOS only the extension link reaches native, and a forged link is refused in plain words', () => {
  for (const url of ['myapp://dataUrl=myappShareKey#text', 'myapp://dataUrl=myappShareKey?nonce=1#media']) {
    const t = iosHook(url);
    assert.deepEqual(t.calls, [url]); assert.equal(t.h.result().errorCode, null);
  }
  for (const url of ['myapp://dataUrl=x', 'myapp://dataUrl=myappShareKey', 'myapp://dataUrl=otherShareKey#text']) {
    const t = iosHook(url);
    assert.deepEqual(t.calls, [], url);
    assert.equal(t.h.result().errorCode, 'invalid_share_url', url);
    assert.equal(t.h.result().error, WORDS['share.invalid_link']);
  }
  const foreign = iosHook('https://example.com/a');
  assert.deepEqual(foreign.calls, []); assert.equal(foreign.h.result().errorCode, null);
  // Background resets through the module; active re-reads the current link (a repeat share).
  const t = iosHook(null); t.link.url = 'myapp://dataUrl=myappShareKey#text';
  t.app.emit('background');
  assert.deepEqual(t.clears, ['myappShareKey']);
  assert.deepEqual(t.calls, [t.link.url]);
  t.app.emit('active');
  assert.deepEqual(t.calls, [t.link.url, t.link.url]);
});

test("the kit's config plugin refuses a takeover or duplicate and inserts its Gradle exactly once", () => {
  assert.deepEqual(withShare({}), {});
  for (const mode of ['singleTop', 'standard', 'singleInstance', 'singleInstancePerTask'])
    assert.throws(() => withShare({}, { shareIntent: { androidMainActivityAttributes: { 'android:launchMode': mode } } }), /singleTask/);
  assert.throws(() => withShare({}, { other: true }), /unknown option/);
  assert.throws(() => withShare({}, { desklink: 'true' }), /boolean/);
  for (const entry of ['expo-share-intent', ['@bacons/apple-targets', {}]])
    assert.throws(() => withShare({ plugins: [entry] }), /duplicate plugin/);
  const section = { a: { name: 'actions', productName: '"actions"', productType: '"com.apple.product-type.app-extension"' }, b: { name: 'foreign', productName: '"foreign"', productType: '"com.apple.product-type.app-extension"' } };
  assert.deepEqual(hideForeignExtensions(section, new Set(['actions'])), ['foreign']);
  assert.equal(restoreHidden(`productType = "com.apple.product-type.app-extension.byokit-hidden";`), 'productType = "com.apple.product-type.app-extension";');
  const owned = new Set(['actions', 'foo']);
  assert.throws(() => assertNoOrphanSibling({ a: { productName: '"actions"', productType: '"com.apple.product-type.app-extension"' } }, owned), /prebuild --clean/);
  assert.doesNotThrow(() => assertNoOrphanSibling({}, owned));
  assert.equal(sanitize('Crème'), 'Crme'); assert.equal(sanitize('Cre\u0301me'), 'Creme');
  const patterns: string[] = [];
  const names = ownedTargetNames({ _internal: { projectRoot: '/fixture' } }, { match: '{a,b}' }, {
    globSync(pattern: string, options: object) { patterns.push(pattern); assert.deepEqual(options, { cwd: '/fixture', absolute: true }); return ['/fixture/targets/actions/expo-target.config.js', '/fixture/targets/ignored/expo-target.config.js']; },
    load(path: string) { return path.includes('ignored') ? {} : { type: 'widget', name: 'actions' }; },
  });
  assert.deepEqual(patterns, ['./targets/{a,b}/expo-target.config.@(json|js)']); assert.deepEqual([...names], ['actions']);
  const gradle = readFileSync(new URL('./fixtures/root.build.gradle', import.meta.url), 'utf8');
  const built = insertDesklinkGradle(gradle);
  assert.ok(built.indexOf('expo-root-project') < built.indexOf('// @byokit/share desklink'));
  assert.ok(built.indexOf('// @byokit/share desklink') < built.indexOf('com.facebook.react.rootproject'));
  assert.equal(insertDesklinkGradle(built), built);
  assert.throws(() => insertDesklinkGradle('apply plugin: "com.facebook.react.rootproject"'), /expo-root-project/);
  const settings = readFileSync(new URL('./fixtures/settings.gradle', import.meta.url), 'utf8');
  const excluded = insertShareExclude(settings);
  assert.ok(excluded.indexOf('// @byokit/share exclude') < excluded.indexOf('expoAutolinking.useExpoModules()'));
  assert.match(excluded, /exclude = .*\['expo-share-intent'\]/);
  assert.equal(insertShareExclude(excluded), excluded);
  assert.throws(() => insertShareExclude(''), /useExpoModules/);
});

test('a prebuild through the real Expo mod chain hides foreign extensions and asserts singleTask', async () => {
  const require = createRequire(import.meta.url);
  const extension = 'com.apple.product-type.app-extension';
  const target = (name: string) => ({ name, productName: `"${name}"`, productType: `"${extension}"` });
  const root = mkdtempSync(join(tmpdir(), 'share-journey-'));
  const pkg = (name: string, contents: string) => { const path = join(root, 'node_modules', name); mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'package.json'), JSON.stringify({ name, main: 'app.plugin.js' })); writeFileSync(join(path, 'app.plugin.js'), contents); };
  try {
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(require.resolve('expo/package.json'), '..'), join(root, 'node_modules/expo'), 'dir');
    pkg('expo-share-intent', 'module.exports = (c,o) => { c.passed=o; return c; };');
    pkg('@bacons/apple-targets', 'module.exports = c => c;');
    const glob = join(root, 'node_modules/@bacons/apple-targets/node_modules/glob');
    mkdirSync(glob, { recursive: true }); writeFileSync(join(glob, 'index.js'), 'exports.globSync = () => [];');
    const { withXcodeProject, withAndroidManifest } = require('expo/config-plugins');
    let config: any = { name: 'fixture', slug: 'fixture', _internal: { projectRoot: root } };
    config = withXcodeProject(config, (c: any) => { c.modResults.hash.project.objects.PBXNativeTarget.a = target('before'); return c; });
    const shareIntent = { disableIOS: true, futureKey: { exact: true } };
    config = withShare(config, { shareIntent, appleTargets: {} });
    assert.equal(config.passed, shareIntent);   // nested options pass through verbatim
    config = withXcodeProject(config, (c: any) => { c.modResults.hash.project.objects.PBXNativeTarget.b = target('after'); return c; });
    const project = { hash: { project: { objects: { PBXNativeTarget: {} } } } };
    const request = { projectRoot: root, platformProjectRoot: join(root, 'ios'), platform: 'ios', modName: 'xcodeproj' };
    const out = await config.mods.ios.xcodeproj({ ...config, modResults: project, modRequest: request });
    for (const t of Object.values(out.modResults.hash.project.objects.PBXNativeTarget) as any[]) assert.match(t.productType, /byokit-hidden/);
    const manifest = JSON.parse(readFileSync(new URL('./fixtures/manifest.json', import.meta.url), 'utf8'));
    const android = { projectRoot: root, platformProjectRoot: join(root, 'android'), platform: 'android', modName: 'manifest' };
    await config.mods.android.manifest({ ...config, modResults: manifest, modRequest: android });
    config = withAndroidManifest(config, (c: any) => { c.modResults.manifest.application[0].activity[0].$['android:launchMode'] = 'singleTop'; return c; });
    await assert.rejects(config.mods.android.manifest({ ...config, modResults: manifest, modRequest: android }), /singleTask/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the kit bundles for browsers and React Native, and reports support only with a linked native module', async () => {
  const shareDir = resolve('packages/share');
  const bundle = (conditions: string[], withNative: boolean) => {
    const lookups: string[] = []; (globalThis as any).__byokit = { lookups, native: withNative ? nativeFor() : null };
    return build({ stdin: { contents: "export * from '@byokit/share';", resolveDir: shareDir, loader: 'js' },
      bundle: true, write: false, metafile: true, platform: 'browser', format: 'esm', logLevel: 'silent', conditions,
      plugins: [{ name: 'native-stubs', setup(b) {
        b.onResolve({ filter: /^(react|react-native|expo-modules-core|expo-linking|expo-share-intent)$/ }, (a) => ({ path: a.path, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, ({ path }) => ({ contents: ({
          react: `export const useState=()=>{},useEffect=()=>{},useRef=()=>{},useContext=()=>{},createContext=()=>({Consumer:()=>{},Provider:()=>{}}); export function createElement(){};`,
          'react-native': `export const Platform={OS:'android'},AppState={currentState:'active',addEventListener(){return {remove(){}}}};`,
          'expo-modules-core': `export function requireOptionalNativeModule(n){globalThis.__byokit.lookups.push(n);return globalThis.__byokit.native;}`,
          'expo-linking': `export const useLinkingURL=()=>null;`,
          'expo-share-intent': `export const ShareIntentModule=null,getScheme=()=>null,getShareExtensionKey=()=>'',parseShareIntent=()=>({});`,
        } as Record<string, string>)[path], loader: 'js' }));
      } }] });
  };
  const portable = await bundle([], false);
  assert.equal(Object.keys(portable.metafile!.inputs).some((p) => p.startsWith('node:') || /(^|\/)(react|react-native|expo-[^/]+)\//.test(p)), false, 'the default entry bundles no Node or native runtime');
  const portableMod = await importBundle(portable);
  assert.deepEqual((globalThis as any).__byokit.lookups, [], 'the default entry loads no native module');
  assert.equal(portableMod.shareSupported, false);
  assert.deepEqual(Object.keys(portableMod).sort(), ['ShareError', 'WORDS', 'createUseShareIntent', 'errorWords', 'isValidShareUrl', 'shareSupported', 'words'].sort());
  const rn = await bundle(['react-native'], true);
  assert.equal(Object.keys(rn.metafile!.inputs).some((p) => p.startsWith('node:')), false, 'the RN entry bundles no Node code');
  const rnMod = await importBundle(rn);
  assert.deepEqual((globalThis as any).__byokit.lookups, ['ByokitShare'], 'the RN entry reads the kit’s own Android module');
  assert.equal(rnMod.shareSupported, true);
  assert.deepEqual(Object.keys(rnMod).filter((k: string) => !(k in portableMod)).sort(),
    ['useShareIntent', 'ShareIntentProvider', 'useShareIntentContext', 'ShareIntentContextConsumer', 'ShareIntentModule', 'getScheme', 'getShareExtensionKey', 'parseShareIntent'].sort());
  const seen: string[] = [];
  rnMod.ShareIntentModule.addListener('onStateChange', (e: { value: string }) => seen.push(`state:${e.value}`));
  rnMod.ShareIntentModule.addListener('onChange', (e: { value: { type: string; text: string } }) => seen.push(`change:${e.value.type}:${e.value.text}`));
  const got = rnMod.ShareIntentModule.getShareIntent('');
  (globalThis as any).__reads[0].resolve({ kind: 'shared', seq: 1, text: 'hi', title: null, files: [], skipReasons: [] });
  await got;
  assert.deepEqual(seen, ['state:pending', 'change:text:hi']);
});

function nativeFor() {
  const reads: { resolve: (r: NativeShareRead) => void }[] = []; (globalThis as any).__reads = reads;
  return { read: () => new Promise<NativeShareRead>((res) => reads.push({ resolve: res })), clear: () => {}, hasPending: () => false, addListener: () => ({ remove() {} }) };
}
async function importBundle(result: Awaited<ReturnType<typeof build>>) {
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles![0].contents).toString('base64')}`) as Promise<Record<string, any>>;
}
