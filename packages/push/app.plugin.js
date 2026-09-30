import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, copyFileSync, writeFileSync } from 'node:fs';

const source = join(dirname(fileURLToPath(import.meta.url)), 'ios');
const targetName = 'ByokitNoticeService';

/** Adds an isolated NSE with pinned libsodium, plus the shared App Group keychain entitlement. */
export default function withNotices(config, options = {}) {
  const app = createRequire(join(config._internal?.projectRoot ?? process.cwd(), 'package.json'));
  const { withEntitlementsPlist, withInfoPlist, withXcodeProject, AndroidConfig, withAndroidManifest } = app('expo/config-plugins');
  const plist = app('@expo/plist').default;
  const group = options.appGroup;
  if (typeof group !== 'string' || !/^group\.[A-Za-z0-9.-]+$/.test(group)) throw new Error('notices: appGroup is required');
  const bundle = config.ios?.bundleIdentifier;
  if (typeof bundle !== 'string' || !bundle) throw new Error('notices: ios.bundleIdentifier is required');
  const groups = (values) => [...new Set([...(values ?? []), group])];
  config.extra ??= {};
  config.extra.eas ??= {};
  config.extra.eas.build ??= {};
  config.extra.eas.build.experimental ??= {};
  config.extra.eas.build.experimental.ios ??= {};
  const eas = config.extra.eas.build.experimental.ios;
  eas.appExtensions = [...(eas.appExtensions ?? []).filter((t) => t.targetName !== targetName), {
    targetName, bundleIdentifier: `${bundle}.notices`, entitlements: { 'com.apple.security.application-groups': [group] },
  }];
  config = withEntitlementsPlist(config, (c) => {
    c.modResults['com.apple.security.application-groups'] = groups(c.modResults['com.apple.security.application-groups']);
    return c;
  });
  config = withInfoPlist(config, (c) => { c.modResults.ByokitNoticeAppGroup = group; return c; });
  config = AndroidConfig.Permissions.withPermissions(config, ['android.permission.POST_NOTIFICATIONS']);
  // A host with a pre-existing FCM service must opt out and forward to NoticeHandler.
  if (options.androidService === false) config = withAndroidManifest(config, (c) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(c.modResults);
    application.service ??= [];
    application.service.push({ $: { 'android:name': 'io.github.umeranjum17.byokit.notices.NoticeMessagingService', 'tools:node': 'remove' } });
    c.modResults.manifest.$['xmlns:tools'] = 'http://schemas.android.com/tools';
    return c;
  });
  return withXcodeProject(config, (c) => {
    const project = c.modResults;
    const objects = project.hash.project.objects;
    const existing = Object.entries(objects.PBXNativeTarget).find(([id, t]) => !id.endsWith('_comment') && t.name?.replaceAll('"', '') === targetName);
    const target = existing ? { uuid: existing[0], pbxNativeTarget: existing[1] } : project.addTarget(targetName, 'app_extension', targetName, `${bundle}.notices`);
    const folder = join(c.modRequest.platformProjectRoot, targetName);
    mkdirSync(folder, { recursive: true });
    for (const [from, to] of [['NoticeKeyStore.swift', 'NoticeKeyStore.swift'], ['Extension/NoticePayload.swift', 'NoticePayload.swift'], ['Extension/NotificationService.swift', 'NotificationService.swift']]) copyFileSync(join(source, from), join(folder, to));
    writeFileSync(join(folder, `${targetName}-Info.plist`), plist.build({
      CFBundleDisplayName: 'Updates', CFBundleIdentifier: '$(PRODUCT_BUNDLE_IDENTIFIER)', CFBundleExecutable: '$(EXECUTABLE_NAME)',
      CFBundleName: '$(PRODUCT_NAME)', CFBundlePackageType: 'XPC!', CFBundleShortVersionString: config.version ?? '1.0',
      CFBundleVersion: String(config.ios?.buildNumber ?? '1'), ByokitNoticeAppGroup: group,
      NSExtension: { NSExtensionPointIdentifier: 'com.apple.usernotifications.service', NSExtensionPrincipalClass: '$(PRODUCT_MODULE_NAME).NotificationService' },
    }));
    writeFileSync(join(folder, `${targetName}.entitlements`), plist.build({ 'com.apple.security.application-groups': [group] }));
    const configs = objects.XCConfigurationList[target.pbxNativeTarget.buildConfigurationList].buildConfigurations;
    for (const entry of configs) Object.assign(objects.XCBuildConfiguration[entry.value].buildSettings, {
      SWIFT_VERSION: '5.9', IPHONEOS_DEPLOYMENT_TARGET: '15.1', TARGETED_DEVICE_FAMILY: '"1,2"',
      APPLICATION_EXTENSION_API_ONLY: 'YES', CODE_SIGN_ENTITLEMENTS: `${targetName}/${targetName}.entitlements`,
      CURRENT_PROJECT_VERSION: String(config.ios?.buildNumber ?? '1'), MARKETING_VERSION: config.version ?? '1.0',
      ...(config.ios?.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
    });
    if (!existing) {
      const files = ['NoticeKeyStore.swift', 'NoticePayload.swift', 'NotificationService.swift'].map((f) => `${targetName}/${f}`);
      project.addBuildPhase(files, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
      for (const file of Object.values(objects.PBXFileReference)) {
        if (typeof file === 'object') for (const key of Object.keys(file)) if (file[key] === undefined) delete file[key];
      }
      const frameworks = project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
      const remote = project.generateUuid(), product = project.generateUuid(), build = project.generateUuid();
      objects.XCRemoteSwiftPackageReference ??= {};
      objects.XCRemoteSwiftPackageReference[remote] = { isa: 'XCRemoteSwiftPackageReference', repositoryURL: '"https://github.com/jedisct1/swift-sodium.git"', requirement: { kind: 'exactVersion', version: '0.11.0' } };
      objects.XCSwiftPackageProductDependency ??= {};
      objects.XCSwiftPackageProductDependency[product] = { isa: 'XCSwiftPackageProductDependency', package: remote, productName: 'Clibsodium' };
      objects.PBXBuildFile[build] = { isa: 'PBXBuildFile', productRef: product };
      frameworks.buildPhase.files.push({ value: build, comment: 'Clibsodium in Frameworks' });
      target.pbxNativeTarget.packageProductDependencies = [{ value: product, comment: 'Clibsodium' }];
      const root = project.getFirstProject().firstProject;
      root.packageReferences ??= [];
      root.packageReferences.push({ value: remote, comment: 'swift-sodium' });
    }
    return c;
  });
}
