import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';

test('repair once after exit 78, leave unrelated stale pid alone', async () => {
  const dir = scratchDir('engine-unit');
  const engineDir = join(dir, 'engine');
  const entryDir = join(engineDir, 'node_modules', 'openclaw');
  mkdirSync(entryDir, { recursive: true });
  writeFileSync(join(entryDir, 'package.json'), JSON.stringify({ version: '2026.8.1' }));
  writeFileSync(join(entryDir, 'openclaw.mjs'), `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
const marker = new URL('../../marker', import.meta.url);
if (process.argv[2] === 'doctor') { appendFileSync(new URL('../../doctors', import.meta.url), '1'); process.exit(0); }
if (!existsSync(marker)) { writeFileSync(marker, '1'); process.exit(78); }
process.exit(78);`);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const states: string[] = [];
  const engine = new Engine({ stateDir: dir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true, onState: s => states.push(s.phase), onExit() {} });
  try {
    mkdirSync(join(dir, 'openclaw'));
    writeFileSync(join(dir, 'openclaw', 'gateway.pid'), String(unrelated.pid));
    await engine.start();
    for (let i = 0; i < 50 && !states.includes('failed'); i++) await delay(100);
    assert.deepEqual(states.filter(x => ['starting', 'repairing', 'failed'].includes(x)), ['starting', 'repairing', 'starting', 'failed']);
    assert.equal(readFileSync(join(engineDir, 'doctors'), 'utf8'), '1');
    assert.equal(unrelated.exitCode, null);
  } finally {
    await engine.stop();
    unrelated.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepare defaults to bridge.sock/__byokit and honors explicit bridge options', async () => {
  const dir = scratchDir('engine-unit');
  try {
    const plain = new Engine({ stateDir: dir, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} });
    await plain.prepare();
    assert.equal(plain.bridgeSock, join(dir, 'openclaw', 'bridge.sock'));
    assert.match(readFileSync(join(dir, 'openclaw', 'plugin', 'tools.json'), 'utf8'), /"__byokit_permit"/);
    await plain.stop();

    const custom = new Engine({ stateDir: dir, pluginId: 'acme', tools: [], spawnEngine: false,
      bridge: { socketName: 'acmed.sock', paramPrefix: '__acme' }, onState() {}, onExit() {} });
    await custom.prepare();
    assert.equal(custom.bridgeSock, join(dir, 'openclaw', 'acmed.sock'));
    assert.match(readFileSync(join(dir, 'openclaw', 'plugin', 'tools.json'), 'utf8'), /"__acme_permit"/);
    assert.equal(existsSync(join(dir, 'openclaw', 'bridge.sock')), false);
    await custom.stop();

    assert.throws(() => new Engine({ stateDir: dir, pluginId: 'byokit', tools: [], spawnEngine: false,
      bridge: { socketName: '../evil.sock' }, onState() {}, onExit() {} }), /invalid bridge socketName/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
