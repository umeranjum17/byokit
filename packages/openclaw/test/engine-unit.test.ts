import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs, { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch, scratchDir } from '../../test-support.ts';
import childProcess, { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';
import { pidAlive } from '../src/engine-status.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { hostKeySeal } from '../../secrets/src/index.ts';
import { once } from 'node:events';
import { EnginePatchError, editText, patchId, prepareEngineSet, readPatchSet, sha256, verifyEngineSet, type PatchSet } from '../src/engine-patches.ts';

// Unit-only byte fixtures, not real-engine qualification; production entries are seeded as exact stock bytes.
test('immutable sets validate all bytes, clone offline, roll back by selection and preserve drift', async (t) => {
  const dir = scratchDir('patches');
  const base = join(dir, 'base');
  const shipped = shippedSet();
  const file = { path: 'dist/lab.js', before: sha256('const lab = 1;\n'), after: sha256('const lab = 2;\n'), edits: [{ find: 'lab = 1', replace: 'lab = 2' }] };
  const set: PatchSet = { ...shipped, id: patchId([file]), files: [file] };
  let installs = 0;
  const install = (tmp: string) => {
    installs++; seedInstall(tmp);
    writeFileSync(join(tmp, 'node_modules/openclaw', file.path), 'const lab = 1;\n');
    writeFileSync(join(tmp, 'unpatched'), 'stock');
    fs.symlinkSync('unpatched', join(tmp, 'relative-link'));
  };
  const matches = () => true;
  try {
    const stock = await prepareEngineSet(base, shipped, install, matches);
    const patched = await prepareEngineSet(base, set, install, matches);
    assert.equal(installs, 1, 'patched set clones verified stock without installing');
    assert.equal(existsSync(base), false, 'base is never read or written');
    assert.equal(fs.readlinkSync(join(patched, 'relative-link')), 'unpatched');
    const before = readFileSync(join(patched, '.byokit-tree'));
    assert.equal(await prepareEngineSet(base, set, install, matches), patched);
    assert.deepEqual(readFileSync(join(patched, '.byokit-tree')), before);
    assert.equal(await prepareEngineSet(base, shipped, install, matches), stock, 'rollback selects original stock offline');
    for (const path of [join(patched, 'node_modules/openclaw', file.path), join(patched, 'unpatched')]) {
      fs.chmodSync(path, 0o644); writeFileSync(path, 'drift'); fs.chmodSync(path, 0o444);
      assert.throws(() => verifyEngineSet(patched, set, matches), /engine-patch: drift/);
      const next = await prepareEngineSet(base, set, install, matches);
      assert.notEqual(next, patched); assert.equal(installs, 1);
      assert.equal(readFileSync(path, 'utf8'), 'drift', 'drifted final is never repaired or deleted');
    }
    const malformed = join(dir, 'bad.json');
    writeFileSync(malformed, JSON.stringify({ ...set, id: '0000000000000000' }));
    assert.throws(() => readPatchSet(malformed, shipped.upstream.version, shipped.upstream.integrity), /engine-patch: spec/);
    const outside = { ...file, path: '../escape.js' };
    await assert.rejects(prepareEngineSet(base, { ...set, id: patchId([outside]), files: [outside] }, install, matches), /engine-patch: spec/);
    assert.throws(() => editText('lab = 1; lab = 1', file), /engine-patch: spec/);
    const originalRename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (...args: Parameters<typeof fs.renameSync>) => { if (String(args[0]).includes('.tmp-')) throw new Error('unit disk fault'); return originalRename(...args); });
    syncBuiltinESMExports();
    const other = { ...file, after: sha256('const lab = 3;\n'), edits: [{ find: 'lab = 1', replace: 'lab = 3' }] };
    await assert.rejects(prepareEngineSet(base, { ...set, id: patchId([other]), files: [other] }, install, matches), /engine-patch: write/);
    assert.ok(fs.readdirSync(base + '.sets').every(p => !p.startsWith('.tmp-')), 'own failed temp cleaned');
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); removeScratch(dir); }
});

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
  mkdirSync(join(engineDir, 'node_modules/openclaw/dist'), { recursive: true });
  writeFileSync(join(engineDir, 'node_modules/openclaw/dist/build-info.json'), JSON.stringify({ version: '2026.8.1', commit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b' }));
  for (const file of shippedSet().files) {
    const bytes = readFileSync(fileURLToPath(new URL(`./fixtures/stock/${file.path}.txt`, import.meta.url)));
    assert.equal(sha256(bytes), file.before, `stock byte fixture drift: ${file.path}`);
    const target = join(engineDir, 'node_modules/openclaw', file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function shippedSet(): PatchSet {
  return readPatchSet(join(shippedEngine, 'patches.json'), '2026.8.1', JSON.parse(readFileSync(join(shippedEngine, 'package-lock.json'), 'utf8')).packages['node_modules/openclaw'].integrity);
}
function seedSet(engineDir: string): Promise<string> {
  return prepareEngineSet(engineDir, shippedSet(), tmp => fs.cpSync(engineDir, tmp, { recursive: true }), () => true);
}

test('accounting start is fsynced before spawn; failed boot writes prevent spawn and pre-pid failure has durable zero-attempt proof', async t => {
  const dir = scratchDir('boot-order'), engineDir = join(dir, 'engine');
  seedInstall(engineDir); await seedSet(engineDir);
  const engine = new Engine({ stateDir: dir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true, onState() {}, onExit() {} });
  let spawns = 0, syncs = 0;
  const originalSync = fs.fsyncSync;
  try {
    await engine.prepare();
    const boots = join(engine.root, 'usage/boots.jsonl'); mkdirSync(boots);
    t.mock.method(childProcess, 'spawn', (_exe: string, _args: string[], options: any) => {
      spawns++;
      assert.ok(syncs > 0, 'boot record was fsynced before the spawn call');
      const rows = readFileSync(boots, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(rows.at(-1).bootId, options.env.BYOKIT_ENGINE_BOOT);
      assert.equal(options.env.BYOKIT_ENGINE_USAGE_LEDGER, join(engine.root, 'usage'));
      throw new Error('unit definite pre-pid failure');
    });
    t.mock.method(fs, 'fsyncSync', (...args: Parameters<typeof fs.fsyncSync>) => {
      originalSync(...args);
      if (existsSync(boots) && fs.statSync(boots).isFile() && fs.fstatSync(args[0]).ino === fs.statSync(boots).ino) syncs++;
    });
    syncBuiltinESMExports();
    await assert.rejects(engine.start(), /Usage boot record could not be made durable/); assert.equal(spawns, 0);
    rmSync(boots, { recursive: true });
    await assert.rejects(engine.start(), /unit definite pre-pid failure/); assert.equal(spawns, 1);
    const rows = readFileSync(boots, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.length, 2); assert.equal(rows[1].bootId, rows[0].bootId); assert.equal(rows[1].spawned, false);
    assert.ok(rows[1].failedAt >= rows[0].startedAt); assert.ok(syncs >= 2);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); await engine.stop(); removeScratch(dir); }
});

test('prepare verifies whole immutable installs and rebuilds drift without changing old trees', async () => {
  const dir = scratchDir('prepare');
  const engineDir = join(dir, 'engine');
  const npmPath = join(dir, 'npm.mjs');
  const calls = join(dir, 'npm-calls');
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
mkdirSync(join(dir, 'node_modules/openclaw/dist'), { recursive: true });
writeFileSync(join(dir, 'node_modules/openclaw/dist/build-info.json'), JSON.stringify({ version: '2026.8.1', commit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b' }));
appendFileSync(${JSON.stringify(calls)}, '1');
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
    await seedSet(engineDir);
    await engine.prepare();
    assert.equal(existsSync(calls), false, 'verified stock set is reused, including absent incompatible optional packages');

    const stockSet: PatchSet = { ...shippedSet(), id: patchId([]), files: [] };
    const stock = await prepareEngineSet(engineDir, stockSet, () => { throw new Error('verified stock must be reused offline'); }, () => true);
    const stockTree = readFileSync(join(stock, '.byokit-tree'));
    for (const path of ['package.json', 'package-lock.json', 'node_modules/@agentclientprotocol/sdk/package.json', 'node_modules/openclaw/dist/build-info.json', '.byokit-patches']) {
      const old = readFileSync(join(engine.root, 'engine-set'), 'utf8');
      const damaged = join(old, path);
      fs.chmodSync(damaged, 0o644); writeFileSync(damaged, '{broken'); fs.chmodSync(damaged, 0o444);
      await engine.prepare();
      assert.equal(existsSync(calls), false, 'patched drift clones verified stock offline, never invokes npm');
      const next = readFileSync(join(engine.root, 'engine-set'), 'utf8');
      assert.notEqual(next, old);
      verifyEngineSet(next, shippedSet(), () => true);
      verifyEngineSet(stock, stockSet, () => true);
      assert.deepEqual(readFileSync(join(stock, '.byokit-tree')), stockTree, 'stock cache remains byte-valid and unchanged');
      assert.equal(readFileSync(damaged, 'utf8'), '{broken', 'old final bytes preserved');
      await engine.prepare(); assert.equal(existsSync(calls), false);
    }
    const kit = new OpenClawKit({ stateDir: join(dir, 'other-state'), engineDir, npmPath, transport: fakeGateway().factory });
    await kit.prepare(); assert.equal(kit.state.patchSet, shippedSet().id);
    const old = readFileSync(join(engine.root, 'engine-set'), 'utf8');
    const damaged = join(old, '.byokit-patches');
    fs.chmodSync(damaged, 0o644); writeFileSync(damaged, '{broken'); fs.chmodSync(damaged, 0o444);
    // Only a damaged stock cache requires npm; all prior damage was to the patched/adopted set.
    const stockMarker = join(stock, '.byokit-patches');
    fs.chmodSync(stockMarker, 0o644); writeFileSync(stockMarker, '{broken'); fs.chmodSync(stockMarker, 0o444);
    writeFileSync(npmPath, readFileSync(npmPath, 'utf8').replace('ea806575e6450e4d1efdfc72c19f04be982a1b9b', '0000000000000000000000000000000000000000'), { mode: 0o700 });
    await assert.rejects(kit.prepare(), (e: unknown) => e instanceof EnginePatchError && e.cause === 'drift-after-build');
    assert.equal(kit.state.why, 'engine-patch'); assert.equal(kit.state.patchSet, null);
    assert.equal(readFileSync(calls, 'utf8'), '1', 'invalid stock cache invokes npm exactly once');
  } finally { removeScratch(dir); }
});

test('repair once after exit 78, leave unrelated stale pid alone', async () => {
  const dir = scratchDir('engine-unit');
  const engineDir = join(dir, 'engine');
  const entryDir = join(engineDir, 'node_modules', 'openclaw');
  seedInstall(engineDir);
  writeFileSync(join(entryDir, 'package.json'), JSON.stringify({ version: '2026.8.1' }));
  writeFileSync(join(entryDir, 'openclaw.mjs'), `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
const marker = ${JSON.stringify(join(engineDir, 'marker'))};
if (process.argv[2] === 'doctor') { appendFileSync(${JSON.stringify(join(engineDir, 'doctors'))}, '1'); process.exit(0); }
if (!existsSync(marker)) { writeFileSync(marker, '1'); process.exit(78); }
process.exit(78);`);
  await seedSet(engineDir);
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const states: string[] = [];
  const engine = new Engine({ stateDir: dir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true, onState: s => states.push(s.phase), onExit() {} });
  try {
    mkdirSync(join(dir, 'openclaw'));
    writeFileSync(join(dir, 'openclaw', 'gateway.pid'), String(unrelated.pid));
    await assert.rejects(engine.start(), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'engine-already-running');
    assert.equal(unrelated.exitCode, null);
    const exited = once(unrelated, 'exit'); unrelated.kill(); await exited;
    states.length = 0;
    await engine.start();
    for (let i = 0; i < 50 && !states.includes('failed'); i++) await delay(100);
    assert.deepEqual(states.filter(x => ['starting', 'repairing', 'failed'].includes(x)), ['starting', 'repairing', 'starting', 'failed']);
    assert.equal(readFileSync(join(engineDir, 'doctors'), 'utf8'), '1');
  } finally {
    await engine.stop();
    unrelated.kill();
    removeScratch(dir);
  }
});

// A real Engine over a real spawned gateway: 5.3 stop() signals the pids the kit started, never a process
// group. The gateway's own long-lived session shares that group and must outlive the kit's stop.
test('stop ends the gateway the kit started and leaves a process the kit never started running', { timeout: 120_000 }, async () => {
  const dir = scratchDir('engine-stop');
  const engineDir = join(dir, 'engine');
  const sessionPid = join(dir, 'session.pid');
  seedInstall(engineDir);
  writeFileSync(join(engineDir, 'node_modules/openclaw/openclaw.mjs'), `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'doctor') process.exit(0);
const session = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(sessionPid)}, String(session.pid));
setInterval(() => {}, 1000);
`);
  await seedSet(engineDir);
  const engine = new Engine({ stateDir: dir, engineDir, pluginId: 'byokit', tools: [], spawnEngine: true, onState() {}, onExit() {} });
  let session = 0;
  try {
    await engine.start();
    assert.equal(engine.doctor(30_000).status, 0, 'the started engine really runs against its isolated env');
    const gateway = Number(readFileSync(join(dir, 'openclaw', 'gateway.pid'), 'utf8'));
    for (let i = 0; i < 50 && !existsSync(sessionPid); i++) await delay(100);
    session = Number(readFileSync(sessionPid, 'utf8'));
    assert.ok(pidAlive(gateway) && pidAlive(session), 'the gateway the kit started and the session it started are both up');
    await engine.stop();
    assert.equal(pidAlive(gateway), false, 'the pid the kit started is gone');
    assert.equal(pidAlive(session), true, 'a process the kit never started survives the stop');
  } finally {
    if (session) { try { process.kill(session, 'SIGKILL'); } catch { /* already gone */ } }
    await engine.stop();
    removeScratch(dir);
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


test('a killed host leaves a live gateway: failed cleanup preserves guards, verified recovery retains the login, dead pid recovery still works', { skip: process.platform !== 'linux', timeout: 30_000 }, async () => {
  const dir = scratchDir('orphan');
  const engineDir = join(dir, 'engine');
  const root = join(dir, 'openclaw');
  const key = new Uint8Array(32).fill(7);
  const authSeal = hostKeySeal({ key });
  seedInstall(engineDir);
  const ready = join(root, 'ready');
  writeFileSync(join(engineDir, 'node_modules/openclaw/openclaw.mjs'), `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const state = join(process.env.OPENCLAW_STATE_DIR, 'auth.json');
const initialized = ${JSON.stringify(join(root, 'initialized'))};
process.title = 'openclaw-gateway';
if (!existsSync(initialized)) {
  writeFileSync(state, 'refreshed-login');
  writeFileSync(initialized, '1');
} else if (readFileSync(state, 'utf8') !== 'refreshed-login') process.exit(1);
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
process.on('SIGTERM', () => process.exit(0));
setInterval(() => {}, 1000);
`);
  const hostFile = join(dir, 'host.mjs');
  writeFileSync(hostFile, `
import { Engine } from ${JSON.stringify(new URL('../src/engine.ts', import.meta.url).href)};
import { hostKeySeal } from ${JSON.stringify(new URL('../../secrets/src/index.ts', import.meta.url).href)};
const engine = new Engine({ stateDir: ${JSON.stringify(dir)}, engineDir: ${JSON.stringify(engineDir)},
  authSeal: hostKeySeal({ key: new Uint8Array(32).fill(7) }), pluginId: 'byokit', tools: [], spawnEngine: true,
  onState() {}, onExit() {} });
await engine.start();
setInterval(() => {}, 1000);
`);
  await seedSet(engineDir);
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'auth.json'), 'saved-login');
  const host = spawn(process.execPath, [hostFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  let gateway = 0;
  const kit = new OpenClawKit({ stateDir: dir, engineDir, authSeal, transport: fakeGateway().factory });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(ready) && host.exitCode === null; i++) await delay(50);
    assert.ok(existsSync(ready), 'detached gateway reached its ordinary launch');
    gateway = Number(readFileSync(ready, 'utf8'));
    const before = readFileSync(join(root, 'auth-store.sealed'));
    await assert.rejects(kit.start(), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'engine-already-running');
    assert.deepEqual(readFileSync(join(root, 'auth-store.sealed')), before);
    const killed = once(host, 'exit'); host.kill('SIGKILL'); await killed;
    process.kill(gateway, 0);
    const pidFile = join(root, 'gateway.pid');
    const lockPid = join(root, 'auth-store.lock', 'pid');
    const sealed = readFileSync(join(root, 'auth-store.sealed'));
    // An ambiguous live pid must be neither signalled nor overwritten, even by connect's catch/stop.
    writeFileSync(pidFile, String(unrelated.pid));
    await assert.rejects(kit.start(), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'engine-already-running');
    assert.deepEqual(kit.state, { phase: 'failed', why: 'engine-already-running' });
    await kit.stop();
    assert.equal(readFileSync(pidFile, 'utf8'), String(unrelated.pid));
    assert.equal(readFileSync(lockPid, 'utf8'), String(host.pid));
    assert.deepEqual(readFileSync(join(root, 'auth-store.sealed')), sealed);
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'refreshed-login');
    assert.equal(unrelated.exitCode, null);
    process.kill(gateway, 0);
    // Restore the original orphan guard; a verified, dead-host gateway can stop and restart safely.
    writeFileSync(pidFile, String(gateway));
    const identityFile = join(root, 'gateway.identity');
    const identityBytes = readFileSync(identityFile);
    const identity = JSON.parse(identityBytes.toString()) as { pid: number; startTime: string };
    // A reused pid or an older gateway without a recorded launch cannot establish ownership.
    for (const ambiguous of [
      undefined,
      '{broken',
      JSON.stringify({ ...identity, pid: unrelated.pid }),
      JSON.stringify({ ...identity, startTime: String(BigInt(identity.startTime) + 1n) }),
    ]) {
      if (ambiguous === undefined) rmSync(identityFile);
      else writeFileSync(identityFile, ambiguous);
      await assert.rejects(kit.start(), (e: unknown) => e instanceof Error && 'code' in e && e.code === 'engine-already-running');
      await kit.stop();
      assert.equal(readFileSync(pidFile, 'utf8'), String(gateway));
      assert.equal(readFileSync(lockPid, 'utf8'), String(host.pid));
      assert.deepEqual(readFileSync(join(root, 'auth-store.sealed')), sealed);
      assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'refreshed-login');
      if (ambiguous === undefined) assert.equal(existsSync(identityFile), false);
      else assert.equal(readFileSync(identityFile, 'utf8'), ambiguous);
      process.kill(gateway, 0);
    }
    writeFileSync(identityFile, identityBytes);
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    const restartedPid = Number(readFileSync(pidFile, 'utf8'));
    assert.notEqual(restartedPid, gateway);
    for (let i = 0; i < 100 && Number(readFileSync(ready, 'utf8')) !== restartedPid; i++) await delay(50);
    assert.equal(Number(readFileSync(ready, 'utf8')), restartedPid, 'new gateway read the retained login before reporting ready');
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'refreshed-login');
    await kit.stop();
    assert.equal(existsSync(join(root, 'state')), false);
    assert.equal(existsSync(pidFile), false);
    assert.equal(existsSync(identityFile), false);
    // Reboot-style leftovers are recovered under the credential lock.
    mkdirSync(join(root, 'auth-store.lock'));
    writeFileSync(lockPid, String(host.pid));
    writeFileSync(pidFile, String(host.pid));
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    const recoveredPid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 100 && Number(readFileSync(ready, 'utf8')) !== recoveredPid; i++) await delay(50);
    assert.equal(Number(readFileSync(ready, 'utf8')), recoveredPid, 'dead-pid restart also read the retained login');
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'refreshed-login');
    await kit.stop();
    assert.equal(existsSync(lockPid), false);
    assert.equal(existsSync(pidFile), false);
  } finally {
    if (host.exitCode === null && host.signalCode === null) { const exited = once(host, 'exit'); host.kill('SIGKILL'); await exited; }
    if (gateway) { try { process.kill(gateway, 'SIGKILL'); } catch {} }
    const exited = once(unrelated, 'exit'); unrelated.kill(); await exited;
    await kit.stop();
    removeScratch(dir);
  }
});
