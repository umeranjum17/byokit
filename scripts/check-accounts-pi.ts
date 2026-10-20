// CI: the bundled Pi copy and routes.json follow the installed pi-ai. Dependabot moves the caret range; this fails its
// bump PR until both are regenerated from the new version, so neither goes stale silently. Offline: the installed pin only.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generateRoutes } from './gen-accounts-routes.ts';

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
const installed = JSON.parse(readFileSync(fileURLToPath(new URL('../', import.meta.resolve('@earendil-works/pi-ai'))) + 'package.json', 'utf8')).version;
const bundled = JSON.parse(read('packages/accounts/src/pi/PROVENANCE.json')).version;
const stale = [
  ...(bundled !== installed ? [`packages/accounts/src/pi is pi-ai ${bundled}, installed is ${installed}`] : []),
  ...(JSON.stringify(generateRoutes(), null, 2) + '\n' !== read('packages/accounts/src/routes.json') ? ['packages/accounts/src/routes.json differs from its generator'] : []),
];
if (stale.length) {
  console.error(`${stale.join('\n')}\nRegenerate: set the verified registry record in scripts/gen-accounts-pi.ts to \`npm view @earendil-works/pi-ai@${installed} dist\`, then run \`node scripts/gen-accounts-pi.ts && node scripts/gen-accounts-routes.ts\`.`);
  process.exitCode = 1;
} else console.log(`accounts pi: ${installed} bundled, routes.json current`);
