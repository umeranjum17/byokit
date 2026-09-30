// Where the installed engine lives: its package dir (realpath) and its JS bin entry. test/engine/ only.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_PACKAGE } from '../../src/constants.ts';

// The entry is `<dir>/src/index.ts`; the package only exports `.` and `./src/*`, so package.json is found beside it.
export const engineDir = realpathSync(join(dirname(fileURLToPath(import.meta.resolve(ENGINE_PACKAGE))), '..'));
const manifest = JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')) as { name: string; bin: Record<string, string> };
if (manifest.name !== ENGINE_PACKAGE) throw new Error(`${engineDir} is ${manifest.name}, not ${ENGINE_PACKAGE}`);
export const engineBin = join(engineDir, manifest.bin[ENGINE_PACKAGE]!);
