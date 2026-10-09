import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';

const evidence = resolve(process.argv[2]);
// File-backed surface: no gateway, no sockets, but keep the same short-path convention as the other captures.
const stateDir = mkdtempSync('.verify-artifacts/learning-');
const root = join(stateDir, 'openclaw');
const file = join(root, 'openclaw.json');
const KEY = 'skills.workshop.autonomous.mode';
try {
  const kit = new OpenClawKit({ stateDir, spawnEngine: false });
  await kit.prepare();
  assert.deepEqual(kit.learning(), { present: false }, 'a fresh home starts without the key');
  console.log('fresh home:', JSON.stringify(kit.learning()));

  assert.deepEqual(kit.setLearning('off'), { present: false });
  assert.deepEqual(kit.learning(), { present: true, mode: 'off' });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).skills.workshop.autonomous.mode, 'off');
  const owned = readFileSync(file, 'utf8');
  console.log('after setLearning(off):', JSON.stringify(kit.learning()));

  assert.deepEqual(kit.setLearning('propose'), { present: true, mode: 'off' });
  assert.deepEqual(kit.learning(), { present: true, mode: 'propose' }, 'propose must be visible, not folded into on');
  assert.deepEqual(kit.restoreLearning({ present: true, mode: 'off' }), { present: true, mode: 'off' });
  assert.equal(readFileSync(file, 'utf8'), owned, 'restore is byte for byte');
  console.log('capture/restore round trip: byte for byte');

  assert.deepEqual(kit.setLearning('default'), { present: true, mode: 'off' });
  assert.deepEqual(kit.learning(), { present: false }, 'default removes the key');
  console.log('setLearning(default):', JSON.stringify(kit.learning()));

  const refusals = [];
  try { kit.setLearning('On'); } catch (error) { refusals.push(['unknown mode', error.message]); }
  kit.setConfigKey(KEY, 'nonsense');
  try { kit.learning(); } catch (error) { refusals.push(['out-of-enum stored value', error.message]); }
  kit.setConfigKey(KEY, 'off'); // repair, as restoreLearning does on a real home
  const colliding = new OpenClawKit({ stateDir, spawnEngine: false, config: { skills: { workshop: { autonomous: { mode: 'auto' } } } } });
  try { colliding.setLearning('off'); } catch (error) { refusals.push(['KitOptions.config skills', error.message]); }
  try { colliding.restoreLearning({ present: false }); } catch (error) { refusals.push(['KitOptions.config skills (restore)', error.message]); }
  for (const [name, message] of refusals) console.log('refused', name + ':', message);
  assert.equal(refusals.length, 4, 'every refusal must have fired');
  await kit.stop();
  console.log('LEARNING-STATE OK');
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
