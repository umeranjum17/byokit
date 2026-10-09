import { beforeEach, test } from 'node:test';
import { strict as assert } from 'node:assert';
import fs, { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, lstatSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeScratch, scratchDir } from '../../test-support.ts';
import childProcess, { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Engine } from '../src/engine.ts';
import { pidAlive } from '../src/engine-status.ts';
import { AuthStoreSealSizeError, SEAL_CAP_BYTES, cached } from '../src/auth-store.ts';
import { stateWords } from '../src/words.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { hostKeySeal } from '../../secrets/src/index.ts';
import { once } from 'node:events';
import { EnginePatchError, editText, patchId, prepareEngineSet, readPatchSet, sha256, verifyEngineSet, type PatchSet } from '../src/engine-patches.ts';
import { stockBytes, useSyntheticStock } from './stock-fixture.ts';

beforeEach(t => {
  assert.ok('mock' in t);
  useSyntheticStock(t);
});

// Unit-only byte fixtures, not real-engine qualification; the prepare bundle uses minimal stock input.
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

// Claude wire names for the Tooling list (ch-cli-tool-prefix): the printed Tooling names on the
// Claude route must equal the Claude wire catalog names (mcp__openclaw__-prefixed); every other
// route stays byte-identical and already-prefixed names are never prefixed again.
test('claude route prints wire names in Tooling; other routes keep the stock prompt', async () => {
  const file = shippedSet().files.find((f) => f.path === 'dist/prepare.runtime-y2eXKhY3.js');
  assert.ok(file, 'patches.json carries the Claude Tooling-names entry');
  const stock = stockBytes(file).toString();
  assert.equal(sha256(stock), file.before, 'stock byte fixture drift');
  assert.equal(sha256(editText(stock, file)), file.after, 'patched bytes drift');
  const edit = file.edits[0]!;
  assert.equal(file.edits.length, 1);
  const inserted = edit.replace.slice(edit.find.length);
  const render = new Function('systemPrompt', 'skipsTurnPreparation', 'isClaudeCli', 'promptTools',
    `${inserted}\nreturn systemPrompt;`) as (prompt: string, skip: boolean, claude: boolean, tools: { name: string }[]) => string;
  const prompt = [
    'You are a personal assistant running inside OpenClaw.',
    '',
    '## Tooling',
    'Tools policy-filtered. Names case-sensitive; call exact.',
    '- web_search: Web search',
    '- web_fetch: Fetch/extract URL',
    '- sessions_history: Read visible session/subagent history',
    '- view_image',
    '- crew_read',
    '- crew_recruit',
    '- mcp__openclaw__shell',
    'The AGENTS.md Tools section guides usage; it never grants availability.',
    '',
    '## Skills you follow',
    '- recruit: use crew_recruit to hire (a bare mention outside the Tooling list)',
    '',
    '## Other',
    '- crew_read',
    '',
  ].join('\n');
  const tools = ['web_search', 'web_fetch', 'sessions_history', 'view_image', 'crew_read', 'crew_recruit']
    .map((name) => ({ name }));
  // The Claude wire catalog for this run: every OpenClaw tool prefixed, natively named tools untouched.
  const wire = new Set([...tools.map((t) => `mcp__openclaw__${t.name}`), 'mcp__openclaw__shell']);
  const claude = render(prompt, false, true, [...tools, { name: 'mcp__openclaw__shell' }]);
  const listed = claude.split('\n').filter((line) => line.startsWith('- mcp__openclaw__'));
  assert.equal(listed.length, wire.size, 'rendered Tooling list equals the wire catalog names');
  for (const name of wire) assert.ok(listed.some((line) => line === `- ${name}` || line.startsWith(`- ${name}:`)), `wire name printed: ${name}`);
  const toolingSection = claude.split('## Tooling')[1]!.split('## ')[0]!;
  assert.ok(!toolingSection.split('\n').some((line) => /^- (web_search|crew_read|crew_recruit)(:|$)/.test(line)), 'no bare OpenClaw name left in Tooling');
  assert.ok(!claude.includes('mcp__openclaw__mcp__openclaw__'), 'never double-prefixed');
  assert.ok(claude.includes('- mcp__openclaw__web_search: Web search'), 'summaries preserved');
  assert.deepEqual(claude.split('\n').filter((l) => l.startsWith('- mcp__openclaw__')).map((l) => l.split(':')[0]),
    ['- mcp__openclaw__web_search', '- mcp__openclaw__web_fetch', '- mcp__openclaw__sessions_history',
      '- mcp__openclaw__view_image', '- mcp__openclaw__crew_read', '- mcp__openclaw__crew_recruit', '- mcp__openclaw__shell'],
    'ordering preserved');
  assert.ok(claude.includes('- recruit: use crew_recruit to hire'), 'non-Tooling prose untouched');
  assert.ok(claude.split('## Other')[1]!.includes('- crew_read'), 'other sections untouched');
  assert.equal(render(prompt, false, false, tools), prompt, 'other routes byte-identical');
  assert.equal(render(prompt, true, true, tools), prompt, 'control/side-question runs untouched');
  assert.equal(render(prompt, false, true, []), prompt, 'no tools, no rewrite');
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
    const bytes = stockBytes(file);
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
  const npmScript = (build: { commit: string; driftPath?: string }) => `#!${process.execPath}
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('11.9.9-fixture'); process.exit(0); }
const dir = args.at(-1);
if (JSON.stringify(args.slice(0, -1)) !== JSON.stringify(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix'])) process.exit(1);
if (existsSync(join(dir, 'node_modules/stale-marker'))) process.exit(2);
const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (!path) continue;
  mkdirSync(join(dir, path), { recursive: true });
  writeFileSync(join(dir, path, 'package.json'), JSON.stringify({ version: ${JSON.stringify(build.driftPath ?? '')} === path ? '0.0.0-forced-drift' : pkg.version }));
}
writeFileSync(join(dir, 'node_modules/openclaw/openclaw.mjs'), '');
mkdirSync(join(dir, 'node_modules/openclaw/dist'), { recursive: true });
writeFileSync(join(dir, 'node_modules/openclaw/dist/build-info.json'), JSON.stringify({ version: '2026.8.1', commit: ${JSON.stringify(build.commit)} }));
console.error('npm warn fixture install noise');
appendFileSync(${JSON.stringify(calls)}, '1');
`;
  writeFileSync(npmPath, npmScript({ commit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b' }), { mode: 0o700 });
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
    writeFileSync(npmPath, npmScript({ commit: '0'.repeat(40) }), { mode: 0o700 });
    await assert.rejects(kit.prepare(), (e: unknown) => e instanceof EnginePatchError && e.cause === 'drift-after-build');
    assert.equal(kit.state.why, 'engine-patch'); assert.equal(kit.state.patchSet, null);
    assert.equal(readFileSync(calls, 'utf8'), '1', 'invalid stock cache invokes npm exactly once');
    // A non-comparator drift still retains the npm facts with no first-failed check.
    const diagnosticsPath = join(dir, 'other-state', 'logs', 'engine-install-drift.json');
    const metadataRecord = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as { firstFailedCheck: unknown; npm: { path: string } };
    assert.equal(metadataRecord.firstFailedCheck, null);
    assert.equal(metadataRecord.npm.path, npmPath);
    // Forced drift: one fixture package installs the wrong version, so the fresh temp fails the comparator.
    // The diagnosis is retained before the failed temp is deleted, naming the first failed package,
    // expected vs actual version, the npm path and version, and the capped npm stderr tail.
    const driftPackage = 'node_modules/@agentclientprotocol/sdk';
    writeFileSync(npmPath, npmScript({ commit: 'ea806575e6450e4d1efdfc72c19f04be982a1b9b', driftPath: driftPackage }), { mode: 0o700 });
    await assert.rejects(kit.prepare(), (e: unknown) => e instanceof EnginePatchError && e.cause === 'drift-after-build');
    const record = JSON.parse(readFileSync(diagnosticsPath, 'utf8')) as {
      at: string; failedDir: string; firstFailedCheck: { check: string; path: string; expected: string; actual: string; readError: string | null };
      npm: { path: string; version: string | null }; npmStderrTail: string;
    };
    assert.deepEqual(Object.keys(record), ['at', 'failedDir', 'firstFailedCheck', 'npm', 'npmStderrTail'], 'no environment values in the record');
    assert.ok(!existsSync(record.failedDir), 'the failed temp is deleted; the diagnosis outlives it');
    assert.equal(record.firstFailedCheck.check, 'package-version');
    assert.equal(record.firstFailedCheck.path, driftPackage);
    assert.equal(record.firstFailedCheck.expected, lock.packages[driftPackage]!.version);
    assert.equal(record.firstFailedCheck.actual, '0.0.0-forced-drift');
    assert.equal(record.firstFailedCheck.readError, null);
    assert.deepEqual(record.npm, { path: npmPath, version: '11.9.9-fixture' });
    assert.ok(record.npmStderrTail.includes('npm warn fixture install noise'));
    assert.ok(fs.statSync(diagnosticsPath).size <= 8192, 'diagnostics are size-capped');
    assert.equal(readFileSync(calls, 'utf8'), '11', 'each forced failure invoked npm exactly once');
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

// pidAlive portability: macOS has no /proc, so a dead-but-unreaped guard must read stale
// via ps there exactly as it does via /proc on Linux — while a live pid is never stolen.
test('pidAlive is portable: macOS zombies read stale, live pids are never stolen', async (t) => {
  await t.test('invalid guard reads alive on every platform branch', () => {
    for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(pidAlive(bad, 'darwin'), true, `guard ${String(bad)} is ambiguous, never stale (macOS probe)`);
      assert.equal(pidAlive(bad, 'linux'), true, `guard ${String(bad)} is ambiguous, never stale (Linux probe)`);
    }
    assert.equal(pidAlive(0), true, 'invalid guard stays alive on the host probe');
  });

  const live = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const livePid = live.pid;
  assert.ok(livePid);
  try {
    await t.test('a live pid reads alive, including through the macOS probe', () => {
      assert.equal(pidAlive(livePid), true, 'live pid stays alive (host probe)');
      assert.equal(pidAlive(livePid, 'linux'), true, 'live pid stays alive (Linux /proc probe)');
      assert.equal(pidAlive(livePid, 'darwin'), true, 'live pid stays alive (macOS probe runs real ps here)');
    });

    await t.test('a zombie reads stale through the macOS probe', (st) => {
      st.mock.method(childProcess, 'spawnSync', (() => ({ stdout: 'Z+\n' })) as any);
      syncBuiltinESMExports();
      try {
        assert.equal(pidAlive(livePid, 'darwin'), false, 'ps Z state is dead-but-unreaped, not a writer');
      } finally { st.mock.restoreAll(); syncBuiltinESMExports(); }
    });

    await t.test('the macOS probe never reads /proc and tolerates ps trouble', (st) => {
      const originalRead = fs.readFileSync;
      const procReads: string[] = [];
      const tripwire = (...args: any[]): any => {
        if (typeof args[0] === 'string' && args[0].startsWith('/proc/')) {
          procReads.push(args[0]);
          throw new Error('no /proc on this platform');
        }
        return (originalRead as (...call: any[]) => any)(...args);
      };
      st.mock.method(fs, 'readFileSync', tripwire as typeof fs.readFileSync);
      syncBuiltinESMExports();
      try {
        assert.equal(pidAlive(livePid, 'darwin'), true, 'live pid stays alive with no /proc read');
        assert.deepEqual(procReads, [], 'the macOS probe never touches /proc');
        for (const [name, stdout] of [['empty', ''], ['garbage', '???\n']] as const) {
          st.mock.method(childProcess, 'spawnSync', (() => ({ stdout })) as any);
          syncBuiltinESMExports();
          try {
            assert.equal(pidAlive(livePid, 'darwin'), true, `${name} ps output keeps the guard`);
          } finally { st.mock.restoreAll(); syncBuiltinESMExports(); }
          st.mock.method(fs, 'readFileSync', tripwire as typeof fs.readFileSync);
          syncBuiltinESMExports();
        }
        st.mock.method(childProcess, 'spawnSync', (() => { throw new Error('ps missing'); }) as any);
        syncBuiltinESMExports();
        try {
          assert.equal(pidAlive(livePid, 'darwin'), true, 'ps failure keeps the guard');
        } finally { st.mock.restoreAll(); syncBuiltinESMExports(); }
      } finally { st.mock.restoreAll(); syncBuiltinESMExports(); }
    });

    await t.test('a dead pid reads stale on the host', async () => {
      const dead = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
      assert.ok(dead.pid);
      await once(dead, 'exit');
      for (let i = 0; i < 50 && pidAlive(dead.pid); i++) await delay(20);
      assert.equal(pidAlive(dead.pid), false, 'reaped dead pid releases the guard');
    });
  } finally {
    const exited = once(live, 'exit'); live.kill('SIGKILL'); await exited;
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
// It enforces the runtime keyring secret limit the old whole-home sealing exceeded, so any journey
// using it fails the moment a payload the sealer must swallow grows past what a signed-in home allows.
const SEAL_LIMIT = 1024 * 1024;
function fakeSeal() {
  const values = new Map<string, string>();
  let n = 0;
  const seal = {
    largest: 0,
    encryptString(text: string) {
      if (text.length > SEAL_LIMIT) throw new Error('keystore secret is larger than 1 MiB');
      seal.largest = Math.max(seal.largest, text.length);
      const id = `opaque-${++n}`;
      values.set(id, text);
      return new TextEncoder().encode(id);
    },
    decryptString(bytes: Buffer) {
      const value = values.get(new TextDecoder().decode(bytes));
      // Real adapters report a wrong key or damaged bytes as KeystoreError('auth-failed').
      if (value === undefined) throw Object.assign(new Error('authentication failed'), { name: 'KeystoreError', code: 'auth-failed' });
      return value;
    },
  };
  return seal;
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
  // A real signed-in home carries tool caches far past the seal limit; they must never reach the sealer.
  const caches: [string, string][] = [
    ['home/.cache/tool/bin-store.bin', 'x'.repeat(1100 * 1024)],
    ['home/.npm/_cacache/index-v5', 'npm-index'],
    ['home/.codex/sessions/rollout-2026-01-01.jsonl', 'codex-transcript'],
    ['home/.codex/history.jsonl', 'codex-history'],
    ['home/.claude/projects/-ws/session-1.jsonl', 'claude-transcript'],
    ['home/.claude/shell-snapshots/bash-snapshot.sh', 'claude-snapshot'],
  ];
  for (const [name, content] of caches) { mkdirSync(dirname(join(engine.root, name)), { recursive: true }); writeFileSync(join(engine.root, name), content); }
  await engine.prepare();
  assert.equal(existsSync(join(engine.root, 'state')), false);
  for (const [name] of caches) assert.equal(existsSync(join(engine.root, name)), true, `cache left alone: ${name}`);
  assert.equal(existsSync(join(engine.root, 'home', '.codex', 'auth.json')), false, 'the credential is sealed, not left at rest');
  assert.ok(seal.largest < SEAL_LIMIT, `sealer payload ${seal.largest} stays under the runtime limit`);
  const sealed = join(engine.root, 'auth-store.sealed');
  assert.equal(readFileSync(sealed).includes(secret), false);
  const snap = JSON.parse(seal.decryptString(readFileSync(sealed))) as { v: number; files: [string, string][] };
  assert.equal(snap.v, 1, 'released readers through 0.6.1 open only v: 1; any other tag locks a rolled-back host out');
  assert.equal(snap.files.some(([name]) => name.startsWith('home/.cache') || name.startsWith('home/.npm') || name.includes('/sessions/') || name.includes('/projects/')), false, 'caches never enter the sealed payload');
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
  assert.equal(existsSync(join(agent)), false);
  for (const [name] of caches) assert.equal(existsSync(join(engine.root, name)), true, `cache survives every stop: ${name}`);
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
  // A sealed snapshot from the old whole-home format still restores fully, then re-seals once without its caches.
  const events: string[] = [];
  writeFileSync(sealed, seal.encryptString(JSON.stringify({ v: 1,
    dirs: ['home', 'home/.codex', 'home/.cache', 'home/.cache/tool'],
    files: [['home/.codex/auth.json', Buffer.from('legacy-login').toString('base64')],
            ['home/.cache/tool/legacy.bin', Buffer.from('legacy-cache').toString('base64')]] })));
  const upgraded = new Engine({ ...o, log: (line) => events.push(line) });
  await upgraded.start();
  assert.equal(readFileSync(join(engine.root, 'home', '.codex', 'auth.json'), 'utf8'), 'legacy-login');
  assert.equal(readFileSync(join(engine.root, 'home', '.cache', 'tool', 'legacy.bin'), 'utf8'), 'legacy-cache', 'an old-format snapshot restores completely');
  await upgraded.stop();
  assert.equal(events.includes('sealed credential store re-sealed: tool caches no longer sealed'), true, `upgrade logged once: ${events.join('; ')}`);
  const resealed = JSON.parse(seal.decryptString(readFileSync(sealed))) as { v: number; files: [string, string][] };
  assert.equal(resealed.v, 1);
  assert.equal(resealed.files.some(([name]) => name.startsWith('home/.cache')), false, 'the cache left the sealed payload');
  assert.equal(readFileSync(join(engine.root, 'home', '.cache', 'tool', 'legacy.bin'), 'utf8'), 'legacy-cache', 'nothing is dropped: the cache stays on disk unsealed');
  assert.equal(existsSync(join(engine.root, 'home', '.codex', 'auth.json')), false, 'the credential is re-sealed');
  // 0.6.2 wrote v: 2; it still restores and re-seals as v: 1.
  writeFileSync(sealed, seal.encryptString(JSON.stringify({ v: 2, dirs: ['home', 'home/.codex'], files: [['home/.codex/auth.json', Buffer.from('v2-login').toString('base64')]] })));
  const fromV2 = new Engine(o);
  await fromV2.start();
  assert.equal(readFileSync(join(engine.root, 'home', '.codex', 'auth.json'), 'utf8'), 'v2-login');
  await fromV2.stop();
  assert.equal((JSON.parse(seal.decryptString(readFileSync(sealed))) as { v: number }).v, 1);
  // Unreadable or structurally invalid snapshots fail closed in place, never restoring or overwriting.
  const asides = () => fs.readdirSync(engine.root).filter((name) => name.startsWith('auth-store.sealed.unreadable-'));
  const unreadable = [Buffer.from('tampered'), Buffer.from(seal.encryptString(JSON.stringify({ v: 1, dirs: ['state'], files: [['state/../escape', 'dG9rZW4=']] })))];
  for (const bytes of unreadable) {
    for (const name of asides()) rmSync(join(engine.root, name));
    writeFileSync(sealed, bytes);
    const lines: string[] = [];
    const fresh = new Engine({ ...o, log: (line) => lines.push(line) });
    await assert.rejects(fresh.start(), { code: 'auth-store-unreadable' });
    assert.equal(existsSync(agent), false, 'nothing from an unreadable store is restored');
    assert.equal(existsSync(join(engine.root, 'escape')), false);
    assert.equal(asides().length, 0);
    assert.deepEqual(readFileSync(sealed), bytes, 'the unreadable store is kept unchanged');
    assert.equal(lines.some(line => line.includes('sign in again')), false);
    await fresh.stop();
    assert.deepEqual(readFileSync(sealed), bytes, 'failed-start stop never overwrites it');
    assert.ok(existsSync(sealed));
  }

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
  const resealed = JSON.parse(seal.decryptString(readFileSync(join(engine.root, 'auth-store.sealed'))));
  assert.deepEqual(resealed.files.find(([name]: [string]) => name === 'state/auth.json'), ['state/auth.json', Buffer.from('still-recoverable').toString('base64')], 'a second stop seals what the failed stop left');
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
import { mock } from 'node:test';
import { useSyntheticStock } from ${JSON.stringify(new URL('./stock-fixture.ts', import.meta.url).href)};
useSyntheticStock({ mock });
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
  let hostError = '';
  host.stderr.on('data', chunk => { hostError += chunk; });
  let gateway = 0;
  const kit = new OpenClawKit({ stateDir: dir, engineDir, authSeal, transport: fakeGateway().factory });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 100 && !existsSync(ready) && host.exitCode === null; i++) await delay(50);
    assert.ok(existsSync(ready), `detached gateway reached its ordinary launch: ${hostError}`);
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

// Path, mode, size and content hash of every entry the seal could read or change: the live trees and the sealed store.
function treeListing(root: string): string[] {
  const out: string[] = [];
  const walk = (path: string) => {
    const stat = lstatSync(path);
    const name = relative(root, path);
    const mode = (stat.mode & 0o777).toString(8);
    if (stat.isDirectory()) {
      out.push(`${name}/ ${mode}`);
      for (const child of fs.readdirSync(path).sort()) walk(join(path, child));
    } else out.push(`${name} ${mode} ${stat.size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}`);
  };
  for (const top of ['state', 'home', 'auth-store.sealed']) if (existsSync(join(root, top))) walk(join(root, top));
  return out;
}

// Every entry in `before` still exists in `after`: a refusal deletes no live file (modes may still be tightened).
function kept(before: string[], after: string[]): boolean {
  const names = new Set(after.map((line) => line.split(' ')[0]));
  return before.every((line) => names.has(line.split(' ')[0]));
}

// The auth-store seal bound (Crewhouse kit gap, 2026-10-04): a large engine home must never abort the
// process at seal time. Tool caches stay off the sealer — however large — across a host kill without
// stop(), the sealed payload holds only credential files, and a store over SEAL_CAP_BYTES refuses with
// AuthStoreSealSizeError (naming size and cap) keeping the last good store as it was and deleting no live file.
test('a large cache home never reaches the sealer across a host kill, and an over-cap store refuses start and stop with a typed error', { skip: process.platform !== 'linux', timeout: 120_000 }, async () => {
  const dir = scratchDir('seal-bound');
  const engineDir = join(dir, 'engine');
  const root = join(dir, 'openclaw');
  const key = new Uint8Array(32).fill(9);
  const baseSeal = hostKeySeal({ key });
  const sealed: string[] = [];
  const spySeal = {
    encryptString: (text: string) => { sealed.push(text); return baseSeal.encryptString(text); },
    decryptString: (data: Buffer) => baseSeal.decryptString(data),
  };
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
import { mock } from 'node:test';
import { useSyntheticStock } from ${JSON.stringify(new URL('./stock-fixture.ts', import.meta.url).href)};
useSyntheticStock({ mock });
const engine = new Engine({ stateDir: ${JSON.stringify(dir)}, engineDir: ${JSON.stringify(engineDir)},
  authSeal: hostKeySeal({ key: new Uint8Array(32).fill(9) }), pluginId: 'byokit', tools: [], spawnEngine: true,
  onState() {}, onExit() {} });
await engine.start();
setInterval(() => {}, 1000);
`);
  await seedSet(engineDir);
  // Credential state: a sign-in plus a >1 MiB ledger whose base64 crosses the sealer's chunk boundary.
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'auth.json'), 'saved-login');
  const ledger = randomBytes(1536 * 1024);
  writeFileSync(join(root, 'state', 'ledger.sqlite'), ledger);
  mkdirSync(join(root, 'home', '.claude'), { recursive: true });
  writeFileSync(join(root, 'home', '.claude', 'settings.json'), '{"model":"opus"}');
  // Sparse regenerable caches, >300 MB on disk: XDG cache, npm cache and CLI transcript trees.
  const caches: [string, number][] = [
    ['home/.cache/pnpm/store/v10/blob-0.bin', 150 * 1024 * 1024],
    ['home/.cache/pnpm/store/v10/blob-1.bin', 150 * 1024 * 1024],
    ['home/.cache/pnpm/store/v10/blob-2.bin', 150 * 1024 * 1024],
    ['home/.npm/_cacache/index-v5/entry', 120 * 1024 * 1024],
    ['home/.codex/sessions/2026/10/04/transcript.jsonl', 60 * 1024 * 1024],
    ['home/.claude/projects/-home-user/secrets.jsonl', 60 * 1024 * 1024],
  ];
  let cacheBytes = 0;
  for (const [name, size] of caches) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    const fd = fs.openSync(path, 'w');
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);
    cacheBytes += size;
  }
  const kit = new OpenClawKit({ stateDir: dir, engineDir, authSeal: spySeal, transport: fakeGateway().factory });
  let gateway = 0;
  const cacheSealed = (path: string) => cached(path)
    || path.split('/').slice(0, -1).some((_, i) => cached(path.split('/').slice(0, i + 1).join('/')));
  try {
    const host = spawn(process.execPath, [hostFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let hostError = '';
    host.stderr.on('data', chunk => { hostError += chunk; });
    for (let i = 0; i < 100 && !existsSync(ready) && host.exitCode === null; i++) await delay(50);
    assert.ok(existsSync(ready), `detached gateway reached its ordinary launch: ${hostError}`);
    gateway = Number(readFileSync(ready, 'utf8'));
    // The host is killed without stop(): live plaintext trees and the stale lock are all that remain.
    const exited = once(host, 'exit');
    host.kill('SIGKILL');
    await exited;
    assert.equal(pidAlive(gateway), true, 'the detached fake gateway survived its host');
    sealed.length = 0;
    await kit.start();
    assert.equal(kit.state.phase, 'ready', 'recovery reseals the killed home and restarts');
    assert.ok(sealed.length > 0, 'the reseal after the host kill reached the sealer');
    let credentialBytes = 0;
    for (const text of sealed) {
      const snap = JSON.parse(text) as { files: [string, string][] };
      for (const [path, data] of snap.files) {
        assert.equal(cacheSealed(path), false, `a regenerable cache reached the sealer: ${path}`);
        credentialBytes += Buffer.from(data, 'base64').length;
      }
    }
    assert.ok(credentialBytes < 4 * 1024 * 1024, `only credential files were sealed (${credentialBytes} bytes)`);
    const payloadChars = Math.max(...sealed.map(text => text.length));
    console.log(`[seal-bound] killed home carried ${cacheBytes} bytes (${(cacheBytes / 2 ** 20).toFixed(0)} MiB) of regenerable caches; ` +
      `recovery sealed ${credentialBytes} credential bytes into a ${payloadChars}-character snapshot`);
    for (const [name] of caches) assert.equal(existsSync(join(root, name)), true, `cache left at rest: ${name}`);
    await kit.stop();
    // Restore proves the single-pass envelope round-trips: the >1 MiB ledger is byte-identical, and
    // its base64 crossed the sealer's chunk boundary on the way in.
    await kit.start();
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'refreshed-login');
    assert.ok(readFileSync(join(root, 'state', 'ledger.sqlite')).equals(ledger), 'large credential file restored byte-identical');
    assert.equal(readFileSync(join(root, 'home', '.claude', 'settings.json'), 'utf8'), '{"model":"opus"}');
    await kit.stop();
    // A credential file over the cap refuses with a typed error before it is read; the process continues.
    const storeFile = join(root, 'auth-store.sealed');
    const before = readFileSync(storeFile);
    mkdirSync(join(root, 'state'), { recursive: true });
    const huge = join(root, 'state', 'huge.sqlite');
    const fd = fs.openSync(huge, 'w');
    fs.ftruncateSync(fd, SEAL_CAP_BYTES + 1024 * 1024);
    fs.closeSync(fd);
    sealed.length = 0;
    const startRefusedAt = treeListing(root);
    await assert.rejects(kit.start(), (e: unknown): e is AuthStoreSealSizeError =>
      e instanceof AuthStoreSealSizeError && e.size > e.cap && e.cap === SEAL_CAP_BYTES
      && e.message.includes('too large to keep safely') && e.message.includes(`the limit is ${e.cap / 2 ** 20} MB`));
    assert.equal(sealed.length, 0, 'an over-cap store never reaches the sealer');
    assert.equal(kit.state.phase, 'failed');
    assert.equal(kit.state.why, 'auth-store-seal-size');
    assert.match(stateWords(kit.state), /too large to keep safely/);
    assert.deepEqual(readFileSync(storeFile), before, 'the refused store is unchanged');
    assert.equal(existsSync(huge), true, 'the over-cap live file is unchanged');
    assert.equal(pidAlive(gateway), false, 'no gateway survived the refused start');
    assert.ok(kept(startRefusedAt, treeListing(root)), 'the refused start deletes no live file');
    await assert.rejects(kit.prepare(), (e: unknown) => e instanceof AuthStoreSealSizeError);
    assert.equal(kit.state.phase, 'failed');
    assert.equal(kit.state.why, 'auth-store-seal-size', 'a refused prepare reports the seal-size state');
    console.log(`[seal-bound] over-cap store (${SEAL_CAP_BYTES + 1024 * 1024} bytes) refused with AuthStoreSealSizeError; process continued`);
    rmSync(huge);
    await kit.start();
    assert.equal(kit.state.phase, 'ready', 'a start after the refused start works');
    const stopFd = fs.openSync(huge, 'w');
    fs.ftruncateSync(stopFd, SEAL_CAP_BYTES + 1024 * 1024);
    fs.closeSync(stopFd);
    const beforeStop = readFileSync(storeFile);
    const stopRefusedAt = treeListing(root);
    sealed.length = 0;
    await assert.rejects(kit.stop(), (e: unknown) => e instanceof AuthStoreSealSizeError);
    assert.equal(sealed.length, 0, 'an over-cap stop never reaches the sealer');
    assert.deepEqual(readFileSync(storeFile), beforeStop, 'the refused stop leaves the sealed store unchanged');
    assert.equal(existsSync(huge), true, 'the over-cap live file survives the refused stop');
    assert.ok(kept(stopRefusedAt, treeListing(root)), 'the refused stop deletes no live file');
    assert.equal(existsSync(join(root, 'auth-store.lock')), false, 'the refused stop releases the store lock');
    rmSync(huge);
    await kit.start();
    assert.equal(kit.state.phase, 'ready', 'a start after the refused stop works');
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'refreshed-login');
    await kit.stop();
    const seen: string[] = [];
    const exits: (number | null)[] = [];
    const engine = new Engine({ stateDir: dir, engineDir, authSeal: spySeal, pluginId: 'byokit', tools: [], spawnEngine: true,
      onState(s) { seen.push(s.why ?? s.phase); }, onExit(code) { exits.push(code); } });
    await engine.start();
    const enginePid = Number(readFileSync(join(root, 'gateway.pid'), 'utf8'));
    assert.equal(pidAlive(enginePid), true, 'the engine child is running before the crash');
    const exitFd = fs.openSync(huge, 'w');
    fs.ftruncateSync(exitFd, SEAL_CAP_BYTES + 1024 * 1024);
    fs.closeSync(exitFd);
    const crashedAt = treeListing(root);
    const crashedStore = readFileSync(storeFile);
    process.kill(enginePid, 'SIGKILL');
    for (let i = 0; i < 200 && !seen.includes('auth-store-seal-size'); i++) await delay(50);
    assert.equal(seen.at(-1), 'auth-store-seal-size', 'a refused exit seal reports the seal-size state');
    assert.deepEqual(exits, [null], 'onExit still runs after a refused exit seal');
    assert.equal(pidAlive(enginePid), false, 'the crashed engine child is gone');
    assert.deepEqual(readFileSync(storeFile), crashedStore, 'the refused exit keeps the last good store as it was');
    assert.ok(kept(crashedAt, treeListing(root)), 'the refused exit deletes no live file');
    assert.equal(existsSync(join(root, 'auth-store.lock')), false, 'the refused exit releases the store lock');
    rmSync(huge);
    await engine.stop();
    await kit.start();
    assert.equal(kit.state.phase, 'ready', 'a start after the refused exit works');
    await kit.stop();
  } finally {
    if (gateway && pidAlive(gateway)) { try { process.kill(gateway, 'SIGKILL'); } catch {} }
    await kit.stop();
    removeScratch(dir);
  }
});
