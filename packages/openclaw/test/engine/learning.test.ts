// Learning-state proof: the named learning surface over the one-key pair, against a real engine boot. The mode the
// app writes while stopped is what the Gateway applies (config.get), a retired `propose` lands on off, and a captured
// state restores byte for byte.
// Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { PluginInstallError } from '../../src/plugins.ts';
import { Engine } from '../../src/engine.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';

const install = scratchDir('o11-engine-learning');
const engineDir = sharedEngineDir() ?? join(install, 'engine');

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
  // 11.1 retired the per-agent collection-review cron job with the curator: no mode may bring it back.
  const noReviewJob = async () => {
    const page = await kit.call('cron.list', { includeDisabled: true }) as { jobs?: { name?: string }[] };
    assert.equal(page.jobs?.some(j => j.name === 'skill-collection-review-m1'), false);
  };
  const withoutSkills = (config: string) => { const c = JSON.parse(config); delete c.skills; return c; };
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.deepEqual(kit.learning(), { present: false }, 'the fresh home starts without the learning key');
    assert.equal(await applied(), undefined, 'the pin starts without the key');
    await kit.ensureMember('m1'); // a workspace agent, so the projected review job names it
    await kit.ensureMember('m2');
    const skillDir = join(stateDir, 'openclaw', 'state', 'agents', 'm1', 'agent', 'workshop-skills', 'weather-planner');
    mkdirSync(skillDir, { recursive: true });
    const content = '---\nname: weather-planner\ndescription: Plan the weather check for Umer.\n---\nCheck the weather before making plans.\n';
    writeFileSync(join(skillDir, 'SKILL.md'), content);
    assert.ok((await kit.call('skills.workshop.list', { agentId: 'm1' })).skills.some(skill => skill.name === 'weather-planner'));
    assert.equal((await kit.call('skills.workshop.read', { agentId: 'm1', name: 'weather-planner' })).content, content);
    assert.equal((await kit.call('skills.workshop.list', { agentId: 'm2' })).skills.length, 0, 'another agent must not inherit learned skills');
    await assert.rejects(kit.call('skills.workshop.read', { agentId: 'm2', name: 'weather-planner' }), /weather-planner|not found|does not exist/i);
    await assert.rejects(kit.installPlugin('telnyx'), error => error instanceof PluginInstallError && error.code === 'unsupported_plugin');
    await kit.stop();
    const pristine = readFileSync(file, 'utf8'); // before any learning write

    assert.deepEqual(kit.setLearning('off'), { present: false }, 'the set reports the state it replaced');
    await kit.start();
    assert.equal(await applied(), 'off', 'the real engine did not apply the mode written while stopped');
    assert.equal((await kit.call('skills.workshop.read', { agentId: 'm1', name: 'weather-planner' })).content, content, 'native collection survives a restart');
    await noReviewJob();
    await kit.stop();

    assert.deepEqual(kit.learning(), { present: true, mode: 'off' }, 'the read lost the mode a boot applied');
    const owned = readFileSync(file, 'utf8');
    assert.deepEqual(kit.setLearning('auto'), { present: true, mode: 'off' });
    assert.deepEqual(kit.learning(), { present: true, mode: 'auto' });
    assert.deepEqual(kit.restoreLearning({ present: true, mode: 'off' }), { present: true, mode: 'off' });
    assert.equal(readFileSync(file, 'utf8'), owned, 'the restore did not land the file byte for byte');

    assert.throws(() => kit.setLearning('On' as never), /unknown learning mode "On", expected off\|auto\|default/);
    assert.throws(() => kit.setLearning('propose' as never), /retired "propose".*expected off\|auto\|default/);
    kit.setConfigKey('skills.workshop.autonomous.mode', 'nonsense'); // a corrupted value, as a stray write leaves
    assert.throws(() => kit.learning(), /stored skills\.workshop\.autonomous\.mode is "nonsense", not one of off\|auto/);
    assert.deepEqual(kit.restoreLearning({ present: true, mode: 'off' }), { present: true, mode: 'off' },
      'a restore did not repair an out-of-enum stored value');

    assert.deepEqual(kit.restoreLearning({ present: false }), { present: false });
    assert.deepEqual(kit.learning(), { present: false }, 'restoring absence left a mode behind');
    assert.deepEqual(withoutSkills(readFileSync(file, 'utf8')), withoutSkills(pristine),
      'a restore to absence did not leave every other key, and their order, alone');

    await kit.start();
    assert.equal(await applied(), undefined, 'the restored boot carried a mode where the file has none');
    await noReviewJob();
    await kit.stop();

    // A home saved before 11.1: the retired review-first mode lands on off at a real boot, never the engine's fallback auto.
    kit.setConfigKey('skills.workshop.autonomous.mode', 'propose');
    assert.deepEqual(kit.learning(), { present: true, mode: 'off' });
    await kit.start();
    assert.equal(await applied(), 'off', 'a stored propose must not boot as auto');
    await noReviewJob();
    await kit.stop();
    assert.equal(kit.getConfigKey('skills.workshop.autonomous.mode'), 'off');
    assert.deepEqual(kit.restoreLearning({ present: true, mode: 'propose' } as never), { present: true, mode: 'off' }, 'an old capture restores as off');

    const colliding = new OpenClawKit({ stateDir, engineDir, tools: [], config: { skills: { workshop: { autonomous: { mode: 'auto' } } } } });
    assert.throws(() => colliding.setLearning('off'), /KitOptions\.config also passes skills/);
    assert.throws(() => colliding.restoreLearning({ present: false }), /KitOptions\.config also passes skills/);
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
