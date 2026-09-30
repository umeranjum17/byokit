import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDir } from '../../test-support.ts';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';

const shippedEngine = fileURLToPath(new URL('../engine/', import.meta.url));
const lock = JSON.parse(readFileSync(join(shippedEngine, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version: string; optional?: boolean; os?: string[]; cpu?: string[]; libc?: string[] }>;
};
function seedInstall(engineDir: string) {
  mkdirSync(engineDir, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) {
    writeFileSync(join(engineDir, file), readFileSync(join(shippedEngine, file)));
  }
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path) continue;
    mkdirSync(join(engineDir, path), { recursive: true });
    writeFileSync(join(engineDir, path, 'package.json'), JSON.stringify({ version: pkg.version }));
  }
  writeFileSync(join(engineDir, 'node_modules/openclaw/openclaw.mjs'), '');
}

test('prepare repairs stale manifests and dependencies, and reuses a matching install', async () => {
  const dir = scratchDir('prepare');
  const engineDir = join(dir, 'engine');
  const npmPath = join(dir, 'npm.mjs');
  const calls = join(engineDir, 'npm-calls');
  seedInstall(engineDir);
  writeFileSync(npmPath, `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
const dir = args.at(-1);
if (JSON.stringify(args.slice(0, -1)) !== JSON.stringify(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix'])) process.exit(1);
if (existsSync(join(dir, 'node_modules/stale-marker'))) process.exit(2);
const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path) continue;
  mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ version: pkg.version }));
}
writeFileSync(join(dir, 'node_modules/openclaw/openclaw.mjs'), '');
appendFileSync(join(dir, 'npm-calls'), '1');
`, { mode: 0o700 });
  const engine = new Engine({ stateDir: dir, engineDir, npmPath, pluginId: 'byokit', tools: [],
    spawnEngine: true, onState() {}, onExit() {} });
  try {
    // npm omits optional packages for other operating systems.
    const incompatible = Object.entries(lock.packages).find(([path, pkg]) => path && pkg.optional && pkg.os &&
      !pkg.os.includes(process.platform) && !pkg.os.includes('any'));
    assert.ok(incompatible, 'shipped lock includes a platform-incompatible optional package');
    rmSync(join(engineDir, incompatible[0]), { recursive: true });
    const otherCpu = Object.entries(lock.packages).find(([path, pkg]) => path && pkg.optional && pkg.cpu &&
      !pkg.cpu.includes(process.arch) && !pkg.cpu.includes('any'));
    assert.ok(otherCpu, 'shipped lock includes a CPU-incompatible optional package');
    rmSync(join(engineDir, otherCpu[0]), { recursive: true, force: true });
    if (process.platform === 'linux') {
      const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
      const libc = report.header.glibcVersionRuntime ? 'glibc' : 'musl';
      const otherLibc = Object.entries(lock.packages).find(([path, pkg]) => path && pkg.optional && pkg.libc &&
        !pkg.libc.includes(libc) && pkg.os?.includes(process.platform) && pkg.cpu?.includes(process.arch));
      assert.ok(otherLibc, 'shipped lock includes a libc-incompatible optional package');
      rmSync(join(engineDir, otherLibc[0]), { recursive: true, force: true });
    }
    await engine.prepare();
    assert.equal(existsSync(calls), false, 'matching install is reused, including absent incompatible optional packages');

    const dependency = 'node_modules/@agentclientprotocol/sdk';
    let expectedCalls = '';
    for (const damage of [
      () => rmSync(join(engineDir, 'package.json')),
      () => writeFileSync(join(engineDir, 'package.json'), '{}'),
      () => writeFileSync(join(engineDir, 'package-lock.json'), readFileSync(join(shippedEngine, 'package-lock.json'), 'utf8') + '\n'),
      () => rmSync(join(engineDir, dependency), { recursive: true }),
      () => writeFileSync(join(engineDir, dependency, 'package.json'), '{"version":"0.0.0"}'),
      () => writeFileSync(join(engineDir, dependency, 'package.json'), '{broken'),
    ]) {
      damage();
      writeFileSync(join(engineDir, 'node_modules/stale-marker'), 'old install');
      await engine.prepare();
      expectedCalls += '1';
      assert.equal(readFileSync(calls, 'utf8'), expectedCalls, 'damaged install calls npm ci');
      for (const file of ['package.json', 'package-lock.json']) {
        assert.deepEqual(readFileSync(join(engineDir, file)), readFileSync(join(shippedEngine, file)));
      }
      assert.equal(JSON.parse(readFileSync(join(engineDir, dependency, 'package.json'), 'utf8')).version,
        lock.packages[dependency]!.version);
      await engine.prepare();
      assert.equal(readFileSync(calls, 'utf8'), expectedCalls, 'repaired install is reused');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repair once after exit 78, leave unrelated stale pid alone', async () => {
  const dir = scratchDir('engine-unit');
  const engineDir = join(dir, 'engine');
  const entryDir = join(engineDir, 'node_modules', 'openclaw');
  seedInstall(engineDir);
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
