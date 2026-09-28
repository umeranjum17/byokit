import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';

test('repair once after exit 78, leave unrelated stale pid alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-'));
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
