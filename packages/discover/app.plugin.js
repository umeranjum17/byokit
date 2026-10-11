// Config plugin: declares the iOS Bonjour service types browse() scans and a local-network usage
// string, so an Expo app's browse() finds the computer instead of quietly finding nothing. The
// Android side needs nothing here: react-native-zeroconf's own manifest already merges
// CHANGE_WIFI_MULTICAST_STATE.
import { createRequire } from 'node:module';
import { join } from 'node:path';

const DEFAULT_LOCAL_NETWORK =
  'Allow this app to find and connect to your own computer on your local network.';

/**
 * @param {import('expo/config').ExpoConfig} config
 * @param {{ services?: string[], localNetwork?: string }} [options]
 */
export default function withDiscover(config, options = {}) {
  const services = options.services;
  // A plugin with no options, or an empty list, is a misconfiguration: fail prebuild by name
  // rather than write an empty Bonjour list that would silently break iOS discovery.
  if (!Array.isArray(services) || services.length === 0 ||
      services.some((s) => typeof s !== 'string' || s.trim() === '')) {
    throw new Error('discover: the config plugin needs "services", a non-empty list of Bonjour types, e.g. ["_byokit._tcp"]');
  }
  const localNetwork =
    typeof options.localNetwork === 'string' && options.localNetwork.trim() !== ''
      ? options.localNetwork
      : DEFAULT_LOCAL_NETWORK;
  // `expo` is the app's (a peer), so resolve it from the app: a linked kit's own path may have none above it.
  const app = createRequire(join(config._internal?.projectRoot ?? process.cwd(), 'package.json'));
  const { withInfoPlist } = app('expo/config-plugins');
  return withInfoPlist(config, (c) => {
    c.modResults.NSBonjourServices = [...new Set(services.map((s) => s.trim()))];
    c.modResults.NSLocalNetworkUsageDescription = localNetwork;
    return c;
  });
}
