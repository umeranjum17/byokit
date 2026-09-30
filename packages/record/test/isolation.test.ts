// BK-C2 (docs/capability-kits.md 8): the full contract against the fake recorder with HOME pointing at a decoy of
// someone's signed-in setup. The decoy stays untouched, and no recorder run sees a decoy path, key or canary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { CANARY, decoy } from '../../accounts/src/testing/index.ts';
import { Capture } from '../src/capture.ts';
import { captureContract, fakeRecorder, type FakeRecorder } from '../src/testing/index.ts';

const d = decoy(scratchDir('capture-decoy'));
const saved = { ...process.env };
Object.assign(process.env, d.env);
const fakes: FakeRecorder[] = [];

captureContract(async () => {
  const dir = scratchDir('capture-isolated');
  const fake = fakeRecorder({ dir: join(dir, 'fake') });
  fakes.push(fake);
  const root = join(dir, 'takes');
  mkdirSync(root);
  return { capture: new Capture({ bin: fake.bin, stateDir: join(dir, 'state') }), source: 'x11::99', root, fake };
});

test('isolation: the decoy is untouched and no recorder run saw it', () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  assert.deepEqual(d.changed(), []);
  assert.deepEqual(d.ran(), []);
  const runs = fakes.flatMap((f) => f.invocations());
  assert.ok(runs.length > 20);
  for (const run of runs) {
    const seen = JSON.stringify([run.argv, run.env]);
    assert.ok(!seen.includes(d.root), 'a decoy path reached the recorder');
    assert.ok(!seen.includes(CANARY), 'a canary reached the recorder');
    assert.ok(run.env['HOME']!.endsWith('/capture/home'));
  }
});
