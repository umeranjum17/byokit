import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs, { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
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

// An opaque fake: only its in-memory map can recover bytes, and changed ciphertext is rejected.
function fakeSeal() {
  const values = new Map<string, string>();
  let n = 0;
  return {
    encryptString(text: string) {
      const id = `opaque-${++n}`;
      values.set(id, text);
      return new TextEncoder().encode(id);
    },
    decryptString(bytes: Buffer) {
      const value = values.get(new TextDecoder().decode(bytes));
      if (value === undefined) throw new Error('authentication failed');
      return value;
    },
  };
}

test('sealed engine store covers SQLite, journals, JSON and isolated home; stop, prepare and restart retain no plaintext at rest', async () => {
  const dir = scratchDir('seal');
  const seal = fakeSeal();
  const o = { stateDir: dir, authSeal: seal, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} };
  const engine = new Engine(o);
  const agent = join(engine.root, 'state', 'agents', 'm1', 'agent');
  const secret = 'access-token-canary-and-refresh-token';
  mkdirSync(agent, { recursive: true });
  mkdirSync(join(engine.root, 'home', '.codex'), { recursive: true });
  for (const name of ['openclaw-agent.sqlite', 'openclaw-agent.sqlite-wal', 'auth-profiles.json']) writeFileSync(join(agent, name), secret);
  writeFileSync(join(engine.root, 'state', 'openclaw.sqlite'), secret);
  writeFileSync(join(engine.root, 'home', '.codex', 'auth.json'), secret);
  await engine.prepare();
  assert.equal(existsSync(join(engine.root, 'state')), false);
  assert.equal(existsSync(join(engine.root, 'home')), false);
  const sealed = join(engine.root, 'auth-store.sealed');
  assert.equal(readFileSync(sealed).includes(secret), false);
  await engine.prepare(); // must not replace the saved store with newly created empty directories
  await engine.start();
  assert.equal(readFileSync(join(agent, 'openclaw-agent.sqlite-wal'), 'utf8'), secret);
  const { statSync } = await import('node:fs');
  assert.equal(statSync(join(agent, 'openclaw-agent.sqlite')).mode & 0o777, 0o600);
  assert.equal(statSync(agent).mode & 0o777, 0o700);
  writeFileSync(join(agent, 'openclaw-agent.sqlite'), 'refreshed-token-canary');
  await engine.stop();
  assert.equal(existsSync(agent), false);
  const restarted = new Engine(o);
  await restarted.start();
  assert.equal(readFileSync(join(agent, 'openclaw-agent.sqlite'), 'utf8'), 'refreshed-token-canary');
  await restarted.stop();
  assert.equal(existsSync(join(engine.root, 'home')), false);
  assert.equal(readFileSync(sealed).includes(secret), false);
  await assert.rejects(new Engine({ ...o, authSeal: undefined }).start(), /authSeal required/);
  await restarted.start();
  assert.equal(readFileSync(join(agent, 'openclaw-agent.sqlite'), 'utf8'), 'refreshed-token-canary', 'refusing a missing adapter cannot replace the snapshot with empty directories');
  await restarted.stop();
  // A power loss between removing the two live trees must retain the completed snapshot.
  mkdirSync(join(engine.root, 'state'));
  writeFileSync(join(engine.root, 'auth-store.cleanup'), '1');
  await restarted.prepare();
  await restarted.start();
  assert.equal(readFileSync(join(agent, 'openclaw-agent.sqlite'), 'utf8'), 'refreshed-token-canary');
  await restarted.stop();
  writeFileSync(sealed, 'tampered');
  await assert.rejects(new Engine(o).start(), /authentication failed/);
  assert.equal(existsSync(agent), false, 'tamper rejection happens before any plaintext is restored');
  writeFileSync(sealed, seal.encryptString(JSON.stringify({ v: 1, dirs: ['state'], files: [['state/../escape', 'dG9rZW4=']] })));
  await assert.rejects(new Engine(o).start(), /invalid sealed credential file/);
  assert.equal(existsSync(join(engine.root, 'escape')), false);

});

test('sealing rejects concurrent owners, and does not claim stopped when the seal fails', async () => {
  const dir = scratchDir('seal-errors');
  const seal = fakeSeal();
  let fail = false;
  const states: string[] = [];
  const o = { stateDir: dir, authSeal: { decryptString: seal.decryptString, encryptString: (text: string) => {
    if (fail) throw new Error('key unavailable');
    return seal.encryptString(text);
  } }, pluginId: 'byokit', tools: [], spawnEngine: false, onState(s: { phase: string }) { states.push(s.phase); }, onExit() {} };
  const engine = new Engine(o);
  await engine.start();
  const other = new Engine(o);
  await assert.rejects(other.start(), /credential store is in use/);
  writeFileSync(join(engine.root, 'state', 'auth.json'), 'still-recoverable');
  fail = true;
  await assert.rejects(engine.stop(), /key unavailable/);
  assert.equal(states.includes('stopped'), false);
  assert.equal(readFileSync(join(engine.root, 'state', 'auth.json'), 'utf8'), 'still-recoverable');
  fail = false;
  await engine.stop();
});

test('sealed migration follows only in-root file symlinks and skips runtime entries', { skip: process.platform === 'win32' }, async (t) => {
  const { migrateRetainedLogin } = await import('../src/migrate.ts');
  const dir = scratchDir('seal-runtime');
  const seal = fakeSeal();
  const o = { stateDir: dir, authSeal: seal, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} };
  const engine = new Engine(o);
  const state = join(engine.root, 'state');
  const token = join(state, 'credentials', 'token.json');
  const linked = join(state, 'linked.json');
  const chain = join(state, 'chain.json');
  // A sibling whose name shares the engine root prefix must still be outside the boundary.
  const outside = join(engine.root + '-outside', 'canary');
  const escape = join(state, 'outside.json');
  const indirect = join(state, 'indirect.json');
  const dangling = join(state, 'dangling.json');
  const directory = join(state, 'directory');
  const loop = join(state, 'loop');
  const socket = join(state, 'runtime.sock');
  const source = join(dir, 'retained.json');
  mkdirSync(join(token, '..'), { recursive: true });
  mkdirSync(join(outside, '..'), { recursive: true });
  writeFileSync(token, 'in-root-token');
  writeFileSync(outside, 'outside-root-canary', { mode: 0o644 });
  writeFileSync(source, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'migration-access', refresh: 'migration-refresh' } }));
  symlinkSync('credentials/token.json', linked);
  symlinkSync('linked.json', chain);
  symlinkSync(outside, escape);
  symlinkSync('outside.json', indirect);
  symlinkSync('missing.json', dangling);
  symlinkSync('.', directory);
  symlinkSync('loop', loop);
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  const originalRead = fs.readFileSync;
  const reads = t.mock.method(fs, 'readFileSync', (...args: Parameters<typeof fs.readFileSync>) => {
    assert.ok(![outside, escape, indirect].includes(String(args[0])), 'outside-root canary must never be read');
    return originalRead(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(await migrateRetainedLogin({ root: engine.root, seal, prepare: () => engine.prepare(),
      withStore: (task) => engine.withAuthStore(task), doctor: () => ({ status: 0 }) }, 'm1', { path: source }), 'staged');
    assert.equal(existsSync(state), false, 'migration leaves the store sealed');
    const saved = seal.decryptString(readFileSync(join(engine.root, 'auth-store.sealed')));
    assert.equal(saved.includes(Buffer.from('outside-root-canary').toString('base64')), false);
    assert.equal(reads.mock.calls.some(({ arguments: args }) => [outside, escape, indirect].includes(String(args[0]))), false);
    assert.equal(originalRead(outside, 'utf8'), 'outside-root-canary');
    assert.equal(lstatSync(outside).mode & 0o777, 0o644, 'outside-root permissions are untouched');
    await engine.start();
    for (const path of [token, linked, chain]) {
      assert.equal(readFileSync(path, 'utf8'), 'in-root-token');
      assert.equal(lstatSync(path).isFile(), true, 'followed symlinks restore as regular files');
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
    }
    for (const path of [escape, indirect, dangling, directory, loop, socket])
      assert.equal(existsSync(path), false, 'skipped entries are never restored');
    assert.match(readFileSync(join(state, 'agents', 'm1', 'agent', 'auth-profiles.json'), 'utf8'), /migration-access/);
    await engine.stop();
    await engine.start();
    assert.equal(readFileSync(linked, 'utf8'), 'in-root-token', 'a second seal/restore retains the followed content');
    await engine.stop();
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepare seals old auth archives and offline migration reseals even after a doctor failure', async () => {
  const { migrateRetainedLogin, confirmRetainedLogin } = await import('../src/migrate.ts');
  const dir = scratchDir('seal-migrate');
  const seal = fakeSeal();
  const events: string[] = [];
  const engine = new Engine({ stateDir: dir, authSeal: seal, pluginId: 'byokit', tools: [], spawnEngine: false,
    log: (line) => events.push(line), onState() {}, onExit() {} });
  const source = join(dir, 'legacy.json');
  const moved = source + '.moved-to-engine';
  writeFileSync(moved, JSON.stringify({ 'openai-codex': { type: 'oauth', access: 'migration-access', refresh: 'migration-refresh' } }));
  const agent = join(engine.root, 'state', 'agents', 'm1', 'agent');
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, 'auth-profiles.json.migrated-old'), 'migration-access');
  writeFileSync(join(agent, 'auth.json.sqlite-import.old.bak'), 'migration-refresh');
  await engine.prepare();
  assert.equal(existsSync(moved), false);
  assert.equal(existsSync(moved + '.sealed'), true);
  assert.equal(events.filter((line) => line === 'credential archive sealed').length, 3);
  const ctx = { root: engine.root, seal, prepare: () => engine.prepare(),
    withStore: <T>(task: () => Promise<T>) => engine.withAuthStore(task), doctor: () => ({ status: 1 }) };
  assert.equal(await migrateRetainedLogin(ctx, 'm1', { path: source }), 'failed');
  assert.equal(existsSync(join(engine.root, 'state')), false, 'doctor failure reseals the store');
  assert.ok(seal.decryptString(readFileSync(moved + '.sealed')), 'unconfirmed legacy copy remains recoverable');
  assert.equal(await migrateRetainedLogin({ ...ctx, doctor: () => ({ status: 0 }) }, 'm1', { path: source }), 'staged');
  assert.equal(existsSync(join(agent, 'auth-profiles.json')), false);
  await engine.start();
  assert.match(readFileSync(join(agent, 'auth-profiles.json'), 'utf8'), /migration-access/);
  assert.equal(existsSync(join(agent, 'auth-profiles.json.migrated-old')), false, 'archives are never restored as live sources');
  assert.equal(await confirmRetainedLogin({ seal, callbackPort: 0, ensure: async () => ({ agentId: 'm1' }),
    request: async () => ({ providers: ['openai'] }) }, 'm1', { path: source }), true);
  assert.equal(existsSync(moved + '.sealed'), false);
  assert.equal(existsSync(moved + '.canonicalized'), true);
  await engine.stop();
});
