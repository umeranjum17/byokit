'use strict';
// tsc drops `with { type: 'json' }` when emitting .d.ts, so a strict NodeNext consumer with skipLibCheck:false
// fails on `import WORDS from './words.json'` with TS1543. The .js emit keeps the attribute (runtime is fine),
// so re-add it to each package's words.d.ts after every build. Idempotent: a fixed file is left untouched.
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
for (const pkg of ['accounts', 'openclaw', 'herdr', 'compose', 'capture', 'overlay', 'machine']) {
  const file = join(root, 'packages', pkg, 'dist', 'words.d.ts');
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; } // dist not built yet: nothing to fix
  const fixed = text.replaceAll("from './words.json';", "from './words.json' with { type: 'json' };");
  if (fixed !== text) writeFileSync(file, fixed);
}
