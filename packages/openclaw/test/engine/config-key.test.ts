// Config gap proof: one config key, narrowed. An app reads and writes exactly one dotted key in the config
// file prepare() owns, a real boot applies it, and the value the app had comes back byte for byte. Never a whole
// config read: stock config.get redacts token-bearing values, so a value read through it can never be restored
// unchanged. Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { scratchDir } from '../../../test-support.ts';

const install = scratchDir('o11-engine-config-key');
const engineDir = join(install, 'engine');
const KEY = 'skills.workshop.autonomous.mode';

before(async () => {
  // Install the pin once; the case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

test('one config key is narrowed across real boots and restored byte for byte', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o11-config-key');
  const file = join(stateDir, 'openclaw', 'openclaw.json');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [] });
  // What the real Gateway itself applied, straight from the engine, never from the kit's own file read.
  const applied = async () => ((await kit.call('config.get', {})) as { config?: Record<string, any> }).config
    ?.skills?.workshop?.autonomous?.mode;
  const withoutSkills = (config: string) => { const c = JSON.parse(config); delete c.skills; return c; };
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.equal(kit.getConfigKey(KEY), undefined, 'the narrow read found the key absent');
    assert.equal(await applied(), undefined, 'the pin starts without the key');
    await kit.stop();

    assert.equal(kit.setConfigKey(KEY, 'auto'), undefined, 'the narrow set reports the value it replaced');
    const owned = readFileSync(file, 'utf8');
    assert.deepEqual(JSON.parse(owned).skills, { workshop: { autonomous: { mode: 'auto' } } });
    const stamp = statSync(file).mtimeMs;
    assert.equal(kit.setConfigKey(KEY, 'auto'), 'auto');
    assert.equal(readFileSync(file, 'utf8'), owned, 'a narrow set rewrote bytes it did not change');
    assert.equal(statSync(file).mtimeMs, stamp, 'an unchanged key must not rewrite the file at all');
    assert.equal(kit.setConfigKey('skills.workshop.never.set', undefined), undefined);
    assert.equal(readFileSync(file, 'utf8'), owned, 'removing an absent key left litter behind');

    await kit.start();
    assert.equal(await applied(), 'auto', 'the real engine did not apply the narrowed key');
    await kit.stop();

    assert.equal(kit.getConfigKey(KEY), 'auto', 'the narrow read lost the value a boot applied');
    assert.equal(kit.setConfigKey(KEY, 'off'), 'auto');
    assert.deepEqual(withoutSkills(readFileSync(file, 'utf8')), withoutSkills(owned),
      'a narrow set must leave every other key, and their order, alone');

    assert.equal(kit.setConfigKey(KEY, 'auto'), 'off', 'the restore reports the value it replaced');
    assert.equal(readFileSync(file, 'utf8'), owned, 'the restore did not land the original file byte for byte');
    await kit.start();
    assert.equal(await applied(), 'auto', 'the restored boot did not carry the original value');
    await kit.stop();
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});