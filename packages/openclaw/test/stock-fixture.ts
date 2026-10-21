import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { editText, patchId, readPatchSet, sha256, type PatchFile } from '../src/engine-patches.ts';

const manifest = fileURLToPath(new URL('../engine/patches.json', import.meta.url));
// Large bundles whose fake installs need only the shipped edit's input, not the entire upstream bundle.
const synthetic = new Set(['dist/prepare.runtime--y1-AtS2.mjs', 'dist/setup-inference-ur2QGopt.mjs']);

export function stockBytes(file: PatchFile): Buffer {
  return synthetic.has(file.path)
    ? Buffer.from(file.edits.map(edit => edit.find).join('\n'))
    : fs.readFileSync(fileURLToPath(new URL(`./fixtures/stock/${file.path}.txt`, import.meta.url)));
}

// Keep production hashes unchanged: only these fake installs use synthetic byte hashes.
export function useSyntheticStock(t: TestContext): void {
  syncBuiltinESMExports();
  const lock = JSON.parse(fs.readFileSync(new URL('../engine/package-lock.json', import.meta.url), 'utf8'));
  const set = readPatchSet(manifest, '2026.9.33', lock.packages['node_modules/openclaw'].integrity);
  const files = set.files.map(file => {
    const bytes = stockBytes(file);
    if (!synthetic.has(file.path)) {
      assert.equal(sha256(bytes), file.before, `stock byte fixture drift: ${file.path}`);
      return file;
    }
    return { ...file, before: sha256(bytes), after: sha256(editText(bytes.toString(), file)) };
  });
  const json = JSON.stringify({ ...set, files, id: patchId(files) });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === manifest) return String(args[1]) === 'utf8' ? json : Buffer.from(json);
    return read(...args);
  });
  syncBuiltinESMExports();
}
