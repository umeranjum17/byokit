// Bundles the phone page (`npm run build:web`), with the Herdr kit's version from its package.json built in, so the
// page can say which version it is beside the computer's.
import { build } from 'esbuild';
import { packageVersion } from '@byokit/usage/version/node';

const version = packageVersion(new URL('../package.json', import.meta.resolve('@byokit/herdr')));
await build({ entryPoints: ['web/app.ts'], outfile: 'web/app.js', bundle: true, format: 'esm', platform: 'browser', target: 'es2022',
  logLevel: 'warning', define: { __BYOKIT_APP_VERSION__: JSON.stringify(version) } });
