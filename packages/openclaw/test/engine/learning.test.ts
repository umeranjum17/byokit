// Learning-state proof: the named learning surface over the one-key pair, against a real engine boot. The mode the
// app writes while stopped is what the Gateway applies (config.get), the collection-review cron job follows it
// (enabled only on auto, the engine default when the key is absent), and a captured state restores byte for byte.
// Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { scratchDir } from '../../../test-support.ts';

const install = scratchDir('o11-engine-learning');
const engineDir = join(install, 'engine');

before(async () => {
  // Install the pin once; the case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

test('learning is captured, applied by a real boot and restored exactly', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o-learning');
  const file = join(stateDir, 'openclaw', 'openclaw.json');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [] });
  // What the real Gateway itself applied, straight from the engine, never from the kit's own file read.
  const applied = async () => ((await kit.call('config.get', {})) as { config?: Record<string, any> }).config
    ?.skills?.workshop?.autonomous?.mode;
  // The system-owned job the engine projects per workspace agent: enabled only while the mode is auto.
  const reviewJob = async () => {
    const page = await kit.call('cron.list', { includeDisabled: true }) as { jobs?: { name?: string; enabled?: boolean }[] };
    return page.jobs?.find(job => job.name === 'skill-collection-review-m1');
  };
  const withoutSkills = (config: string) => { const c = JSON.parse(config); delete c.skills; return c; };
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.deepEqual(kit.learning(), { present: false }, 'the fresh home starts without the learning key');
    assert.equal(await applied(), undefined, 'the pin starts without the key');
    await kit.ensureMember('m1'); // a workspace agent, so the projected review job names it
    await kit.stop();
    const pristine = readFileSync(file, 'utf8'); // before any learning write

    assert.deepEqual(kit.setLearning('off'), { present: false }, 'the set reports the state it replaced');
    await kit.start();
    assert.equal(await applied(), 'off', 'the real engine did not apply the mode written while stopped');
    const disabled = await reviewJob();
    assert.ok(disabled, 'no collection-review job for m1 after boot');
    assert.equal(disabled.enabled, false, 'the collection review stayed enabled with learning off');
    await kit.stop();

    assert.deepEqual(kit.learning(), { present: true, mode: 'off' }, 'the read lost the mode a boot applied');
    const owned = readFileSync(file, 'utf8');
    assert.deepEqual(kit.setLearning('propose'), { present: true, mode: 'off' });
    assert.deepEqual(kit.learning(), { present: true, mode: 'propose' });
    assert.deepEqual(kit.restoreLearning({ present: true, mode: 'off' }), { present: true, mode: 'off' });
    assert.equal(readFileSync(file, 'utf8'), owned, 'the restore did not land the file byte for byte');

    assert.throws(() => kit.setLearning('On' as never), /unknown learning mode "On", expected off\|propose\|auto\|default/);
    kit.setConfigKey('skills.workshop.autonomous.mode', 'nonsense'); // a corrupted value, as a stray write leaves
    assert.throws(() => kit.learning(), /stored skills\.workshop\.autonomous\.mode is "nonsense", not one of off\|propose\|auto/);
    assert.deepEqual(kit.restoreLearning({ present: true, mode: 'off' }), { present: true, mode: 'off' },
      'a restore did not repair an out-of-enum stored value');

    assert.deepEqual(kit.restoreLearning({ present: false }), { present: false });
    assert.deepEqual(kit.learning(), { present: false }, 'restoring absence left a mode behind');
    assert.deepEqual(withoutSkills(readFileSync(file, 'utf8')), withoutSkills(pristine),
      'a restore to absence did not leave every other key, and their order, alone');

    await kit.start();
    assert.equal(await applied(), undefined, 'the restored boot carried a mode where the file has none');
    const enabled = await reviewJob();
    assert.ok(enabled, 'no collection-review job for m1 after the restored boot');
    assert.equal(enabled.enabled, true, 'the engine default (auto) did not re-enable the collection review');
    await kit.stop();

    const colliding = new OpenClawKit({ stateDir, engineDir, tools: [], config: { skills: { workshop: { autonomous: { mode: 'auto' } } } } });
    assert.throws(() => colliding.setLearning('off'), /KitOptions\.config also passes skills/);
    assert.throws(() => colliding.restoreLearning({ present: false }), /KitOptions\.config also passes skills/);
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
