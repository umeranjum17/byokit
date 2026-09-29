// Config plugin (docs/capability-kits.md 12.6): adds POST_PROMOTED_NOTIFICATIONS, the manifest-only permission a
// status-bar chip needs on Android 16. The library manifest carries POST_NOTIFICATIONS and the dismissal receiver.
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** @param {import('expo/config').ExpoConfig} config */
export default function withStatus(config) {
  // `expo` is the app's (a peer), so resolve it from the app: a linked kit's own path may have none above it.
  const app = createRequire(join(config._internal?.projectRoot ?? process.cwd(), 'package.json'));
  const { AndroidConfig } = app('expo/config-plugins');
  return AndroidConfig.Permissions.withPermissions(config, ['android.permission.POST_PROMOTED_NOTIFICATIONS']);
}
