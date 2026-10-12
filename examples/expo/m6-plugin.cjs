const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');
const { mkdir, copyFile } = require('node:fs/promises');
const { join } = require('node:path');
module.exports = config => {
  const enabled = process.env.EXPO_PUBLIC_CLOUD_M6 === '1';
  config = withAndroidManifest(config, c => {
    const app = c.modResults.manifest.application[0];
    app.provider = (app.provider || []).filter(p => p.$['android:name'] !== '.ImportProvider');
    if (enabled) app.provider.push({ $: { 'android:name': '.ImportProvider', 'android:authorities': 'io.github.umeranjum17.byokit.example.m6', 'android:exported': 'true' } });
    return c;
  });
  return enabled ? withDangerousMod(config, ['android', async c => {
    const dir = join(c.modRequest.platformProjectRoot, 'app/src/main/java/io/github/umeranjum17/byokit/example');
    await mkdir(dir, { recursive: true }); await copyFile(join(__dirname, 'm6/ImportProvider.kt'), join(dir, 'ImportProvider.kt')); return c;
  }]) : config;
};
