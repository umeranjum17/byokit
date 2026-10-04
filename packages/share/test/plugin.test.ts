import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
// @ts-expect-error Plain ESM config plugin has no emitted declaration.
import withShare, { sanitize, ownedTargetNames, hideForeignExtensions, assertNoOrphanSibling, restoreHidden, insertShareExclude, insertDesklinkGradle } from '../app.plugin.js';

const require = createRequire(import.meta.url);
const extension = 'com.apple.product-type.app-extension';
const target = (name: string, type = extension) => ({ name, productName: `"${name}"`, productType: `"${type}"` });
test('hide only foreign app extensions; restore quoted/unquoted markers idempotently', () => {
  const section = { a: target('actions'), b: target('foreign'), c: target('watch', 'com.apple.product-type.application.watchapp2'), a_comment: 'actions' };
  assert.deepEqual(hideForeignExtensions(section, new Set(['actions'])), ['foreign']);
  assert.equal(section.a.productType, `"${extension}"`);
  assert.equal(section.c.productType, '"com.apple.product-type.application.watchapp2"');
  const text = `productType = "${extension}.byokit-hidden";\nproductType = ${extension}.byokit-hidden;`;
  const restored = restoreHidden(text);
  assert.equal(restored.includes('byokit-hidden'), false);
  assert.equal(restoreHidden(restored), restored);
});
test('adding an owned sibling requires clean prebuild, not target takeover', () => {
  const owned = new Set(['actions', 'foo']);
  assert.throws(() => assertNoOrphanSibling({ a: target('actions') }, owned), /prebuild --clean/);
  assert.doesNotThrow(() => assertNoOrphanSibling({}, owned));
  assert.doesNotThrow(() => assertNoOrphanSibling({ a: target('actions'), b: target('foo') }, owned));
});
test('generated Gradle inserts are ordered, idempotent and fail on template drift', () => {
  const root = readFileSync(new URL('./fixtures/root.build.gradle', import.meta.url), 'utf8');
  const result = insertDesklinkGradle(root);
  assert.ok(result.indexOf('expo-root-project') < result.indexOf('// @byokit/share desklink'));
  assert.ok(result.indexOf('// @byokit/share desklink') < result.indexOf('com.facebook.react.rootproject'));
  assert.match(result, /enableCompileTimeOptimization = true/);
  assert.equal(insertDesklinkGradle(result), result);
  assert.throws(() => insertDesklinkGradle('apply plugin: "com.facebook.react.rootproject"'), /expo-root-project/);
  assert.throws(() => insertDesklinkGradle(''), /expo-root-project/);
  const settings = readFileSync(new URL('./fixtures/settings.gradle', import.meta.url), 'utf8');
  const excluded = insertShareExclude(settings);
  assert.ok(excluded.indexOf('// @byokit/share exclude') < excluded.indexOf('expoAutolinking.useExpoModules()'));
  assert.match(excluded, /exclude = .*\['expo-share-intent'\]/);
  assert.equal(insertShareExclude(excluded), excluded);
  assert.throws(() => insertShareExclude(''), /useExpoModules/);
});
test('discovery uses upstream glob patterns and exact sanitization order', () => {
  const config = { _internal: { projectRoot: '/fixture' } };
  for (const match of ['*', 'w*', '{a,b}']) {
    const patterns: string[] = [];
    const names = ownedTargetNames(config, { match }, {
      globSync(pattern: string, options: object) {
        patterns.push(pattern); assert.deepEqual(options, { cwd: '/fixture', absolute: true });
        return ['/fixture/targets/actions/expo-target.config.js', '/fixture/targets/my_widget/expo-target.config.json', '/fixture/targets/ignored/expo-target.config.js'];
      },
      load(path: string) {
        if (path.includes('ignored')) return {};
        if (path.includes('actions')) return (c: unknown) => { assert.equal(c, config); return { type: 'widget', name: 'actions' }; };
        return { type: 'widget' };
      },
    });
    assert.deepEqual(patterns, [`./targets/${match}/expo-target.config.@(json|js)`]);
    assert.deepEqual([...names], ['actions', 'mywidget']);
  }
  assert.equal(sanitize('Crème'), 'Crme'); assert.equal(sanitize('Cre\u0301me'), 'Creme');
  assert.deepEqual([...ownedTargetNames(config, {}, { globSync: () => [], load: () => null })], []);
});
test('option validation requires singleTask, known top-level keys and no duplicate plugins', () => {
  for (const mode of ['singleTop', 'standard', 'singleInstance', 'singleInstancePerTask']) {
    assert.throws(() => withShare({}, { shareIntent: { androidMainActivityAttributes: { 'android:launchMode': mode } } }), /singleTask/);
  }
  assert.throws(() => withShare({}, { other: true }), /unknown option/);
  assert.throws(() => withShare({}, { desklink: 'true' }), /boolean/);
  for (const entry of ['expo-share-intent', ['@bacons/apple-targets', {}]]) {
    assert.throws(() => withShare({ plugins: [entry] }), /duplicate plugin/);
  }
  assert.deepEqual(withShare({}), {});
});

test('real Expo mod chain hides before/after extensions, validates final launch mode and passes nested options through', async () => {
  const root = mkdtempSync(join(tmpdir(), 'share-plugin-test-'));
  const pkg = (name: string, contents: string) => {
    const path = join(root, 'node_modules', name); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, main: 'app.plugin.js' }));
    writeFileSync(join(path, 'app.plugin.js'), contents);
  };
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
    assert.equal(config.passed, shareIntent);
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
