// Config plugin (docs/capability-kits.md 7.6): copies the app's mood images into drawables and raises the app's
// minSdk to 26. The library manifest (android/src/main/AndroidManifest.xml) carries everything else; Gradle merges it.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const MOOD = /^[a-z][a-z0-9_]{0,63}$/;
const MIN_SDK = 26;

/** @param {import('expo/config').ExpoConfig} config @param {{ moods?: Record<string, string> }} [o] */
export default function withOverlay(config, { moods = {} } = {}) {
  for (const name of Object.keys(moods)) if (!MOOD.test(name)) throw new Error(`overlay: mood must match ${MOOD}`);
  // `expo` is the app's (a peer), so resolve it from the app: a linked kit's own path may have none above it.
  const app = createRequire(join(config._internal?.projectRoot ?? process.cwd(), 'package.json'));
  const { withDangerousMod, withGradleProperties } = app('expo/config-plugins');
  config = withGradleProperties(config, (c) => {
    const min = c.modResults.find((p) => p.type === 'property' && p.key === 'android.minSdkVersion');
    if (!min) c.modResults.push({ type: 'property', key: 'android.minSdkVersion', value: String(MIN_SDK) });
    else if (!(Number(min.value) >= MIN_SDK)) min.value = String(MIN_SDK);
    return c;
  });
  return withDangerousMod(config, ['android', (c) => {
    const dir = join(c.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'drawable-nodpi');
    mkdirSync(dir, { recursive: true });
    for (const [name, asset] of Object.entries(moods)) copyFileSync(resolve(c.modRequest.projectRoot, asset), join(dir, `${name}.png`));
    return c;
  }]);
}
