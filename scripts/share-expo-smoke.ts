// Packed, stock-upstream qualification. Run under the home's heavy lock.
// --android-only / --ios-only select prebuild; --build adds release/JVM/bytecode checks.
// --out <owned scratch> preserves all receipts (including original failures).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync, copyFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const requested = outIndex >= 0 ? resolve(args[outIndex + 1]!) : mkdtempSync(join(tmpdir(), 'bks-'));
mkdirSync(requested, { recursive: true });
// Canonical, so paths Node resolves inside it compare equal (macOS: /tmp is /private/tmp).
const scratch = realpathSync(requested);
const app = join(scratch, 'app');
const home = join(scratch, 'home');
mkdirSync(app, { recursive: true }); mkdirSync(home, { recursive: true });
// The invoked mechanical tool may read host paths, but inherits no credentials/session/keyring.
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home, CI: '1', EXPO_NO_TELEMETRY: '1',
  npm_config_cache: join(scratch, 'npm'), GRADLE_USER_HOME: join(scratch, 'gradle'),
  ANDROID_AVD_HOME: join(scratch, 'avd'), ANDROID_HOME: process.env.ANDROID_HOME,
  ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT, JAVA_HOME: process.env.JAVA_HOME,
};
let command = 0;
function run(bin: string, argv: string[], cwd = app, timeout = 15 * 60_000): string {
  const log = join(scratch, `${String(++command).padStart(2, '0')}-command`);
  writeFileSync(`${log}.json`, JSON.stringify({ bin, argv, cwd, timeout, maxBuffer: 8 * 1024 * 1024 }, null, 2));
  const result = spawnSync(bin, argv, { cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  writeFileSync(`${log}.stdout`, result.stdout ?? ''); writeFileSync(`${log}.stderr`, result.stderr ?? '');
  writeFileSync(`${log}.exit`, JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message }));
  if (result.status !== 0 || result.error) throw new Error(`qualification failed; original receipt ${log}`, { cause: result.error });
  return result.stdout;
}
const pins: Record<string, string> = {
  expo: '57.0.25', 'react-native': '0.86.3', react: '19.2.3',
  'expo-share-intent': '8.0.1', '@bacons/apple-targets': '5.0.0',
  'expo-widgets': '57.0.22', '@desklink/react-native': '0.3.0', 'react-native-webrtc': '124.0.8',
  'expo-linking': '57.0.11', 'expo-constants': '57.0.19', 'expo-modules-core': '57.0.19', '@expo/config-plugins': '57.0.9',
};
const stock = ['expo-share-intent', '@bacons/apple-targets', '@desklink/react-native', 'expo-modules-core', 'expo-widgets'];
const receipts: { name: string; directory: string; files: string[]; integrity: string }[] = [];
function checkStock() {
  for (const { name, directory, files } of receipts) for (const file of files) {
    assert.deepEqual(readFileSync(join(app, 'node_modules', name, file)), readFileSync(join(directory, 'package', file)), `${name}/${file} changed`);
  }
}
function gradle(argv: string[]) { return run('./gradlew', [...argv, '--no-daemon', '-PreactNativeArchitectures=x86_64'], join(app, 'android'), 25 * 60_000); }
function desklinkBytecode(): string {
  const paths: string[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.startsWith('DesklinkModule') && entry.name.endsWith('.class') && path.includes('kotlin-classes')) paths.push(path);
    }
  }
  walk(join(app, 'node_modules/@desklink/react-native/android/build'));
  assert.ok(paths.length, 'compiled DesklinkModule classes exist');
  return paths.map((path) => run('javap', ['-c', '-p', path])).join('\n');
}
function checkIos(require: NodeRequire) {
  const cp = require('expo/config-plugins');
  const path = cp.IOSConfig.Paths.getPBXProjectPath(app);
  const text = readFileSync(path, 'utf8'); assert.ok(!text.includes('byokit-hidden'));
  const xcode = createRequire(require.resolve('expo/config-plugins'))('xcode');
  const project = xcode.project(path); project.parseSync();
  const objects = project.hash.project.objects;
  const unquote = (x: string) => x?.replace(/^"|"$/g, '');
  const targets = Object.entries(objects.PBXNativeTarget).filter(([key]) => !key.endsWith('_comment')) as [string, any][];
  const expected = ['ExpoWidgetsTarget', 'actions', 'ShareSmokeShareExtension'];
  const ids = expected.map((name) => {
    const matches = targets.filter(([, value]) => unquote(value.name) === name);
    assert.equal(matches.length, 1, name);
    const [id, target] = matches[0]!;
    assert.equal(unquote(target.productName), name);
    assert.equal(unquote(target.productType), 'com.apple.product-type.app-extension');
    for (const item of objects.XCConfigurationList[target.buildConfigurationList].buildConfigurations) {
      const settings = objects.XCBuildConfiguration[item.value].buildSettings;
      if (name === 'ExpoWidgetsTarget') {
        assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), 'io.byokit.sharesmoke.ExpoWidgetsTarget');
        assert.equal(unquote(settings.INFOPLIST_FILE), 'ExpoWidgetsTarget/Info.plist');
      }
      if (name === 'actions') {
        assert.equal(unquote(settings.PRODUCT_BUNDLE_IDENTIFIER), 'io.byokit.sharesmoke.widget');
        assert.equal(unquote(settings.INFOPLIST_FILE), '../targets/actions/Info.plist');
      }
    }
    return id;
  });
  const main = targets.find(([, value]) => unquote(value.productType) === 'com.apple.product-type.application')![1];
  const dependencies = main.dependencies.map((d: any) => objects.PBXTargetDependency[d.value].target);
  for (const id of ids) assert.ok(dependencies.includes(id), `app depends on ${id}`);
  const embeds = main.buildPhases.map((p: any) => objects.PBXCopyFilesBuildPhase[p.value]).filter(Boolean);
  const embedded = embeds.flatMap((p: any) => p.files.map((f: any) => objects.PBXBuildFile[f.value].fileRef));
  for (const id of ids) assert.ok(embedded.includes(objects.PBXNativeTarget[id].productReference), `embedded ${id}`);
  const actionGroups = objects.PBXNativeTarget[ids[1]!].fileSystemSynchronizedGroups;
  assert.ok(actionGroups?.length, 'actions has synchronized sources');
  for (const group of actionGroups) for (const [id, t] of targets) {
    if (id !== ids[1]) assert.ok(!t.fileSystemSynchronizedGroups?.some((g: any) => g.value === group.value), 'actions sources belong only to actions');
  }
  copyFileSync(path, join(scratch, 'withwidgets.pbxproj'));
}

try {
  writeFileSync(join(scratch, 'candidate.json'), JSON.stringify({ sha: run('git', ['rev-parse', 'HEAD'], root), pins }, null, 2));
  const [packed] = Object.values(JSON.parse(run('npm', ['pack', './packages/share', '--pack-destination', scratch, '--json'], root))) as { filename: string; integrity: string }[];
  const tarball = join(scratch, packed.filename);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'byokit-share-qualification', version: '1.0.0', private: true, main: 'index.js', dependencies: pins }, null, 2));
  run('npm', ['install', '--save-exact', '--no-audit', '--no-fund', tarball]);
  const before = readFileSync(join(app, 'package-lock.json'));
  run('npm', ['ci', '--no-audit', '--no-fund']); assert.deepEqual(readFileSync(join(app, 'package-lock.json')), before);
  const require = createRequire(join(app, 'package.json'));
  assert.ok(require.resolve('@byokit/share/app.plugin.js').startsWith(join(app, 'node_modules')));
  const lock = JSON.parse(before.toString()).packages;
  for (const [name, version] of Object.entries(pins)) assert.equal(require(`${name}/package.json`).version, version, name);
  for (const name of stock) {
    const directory = join(scratch, 'stock', name); mkdirSync(directory, { recursive: true });
    const [metadata] = Object.values(JSON.parse(run('npm', ['pack', `${name}@${pins[name]}`, '--json'], directory))) as { filename: string; integrity: string; files: { path: string }[] }[];
    const bytes = readFileSync(join(directory, metadata.filename));
    assert.equal('sha512-' + createHash('sha512').update(bytes).digest('base64'), metadata.integrity);
    assert.equal(lock[`node_modules/${name}`].integrity, metadata.integrity);
    run('tar', ['-xzf', metadata.filename], directory);
    receipts.push({ name, directory, files: metadata.files.map((f: { path: string }) => f.path), integrity: metadata.integrity });
  }
  writeFileSync(join(scratch, 'stock-receipts.json'), JSON.stringify(receipts, null, 2)); checkStock();
  writeFileSync(join(app, 'index.js'), `import React from 'react';
import {Button, Text, View} from 'react-native';
import {registerRootComponent} from 'expo';
import {useShareIntent} from '@byokit/share';
import {desktopAvailable} from '@desklink/react-native/availability';
function App(){const s=useShareIntent(); const f=s.shareIntent.files;
return <View><Text testID="share-state">{JSON.stringify({has:s.hasShareIntent,type:s.shareIntent.type,n:f?.length??0,skipped:s.skipped,skipReasons:s.skipReasons,errorCode:s.errorCode,text:s.shareIntent.text,w:f?.[0]?.width??null,desklink:desktopAvailable})}</Text><Button title="Reset share" onPress={()=>s.resetShareIntent()}/></View>}
registerRootComponent(App);
`);
  mkdirSync(join(app, 'targets/actions'), { recursive: true });
  writeFileSync(join(app, 'targets/actions/expo-target.config.js'), `module.exports={type:'widget',name:'actions',bundleIdentifier:'.widget'};\n`);
  writeFileSync(join(app, 'targets/actions/Widget.swift'), `import SwiftUI\nimport WidgetKit\n// Prebuild fixture only; no iOS runtime claim.\n`);
  writeFileSync(join(app, 'app.json'), JSON.stringify({ expo: {
    name: 'ShareSmoke', slug: 'share-smoke', scheme: 'sharesmoke', android: { package: 'io.byokit.sharesmoke' }, ios: { bundleIdentifier: 'io.byokit.sharesmoke' },
    plugins: ['expo-widgets', ['@byokit/share', { shareIntent: { iosShareExtensionName: 'ShareSmokeShareExtension', androidIntentFilters: ['text/*', 'image/*'], androidMultiIntentFilters: ['image/*'] }, appleTargets: {}, desklink: true }]],
  } }, null, 2));
  const expo = join(app, 'node_modules/.bin/expo');
  if (!args.includes('--ios-only')) {
    run(expo, ['prebuild', '--clean', '--no-install', '-p', 'android']);
    const build = readFileSync(join(app, 'android/build.gradle'), 'utf8');
    assert.equal(build.match(/\/\/ @byokit\/share desklink/g)?.length, 1);
    assert.ok(build.indexOf('expo-root-project') < build.indexOf('// @byokit/share desklink'));
    assert.ok(build.indexOf('// @byokit/share desklink') < build.indexOf('com.facebook.react.rootproject'));
    const settings = readFileSync(join(app, 'android/settings.gradle'), 'utf8');
    assert.equal(settings.match(/\/\/ @byokit\/share exclude/g)?.length, 1);
    assert.ok(settings.indexOf('// @byokit/share exclude') < settings.indexOf('expoAutolinking.useExpoModules()'));
    const manifestApi = require('expo/config-plugins').AndroidConfig.Manifest;
    const manifest = await manifestApi.readAndroidManifestAsync(join(app, 'android/app/src/main/AndroidManifest.xml'));
    const activity = manifestApi.getMainActivityOrThrow(manifest);
    assert.equal(activity.$['android:launchMode'], 'singleTask');
    const actions = activity['intent-filter'].flatMap((f: any) => f.action.map((a: any) => a.$['android:name']));
    assert.ok(actions.includes('android.intent.action.SEND')); assert.ok(actions.includes('android.intent.action.SEND_MULTIPLE'));
    if (args.includes('--build')) {
      gradle(['assembleRelease', ':byokit-share:testDebugUnitTest']);
      const list = readFileSync(join(app, 'node_modules/expo/android/build/generated/expo/src/main/java/expo/modules/ExpoModulesPackageList.kt'), 'utf8');
      assert.match(list, /io\.github\.umeranjum17\.byokit\.share/); assert.doesNotMatch(list, /expo\.modules\.shareintent/);
      checkStock();
      const pika = /lukmccall\/pika\/(IsIntrospectableKt\.isIntrospectable|IntrospectionOfKt\.introspectionOf|TypeDescriptorOfKt\.throwNonReifiedTypeDescriptorError)|should be replaced by the compiler plugin|reified type parameter/;
      const qualified = desklinkBytecode(); writeFileSync(join(scratch, 'desklink-qualified.javap'), qualified); assert.doesNotMatch(qualified, pika);
      const path = join(app, 'android/build.gradle');
      const control = build.replace(/\/\/ @byokit\/share desklink:[\s\S]*?\n}\n/, '');
      assert.notEqual(control, build);
      try {
        writeFileSync(path, control); gradle([':desklink-react-native:clean', ':desklink-react-native:assembleRelease']);
        const negative = desklinkBytecode(); writeFileSync(join(scratch, 'desklink-negative.javap'), negative); assert.match(negative, pika);
      } finally { writeFileSync(path, build); }
      checkStock();
    }
  }
  if (!args.includes('--android-only')) {
    run(expo, ['prebuild', '--clean', '--no-install', '-p', 'ios']); checkIos(require);
    run(expo, ['prebuild', '--no-install', '-p', 'ios']); checkIos(require); checkStock();
  }
  writeFileSync(join(scratch, 'result.json'), JSON.stringify({ passed: true, args, packed: packed.integrity, receipts }, null, 2));
  console.log(`PASS: packed prebuild${args.includes('--build') ? '/JVM/bytecode' : ''}; evidence ${scratch}; native UI not exercised`);
} catch (e) {
  writeFileSync(join(scratch, 'failure.txt'), String(e)); console.error(`FAIL: preserved ${scratch}`); throw e;
}
