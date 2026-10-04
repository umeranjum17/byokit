import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

const extension = 'com.apple.product-type.app-extension';
const hidden = `${extension}.byokit-hidden`;
const fail = (message) => { throw new Error(`@byokit/share: ${message}`); };
const unquote = (value) => typeof value === 'string' ? value.replace(/^"|"$/g, '') : value;
const targets = (section) => Object.entries(section).filter(([key, value]) => !key.endsWith('_comment') && typeof value === 'object');
const targetName = (target) => unquote(target.productName ?? target.name);

// Matches apple-targets 5.0.0's sanitizeNameForNonDisplayUse, including order.
export function sanitize(name) {
  return name.replace(/[\W_]+/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function fromAppleTargets(config) {
  const app = createRequire(join(config._internal.projectRoot, 'package.json'));
  const upstream = createRequire(app.resolve('@bacons/apple-targets/package.json'));
  return { globSync: upstream('glob').globSync, load: (path) => upstream(path) };
}
export function ownedTargetNames(config, { root = './targets', match = '*' } = {}, { globSync, load } = fromAppleTargets(config)) {
  const names = new Set();
  for (const path of globSync(`${root}/${match}/expo-target.config.@(json|js)`, { cwd: config._internal.projectRoot, absolute: true })) {
    let value = load(path);
    if (typeof value === 'function') value = value(config);
    if (!value || typeof value !== 'object' || !value.type) continue;
    const dir = basename(dirname(path));
    const name = sanitize(value.name || dir) || sanitize(dir) || sanitize(value.type);
    if (name) names.add(name);
  }
  return names;
}
export function assertNoOrphanSibling(section, owned) {
  const present = new Set(targets(section).map(([, t]) => targetName(t)));
  if ([...owned].some((name) => present.has(name)) && [...owned].some((name) => !present.has(name))) {
    fail('adding an apple target requires expo prebuild --clean');
  }
}
export function hideForeignExtensions(section, owned) {
  const names = [];
  for (const [, target] of targets(section)) {
    if (unquote(target.productType) === extension && !owned.has(targetName(target))) {
      target.productType = `"${hidden}"`;
      names.push(targetName(target));
    }
  }
  return names;
}
export function restoreHidden(text) {
  return text.replace(/productType = "?com\.apple\.product-type\.app-extension\.byokit-hidden"?;/g,
    'productType = "com.apple.product-type.app-extension";');
}
export function insertShareExclude(contents) {
  if (contents.includes('// @byokit/share exclude')) return contents;
  const anchor = /^([ \t]*)expoAutolinking\.useExpoModules\(\)/m;
  if (!anchor.test(contents)) fail('settings.gradle is missing expoAutolinking.useExpoModules()');
  return contents.replace(anchor, (_, indent) => `${indent}// @byokit/share exclude: @byokit/share reads shares on Android; keep expo-share-intent's native code out\n${indent}expoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ['expo-share-intent']\n${indent}expoAutolinking.useExpoModules()`);
}
export function insertDesklinkGradle(contents) {
  if (contents.includes('// @byokit/share desklink')) return contents;
  const anchor = /^apply plugin:\s*["']com\.facebook\.react\.rootproject["']/m;
  const index = contents.search(anchor);
  if (index < 0 || !/apply plugin:\s*["']expo-root-project["']/.test(contents.slice(0, index))) {
    fail('build.gradle must apply expo-root-project before com.facebook.react.rootproject');
  }
  return contents.slice(0, index) + `// @byokit/share desklink: build @desklink/react-native as an Expo module (Expo SDK 57 needs its compile step)
def byokitDesklink = findProject(':desklink-react-native')
if (byokitDesklink != null) {
  if (byokitDesklink.state.executed) throw new GradleException('@byokit/share: :desklink-react-native was configured before the Expo module plugin could apply')
  byokitDesklink.apply plugin: 'expo-module-gradle-plugin'
  byokitDesklink.expoModule.canBePublished = false
  byokitDesklink.expoModule.enableCompileTimeOptimization = true
}
` + contents.slice(index);
}

export default function withShare(config, options = {}) {
  for (const key of Object.keys(options)) if (!['shareIntent', 'appleTargets', 'desklink'].includes(key)) fail(`unknown option ${key}`);
  if (options.desklink !== undefined && typeof options.desklink !== 'boolean') fail('desklink must be a boolean');
  for (const entry of config.plugins ?? []) {
    const name = Array.isArray(entry) ? entry[0] : entry;
    if (name === 'expo-share-intent' || name === '@bacons/apple-targets') fail(`remove duplicate plugin ${name}; the kit applies it`);
  }
  const mode = options.shareIntent?.androidMainActivityAttributes?.['android:launchMode'];
  if (mode !== undefined && mode !== 'singleTask') fail('MainActivity must stay singleTask so a share reaches the running app');
  if (!options.shareIntent && !options.appleTargets && !options.desklink) return config;
  const app = createRequire(join(config._internal?.projectRoot ?? process.cwd(), 'package.json'));
  const { withBaseMod, withFinalizedMod, withSettingsGradle, withProjectBuildGradle, AndroidConfig, IOSConfig } = app('expo/config-plugins');
  const interop = (module) => module.default ?? module;
  if (options.shareIntent) {
    config = interop(app('expo-share-intent/app.plugin.js'))(config, options.shareIntent);
    config = withBaseMod(config, { platform: 'android', mod: 'manifest', isProvider: false, action: async (c) => {
      c = await c.modRequest.nextMod(c);
      if (AndroidConfig.Manifest.getMainActivityOrThrow(c.modResults).$['android:launchMode'] !== 'singleTask') {
        fail('MainActivity must stay singleTask so a share reaches the running app');
      }
      return c;
    } });
    config = withSettingsGradle(config, (c) => { c.modResults.contents = insertShareExclude(c.modResults.contents); return c; });
  }
  if (options.appleTargets) {
    const owned = ownedTargetNames(config, options.appleTargets);
    config = interop(app('@bacons/apple-targets/app.plugin.js'))(config, options.appleTargets);
    config = withBaseMod(config, { platform: 'ios', mod: 'xcodeproj', isProvider: false, action: async (c) => {
      c = await c.modRequest.nextMod(c);
      const section = c.modResults.hash.project.objects.PBXNativeTarget;
      assertNoOrphanSibling(section, owned);
      hideForeignExtensions(section, owned);
      return c;
    } });
    config = withFinalizedMod(config, ['ios', async (c) => {
      const path = IOSConfig.Paths.getPBXProjectPath(c.modRequest.projectRoot);
      writeFileSync(path, restoreHidden(readFileSync(path, 'utf8')));
      return c;
    }]);
  }
  if (options.desklink) config = withProjectBuildGradle(config, (c) => {
    c.modResults.contents = insertDesklinkGradle(c.modResults.contents); return c;
  });
  return config;
}
