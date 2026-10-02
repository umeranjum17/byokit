// Executed OUTSIDE the workspace, from a packed kit with registry-only dependencies.
// The production manifest is empty. Later comment-only entries are explicitly lab artifacts, not features.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, readlinkSync, lstatSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { once } from 'node:events';
import { OpenClawKit, ENGINE_VERSION } from '@byokit/openclaw';
import { startModelStub, useModelStub } from '@byokit/openclaw/testing';
import { editText, engineSetName, patchId, processStartTime, sha256 } from './node_modules/@byokit/openclaw/dist/engine-patches.js';
import { gatewayTransport } from './node_modules/@byokit/openclaw/dist/transport.js';
const cwd = process.cwd();
const base = join(cwd, 'e');
const artifact = join(cwd, 'node_modules/@byokit/openclaw/engine');
const specPath = join(artifact, 'patches.json');
const stockSpec = JSON.parse(readFileSync(specPath, 'utf8'));
const emptySpec = { ...stockSpec, id: patchId([]), files: [] };
const started = performance.now(), clientEvents = [], clientProbes = [];
const observe = name => ({
  onState: state => clientEvents.push({ name, atMs: Math.round(performance.now() - started), phase: state.phase, why: state.why }),
  transport: ctx => {
    const transport = gatewayTransport(ctx);
    transport.onClose(why => clientEvents.push({ name, atMs: Math.round(performance.now() - started), close: why }));
    return transport;
  },
});
const kit = new OpenClawKit({ stateDir: join(cwd, 's'), engineDir: base, tools: [], ...observe('s') });
const a = new OpenClawKit({ stateDir: join(cwd, 'a'), engineDir: base, npmPath: join(cwd, 'no-registry-installer'), tools: [], ...observe('a') });
const b = new OpenClawKit({ stateDir: join(cwd, 'b'), engineDir: base, npmPath: join(cwd, 'no-registry-installer'), tools: [], ...observe('b') });
const old = new OpenClawKit({ stateDir: join(cwd, 'o'), spawnEngine: false, tools: [], ...observe('o') });
const pointer = name => readFileSync(join(cwd, name, 'openclaw/engine-set'), 'utf8');
const latencies = [];
async function prepare(k, label) {
  const at = performance.now(); await k.prepare();
  const measurement = { label, ms: Math.round(performance.now() - at) };
  latencies.push(measurement); console.log(JSON.stringify({ prepare: measurement }));
}
// Each probe makes an independent real protocol connection: synchronous byte qualification must not
// confuse a client's heartbeat expiry with process exit or engine immutability.
const names = new Map([[kit, 's'], [a, 'a'], [b, 'b'], [old, 'o']]);
const attached = async (k, label) => {
  let ok = true, error;
  try { await k.call('health', {}); } catch (e) { ok = false; error = e.message; }
  const probe = { name: names.get(k), label, ok, error, phase: k.state.phase, atMs: Math.round(performance.now() - started) };
  clientProbes.push(probe); console.log(JSON.stringify({ attachedClient: probe }));
  assert.ok(ok, `original attached ${probe.name} client lost continuity: ${error}`);
};
const health = async k => {
  const root = join(cwd, names.get(k), 'openclaw');
  const peer = gatewayTransport({ port: Number(readFileSync(join(root, 'port'), 'utf8')), token: readFileSync(join(root, 'token'), 'utf8').trim(), identityPath: join(root, 'device.json'), bridgeSock: join(root, 'bridge.sock') });
  try { await peer.start(); assert.ok(await peer.request('health', {})); }
  finally { await peer.stop(); }
};
async function command(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}
const snapshot = dir => {
  const rows = [];
  const walk = (path, rel) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) { rows.push([rel, 'link', readlinkSync(path)]); return; }
    if (stat.isDirectory()) { rows.push([rel, 'dir', stat.mode & 0o777]); for (const name of readdirSync(path).sort()) walk(join(path, name), rel + '/' + name); return; }
    rows.push([rel, 'file', stat.mode & 0o777, stat.size, sha256(readFileSync(path))]);
  };
  walk(dir, ''); return sha256(JSON.stringify(rows));
};
const select = spec => writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
let stub, oldChild;
const racers = [];
const cleanup = async () => {
  for (const child of racers) if (child.exitCode === null && child.signalCode === null) {
    const exit = once(child, 'exit'); child.kill('SIGTERM');
    await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3_000))]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
  }
  if (oldChild && oldChild.exitCode === null && oldChild.signalCode === null) { const exit = once(oldChild, 'exit'); oldChild.kill('SIGTERM'); await exit; }
  await Promise.all([kit.stop(), a.stop(), b.stop(), old.stop()]);
  await stub?.close();
};
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 800_000); deadline.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
try {
  assert.match(readFileSync(join(artifact, 'OPENCLAW-LICENSE'), 'utf8'), /Permission is hereby granted/);
  await prepare(kit, 'production-cold-registry-install');
  const stock = pointer('s');
  const emptyDir = join(base + '.sets', engineSetName(emptySpec));
  if (process.argv[2]) await command(process.execPath, [process.argv[2], join(emptyDir, 'node_modules/openclaw'), '--check']);
  assert.equal(JSON.parse(readFileSync(join(stock, '.byokit-patches'), 'utf8')).id, stockSpec.id);
  assert.equal(kit.state.patchSet, stockSpec.id);
  await prepare(kit, 'production-repeat-full-tree');
  const { entry, env } = kit.doctorContext();
  const version = spawnSync(process.execPath, [entry, '--version'], { env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(version.status, 0); assert.ok(version.stdout.includes(ENGINE_VERSION));
  await kit.start(); assert.equal(kit.state.phase, 'ready');
  stub = await startModelStub(['packed S1 provider receipt']);
  await useModelStub(kit, stub); await kit.ensureMember('m1');
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:s1-pack', message: 'S1 artifact qualification' });
  assert.equal(end.ok, true); assert.match(end.text, /packed S1 provider receipt/); assert.ok(stub.calls.length > 0);
  const production = { source: 'packed kit + registry dependencies + real pinned Gateway', version: ENGINE_VERSION, patchSet: stockSpec.id, patchedFiles: stockSpec.files.length, providerRequests: stub.calls.length, text: end.text };
  console.log(JSON.stringify(production));
  // Old-way, UNMARKED stock engine: genuine npm ci, no copies masquerading as an install.
  mkdirSync(base);
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(join(artifact, file), join(base, file));
  const installed = await command('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', base], {
    env: { PATH: process.env.PATH, HOME: env.HOME, npm_config_cache: join(cwd, 's/openclaw/npm-cache') }, encoding: 'utf8', timeout: 300_000,
  });
  assert.equal(installed.status, 0, installed.stderr);
  const baseBefore = snapshot(base);
  await attached(kit, 'after-old-way-base-install');
  await old.prepare();
  const oldEnv = old.doctorContext().env;
  const fd = openSync(join(cwd, 'old-gateway.log'), 'a', 0o600);
  try { oldChild = spawn(process.execPath, [join(base, 'node_modules/openclaw/openclaw.mjs'), 'gateway', '--port', readFileSync(join(cwd, 'o/openclaw/port'), 'utf8')], { cwd: oldEnv.HOME, env: oldEnv, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  await old.start(); await health(old);
  const oldIdentity = { pid: oldChild.pid, startTime: processStartTime(oldChild.pid) };
  assert.equal(readFileSync(`/proc/${oldChild.pid}/cmdline`, 'utf8').replaceAll('\0', '').trim(), 'openclaw-gateway');
  writeFileSync(join(cwd, 'o/openclaw/gateway.pid'), String(oldChild.pid));
  writeFileSync(join(cwd, 'o/openclaw/gateway.identity'), JSON.stringify({ pid: oldChild.pid, startTime: processStartTime(oldChild.pid) }));
  const path = 'dist/main-session-recovery-state-BWIrIyi_.js';
  const before = readFileSync(join(emptyDir, 'node_modules/openclaw', path), 'utf8');
  const find = 'function isMainRestartRecoveryCandidate(entry, sessionKey) {';
  assert.equal(before.split(find).length, 2);
  const lab = label => {
    const replace = `${find}\n\t// BYOKit S1 lab ${label}: inert comment only, not a shipped semantic patch.`;
    const existing = stockSpec.files.find(file => file.path === path);
    const edits = [...existing?.edits ?? [], { find, replace }];
    const file = { path, before: sha256(before), after: sha256(editText(before, { path, edits })), edits };
    const files = [...stockSpec.files.filter(file => file.path !== path), file];
    return { ...stockSpec, id: patchId(files), files };
  };
  const setA = lab('A'), setB = lab('B');
  select(setA);
  await prepare(a, 'lab-A-offline-clone'); await a.start(); await health(a);
  const dirA = pointer('a'), aBefore = snapshot(dirA);
  let pidA = readFileSync(join(cwd, 'a/openclaw/gateway.pid'), 'utf8');
  select(setB);
  await prepare(b, 'lab-B-offline-clone'); await b.start(); await health(b);
  await attached(old, 'after-B-clone'); await attached(a, 'after-B-clone');
  await health(old); await health(a);
  assert.equal(processStartTime(oldChild.pid), oldIdentity.startTime);
  assert.equal(snapshot(base), baseBefore); assert.equal(snapshot(dirA), aBefore);
  await b.stop(); select(emptySpec);
  await prepare(b, 'rollback-stock-selection'); await b.start(); await health(b);
  const plugins = await b.call('plugins.list', {});
  const bridge = plugins.plugins.find(plugin => plugin.id === 'byokit');
  assert.ok(bridge && bridge.installed && bridge.enabled && bridge.state === 'enabled', 'bridge remains listed after set switch');
  console.log(JSON.stringify({ pluginsAfterSwitch: { id: bridge.id, installed: bridge.installed, enabled: bridge.enabled, state: bridge.state } }));
  assert.equal(pointer('b'), emptyDir); assert.equal(snapshot(base), baseBefore); assert.equal(snapshot(dirA), aBefore);
  // Real doctor --fix; state may be repaired, but its final engine tree must not change.
  const doctorContext = a.doctorContext();
  await a.stop(); // Only this exact owned Gateway: stock doctor refuses a second SQLite schema writer.
  const doctor = await command(process.execPath, [doctorContext.entry, 'doctor', '--fix', '--yes', '--non-interactive'], { cwd: doctorContext.env.HOME, env: doctorContext.env });
  assert.equal(doctor.status, 0, doctor.stderr); assert.equal(snapshot(dirA), aBefore);
  select(setA); await a.start(); await health(a);
  pidA = readFileSync(join(cwd, 'a/openclaw/gateway.pid'), 'utf8');
  await attached(old, 'after-owned-A-doctor');
  const drift = [];
  select(setA);
  // Same stateDir, separately patched-only and unpatched-only corruption, with the old Gateway live.
  for (const [kind, relative] of [['patched-only', 'node_modules/openclaw/' + path], ['unpatched-only', 'node_modules/openclaw/LICENSE']]) {
    const previous = pointer('a');
    const file = join(previous, relative);
    chmodSync(file, 0o644); writeFileSync(file, readFileSync(file, 'utf8') + '\n// S1 test-only drift\n'); chmodSync(file, 0o444);
    const damaged = snapshot(previous);
    await prepare(a, kind + '-same-state-repeat');
    assert.notEqual(pointer('a'), previous); assert.equal(snapshot(previous), damaged); await health(a); await health(old);
    await attached(old, kind); await attached(a, kind);
    drift.push({ kind, preserved: true, selectedNewSibling: true });
  }
  assert.equal(snapshot(base), baseBefore);
  // Two independent kit processes race one as-yet-absent set, each booting the winner.
  select(lab('race'));
  writeFileSync(join(cwd, 'race.mjs'), `
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '@byokit/openclaw';
const name = process.argv[2];
const kit = new OpenClawKit({ stateDir: join(process.cwd(), name), engineDir: join(process.cwd(), 'e'), npmPath: join(process.cwd(), 'no-registry-installer'), tools: [] });
process.once('SIGTERM', () => { void kit.stop().finally(() => process.exit(1)); });
process.send('ready'); await once(process, 'message');
try { await kit.prepare(); await kit.start(); await kit.call('health', {}); process.send({ dir: readFileSync(join(process.cwd(), name, 'openclaw/engine-set'), 'utf8') }); }
finally { await kit.stop(); }
`);
  const ready = [];
  for (const name of ['r1', 'r2']) {
    const child = spawn(process.execPath, ['race.mjs', name], { cwd, env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    racers.push(child); let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    ready.push(Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('race child exited: ' + stderr); })]));
  }
  await Promise.all(ready);
  const outputs = racers.map(child => once(child, 'message'));
  const exits = racers.map(child => once(child, 'exit'));
  for (const child of racers) child.send('go');
  const results = await Promise.all(outputs);
  for (const [code] of await Promise.all(exits)) assert.equal(code, 0);
  assert.equal(results[0][0].dir, results[1][0].dir);
  const raceName = results[0][0].dir.split('/').at(-1);
  assert.equal(readdirSync(base + '.sets').filter(name => name === raceName || name.startsWith(raceName + '.')).length, 1);
  assert.ok(readdirSync(base + '.sets').every(name => !name.startsWith('.tmp-')));
  await health(old); await health(a); assert.equal(snapshot(base), baseBefore);
  assert.equal(oldChild.exitCode, null); assert.equal(oldChild.signalCode, null);
  assert.equal(readFileSync(join(cwd, 'a/openclaw/gateway.pid'), 'utf8'), pidA, 'the doctor-restarted set-A Gateway remains live through drift/race');
  await attached(old, 'after-race'); await attached(a, 'after-race');
  const stockMarker = JSON.parse(readFileSync(join(emptyDir, '.byokit-patches'), 'utf8'));
  console.log(JSON.stringify({ installedStock: { path: emptyDir, version: ENGINE_VERSION, commit: emptySpec.upstream.commit, integrity: emptySpec.upstream.integrity, patchSet: emptySpec.id, treeHash: stockMarker.tree, rootMode: lstatSync(emptyDir).mode & 0o777, entryMode: lstatSync(join(emptyDir, 'node_modules/openclaw/openclaw.mjs')).mode & 0o777 }, oldIdentity, pidA, baseBefore, setABeforeDeliberateDrift: aBefore, source: 'LAB comment-only packed manifests, real unmarked + set Gateways, no process/namespace mocks', sharedBaseUnchanged: true, setAUnchangedBeforeDeliberateDrift: true, doctorImmutable: true, rollbackOffline: true, raceOneWinner: true, oldPidStartTimeStable: processStartTime(oldChild.pid) === oldIdentity.startTime, drift, latencies, clientProbes, clientEvents }));
} finally { select(stockSpec); clearTimeout(deadline); await cleanup(); }
