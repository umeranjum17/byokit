// Every file the example bundles of react, react-native and each Expo module must be the app's own copy,
// as an install from npm would give. Usage: node scripts/bundle-single-copy.ts <dist-dir>
// (from examples/expo: node ../../scripts/bundle-single-copy.ts dist).
// Metro emits server-relative sources, so the app copy and the repository-root copy collapse to one path;
// the bundled sourcesContent is fingerprinted against the app's node_modules instead.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const appModules = join(repo, 'examples', 'expo', 'node_modules');
const names = ['react', 'react-native', 'expo-modules-core', 'expo-linking', 'expo-secure-store'];

const maps: string[] = [];
const walk = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.map')) maps.push(full);
  }
};
walk(resolve(process.argv[2]));

let bad = 0;
for (const map of maps) {
  const { sources, sourcesContent } = JSON.parse(readFileSync(map, 'utf8'));
  for (const name of names) {
    const roots = new Set<string>();
    const offenders: string[] = [];
    sources.forEach((source: string, i: number) => {
      const marker = `node_modules/${name}/`;
      const at = source.indexOf(marker);
      if (at < 0) return;
      let appCopy: string | null = null;
      try {
        appCopy = readFileSync(join(appModules, name, source.slice(at + marker.length)), 'utf8');
      } catch {
        appCopy = null;
      }
      if (appCopy !== null && appCopy === sourcesContent[i]) roots.add('examples/expo/node_modules');
      else {
        roots.add('node_modules');
        if (offenders.length < 5) offenders.push(source);
      }
    });
    console.log(`${map} ${name} ${JSON.stringify([...roots])}${offenders.length ? ` e.g. ${offenders.join(', ')}` : ''}`);
    if (roots.size !== 1 || !roots.has('examples/expo/node_modules')) bad = 1;
  }
}
process.exit(bad);
