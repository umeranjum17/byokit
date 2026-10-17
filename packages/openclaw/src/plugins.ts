// External provider plugins (5.7, B7): the pins the kit installs at, and the ids it installed. Installing is the
// kit's explicit call; discovery only reads the record.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomic } from './engine-patches.ts';
import { ENGINE_VERSION } from './constants.ts';
import { routes } from './routes.ts';

export type PluginInstallFailure = 'unknown_plugin' | 'version' | 'integrity' | 'install';
export class PluginInstallError extends Error {
  readonly code: PluginInstallFailure;
  constructor(code: PluginInstallFailure, message: string) {
    super(message);
    this.name = 'PluginInstallError'; this.code = code;
  }
}

type Pin = { spec: string; integrity: string };
const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));
/** engine/plugins.json: `{ "<plugin id>": { spec: '<package>@<engine version>', integrity } }`. */
export const pluginPins = (): Record<string, Pin> =>
  JSON.parse(readFileSync(join(kitDir, 'engine', 'plugins.json'), 'utf8')) as Record<string, Pin>;

/** The exact spec to install for a plugin a route needs: its `install.npmSpec` at the engine pin, and pinned so. */
export function pinnedSpec(pluginId: string): Pin {
  const npmSpec = routes().find(route => route.needs?.plugin === pluginId && route.install?.npmSpec)?.install?.npmSpec;
  if (!npmSpec) throw new PluginInstallError('unknown_plugin', `No route needs a plugin named ${pluginId}.`);
  const pin = pluginPins()[pluginId];
  if (pin?.spec !== `${npmSpec}@${ENGINE_VERSION}`)
    throw new PluginInstallError('version', `${pluginId} has no pin for engine ${ENGINE_VERSION}.`);
  return pin;
}

const recordOf = (root: string) => join(root, 'installed-plugins.json');
/** The external plugins this kit installed into its own engine. */
export function installedPlugins(root: string): string[] {
  const path = recordOf(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as string[] : [];
}
export function recordPlugin(root: string, pluginId: string): void {
  const installed = installedPlugins(root);
  if (!installed.includes(pluginId)) atomic(recordOf(root), JSON.stringify([...installed, pluginId]) + '\n');
}
