// Packed consumer regression: Expo must discover the plugin through package exports on SDK 55.
// Run after npm ci: node scripts/statusbar-expo-smoke.ts. Needs registry access; separate from offline tests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lab = join(root, '.lab');
mkdirSync(lab, { recursive: true });
const scratch = mkdtempSync(join(lab, 'statusbar-expo55-'));
const app = join(scratch, 'app');
const home = join(scratch, 'home');
mkdirSync(app);
mkdirSync(home);
const env = { ...process.env, HOME: home, CI: '1', EXPO_NO_TELEMETRY: '1', npm_config_cache: join(lab, 'npm-cache') };
function run(bin: string, args: string[], cwd = app): string {
  return execFileSync(bin, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}
try {
  const [packed] = Object.values(JSON.parse(run('npm', ['pack', './packages/statusbar', '--pack-destination', scratch, '--json'], root)) as Record<string, { filename: string }>);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'statusbar-expo55-smoke', private: true, version: '1.0.0' }));
  // SDK 55's supported React Native/React pair; normal peer resolution (no legacy-peer-deps).
  console.log(run('npm', ['install', '--no-audit', '--no-fund', 'expo@~55.0.0', 'react-native@0.83.2', 'react@19.2.0', join(scratch, packed!.filename)]));
  const require = createRequire(join(app, 'package.json'));
  const plugin = require.resolve('@byokit/statusbar/app.plugin.js');
  assert.ok(plugin.startsWith(join(app, 'node_modules')), 'resolve the packed install, not a workspace symlink');
  assert.equal(typeof require(plugin).default, 'function');
  const expoVersion = (require('expo/package.json') as { version: string }).version;
  assert.ok(expoVersion.startsWith('55.'));
  console.log(`Expo ${expoVersion}; packed plugin: ${plugin}`);
  writeFileSync(join(app, 'app.json'), JSON.stringify({ expo: {
    name: 'StatusbarSmoke', slug: 'statusbar-smoke', android: { package: 'io.byokit.statusbarsmoke' },
    plugins: ['@byokit/statusbar'],
  } }));
  console.log(run(join(app, 'node_modules/.bin/expo'), ['prebuild', '--platform', 'android', '--no-install']));
  const manifest = readFileSync(join(app, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('android.permission.POST_PROMOTED_NOTIFICATIONS'));
  console.log('PASS: packed plugin resolves and Expo 55 Android prebuild adds POST_PROMOTED_NOTIFICATIONS');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
