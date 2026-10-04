'use strict';
// tsc drops `with { type: 'json' }` when emitting .d.ts, so a strict NodeNext consumer with skipLibCheck:false
// fails on `import WORDS from './words.json'` with TS1543. The .js emit keeps the attribute (runtime is fine),
// so re-add it to each package's words.d.ts after every build. Idempotent: a fixed file is left untouched.
const { readFileSync, writeFileSync, existsSync, cpSync, rmSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
// tsc emits neither generated JS nor its published-type re-exports. Both build and accounts prepack run this.
const pi = join(root, 'packages/accounts/src/pi');
const piDist = join(root, 'packages/accounts/dist/pi');
if (existsSync(pi) && existsSync(join(root, 'packages/accounts/dist'))) {
  rmSync(piDist, { recursive: true, force: true });
  cpSync(pi, piDist, { recursive: true });
}
for (const pkg of ['accounts', 'realtime', 'openclaw', 'herdr', 'write', 'record', 'overlay', 'cloud', 'statusbar', 'usage', 'share', 'infer', 'outbox']) {
  const file = join(root, 'packages', pkg, 'dist', 'words.d.ts');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; } // dist not built yet: nothing to fix
  const fixed = text.replaceAll("from './words.json';", "from './words.json' with { type: 'json' };");
  if (fixed !== text) writeFileSync(file, fixed);
}
