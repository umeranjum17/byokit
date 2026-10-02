// node packages/openclaw/scripts/engine-patches.ts <stock-openclaw-package-dir> [--check]
// Stock comes from npm ci using engine/package-lock.json; never from a source build.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editText, patchId, readPatchSet, sha256 } from '../src/engine-patches.ts';
import { ENGINE_VERSION } from '../src/constants.ts';
const engine = fileURLToPath(new URL('../engine/', import.meta.url));
const stock = process.argv[2];
if (!stock || stock.startsWith('--')) throw new Error('pass stock openclaw package dir (installed from the shipped lock)');
const lock = JSON.parse(readFileSync(join(engine, 'package-lock.json'), 'utf8'));
const path = join(engine, 'patches.json');
const set = readPatchSet(path, ENGINE_VERSION, lock.packages['node_modules/openclaw'].integrity);
assert.equal(JSON.parse(readFileSync(join(stock, 'package.json'), 'utf8')).version, ENGINE_VERSION);
assert.equal(JSON.parse(readFileSync(join(stock, 'dist/build-info.json'), 'utf8')).commit, set.upstream.commit);
assert.equal(readFileSync(join(stock, 'LICENSE'), 'utf8'), readFileSync(join(engine, 'OPENCLAW-LICENSE'), 'utf8'));
const markerPath = join(stock, '../../.byokit-patches');
if (existsSync(markerPath)) assert.deepEqual(JSON.parse(readFileSync(markerPath, 'utf8')).files, [], 'derive against stock, never a patched set');
const functions = new Map<string, string>();
const files = set.files.map(file => {
  const text = readFileSync(join(stock, file.path), 'utf8');
  for (const edit of file.edits) for (const match of edit.find.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) functions.set(match[1]!, file.path);
  return { ...file, before: sha256(text), after: sha256(editText(text, file)) };
});
if (functions.size) for (const entry of readdirSync(join(stock, 'dist'), { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.m?js$/.test(entry.name)) continue;
  const absolute = join(entry.parentPath, entry.name);
  const relative = absolute.slice(stock.length + 1).replaceAll('\\', '/');
  if (relative === 'dist/worker/worker.mjs') continue; // explicitly uncovered by D19
  const text = readFileSync(absolute, 'utf8');
  for (const [name, source] of functions) if (relative !== source) assert.ok(!new RegExp(`\\bfunction\\s+${name.replaceAll('$', '\\$')}\\s*\\(`).test(text), `unpatched Gateway copy: ${name} in ${relative}`);
}
const result = JSON.stringify({ ...set, id: patchId(files), files }, null, 2) + '\n';
if (process.argv.includes('--check')) assert.equal(readFileSync(path, 'utf8'), result, 'patch hashes/id need re-derivation');
else writeFileSync(path, result);
console.log(`engine patches ${patchId(files)}: ${files.length} pinned files; stock ${set.upstream.commit}`);
