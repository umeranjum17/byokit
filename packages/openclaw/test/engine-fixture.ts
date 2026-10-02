// Offline fake-engine tests still verify authentic patch bytes; they never execute this engine module.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../src/engine-patches.ts';
export function seedWorkshopPatchTarget(engineDir: string): void {
  const bytes = readFileSync(new URL('./fixtures/workshop-review-2026.8.1.js', import.meta.url));
  assert.equal(sha256(bytes), '30f43da07b2520dd785df42ba417737a0f2cc0286922fe2189f06ecbafc1ab9c');
  const dir = join(engineDir, 'node_modules/openclaw/dist'); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'experience-review-default-6DPIIJds.js'), bytes);
}
