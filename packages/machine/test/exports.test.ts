// M1 acceptance: every frozen name exists — the `.` entry (D-6), `./ssh`, `./idle` and
// `./testing` — with M1's real bodies and stubs throwing `not built: <package id>` until
// their work package lands (§14 stubs rule).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as kit from '../src/index.ts';
import * as ssh from '../src/ssh.ts';
import * as idle from '../src/idle.ts';
import * as testing from '../src/testing/index.ts';
import { MachineError } from '../src/errors.ts';
import { machine } from '../src/machine.ts';
import { memoryStore } from '../src/testing/fake-provider.ts';

test('the `.` entry carries the frozen surface (D-6)', () => {
  for (const fn of [kit.machine, kit.sandboxApi, kit.claim, kit.wakeResolve, kit.estimate, kit.words, kit.stateWords, kit.hostWords, kit.keyWords, kit.errorWords]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(typeof kit.MachineError, 'function');
  assert.ok(Object.keys(kit.WORDS).length > 0);
});

test('the `./ssh` entry carries sshVm and sshHostKey', () => {
  assert.equal(typeof ssh.sshVm, 'function');
  assert.equal(typeof ssh.sshHostKey, 'function');
});

test('M2: sshVm builds the SSH VM provider shape (7)', () => {
  const p = ssh.sshVm({
    ssh: '/usr/bin/ssh', host: 'vm.test', port: 2222, user: 'app',
    keyPath: '/keys/id_ed25519', stateDir: '/tmp/byokit-state', label: 'L',
  });
  assert.equal(p.id, 'ssh-vm');
  assert.equal(p.label, 'L');
  assert.deepEqual(p.sizes(), []);
  assert.deepEqual(p.prices(), []);
  for (const missing of [p.create, p.wake, p.sleep, p.snapshot, p.fork, p.remove, p.url, p.usage, p.key]) {
    assert.equal(missing, undefined);
  }
  assert.equal(typeof p.adopt, 'function');
  const monthly = {
    size: 'vm', perMonthCap: 6, asleepPerHour: 6, currency: 'EUR' as const,
    basis: 'incl. IPv4, excl. VAT', source: 'http://sandbox.test/prices', checked: '2026-09-29',
  };
  assert.deepEqual(ssh.sshVm({
    ssh: '/usr/bin/ssh', host: 'vm.test', user: 'app',
    keyPath: '/keys/id_ed25519', stateDir: '/tmp/byokit-state', label: 'L', monthly,
  }).prices(), [monthly]);
});

test('the `./idle` entry carries idle and stopSelf', () => {
  assert.equal(typeof idle.idle, 'function');
  assert.equal(typeof idle.stopSelf, 'function');
});

test('the `./testing` entry exports the fake and the contract suite (D-13)', () => {
  assert.equal(typeof testing.fakeProvider, 'function');
  assert.equal(typeof testing.machineContract, 'function');
  assert.equal(typeof testing.memoryStore, 'function');
  assert.equal(typeof testing.fakeMachine, 'function');
  assert.equal(typeof testing.parseCommand, 'function');
});

test('public types keep their frozen shapes (4.1 with 4.3 merged in)', () => {
  const m = machine({ provider: testing.fakeProvider(), store: memoryStore() });
  assert.equal(m.ref, null);
  const err = new MachineError('needs-root', 'detail', { command: 'sudo x' });
  assert.equal(err.code, 'needs-root');
  assert.equal(err.extra.command, 'sudo x');
  void m;
});

test('package.json exports map: `.`, `./ssh`, `./idle` and `./testing` (D-6)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    exports: Record<string, unknown>;
  };
  assert.deepEqual(Object.keys(pkg.exports), ['.', './ssh', './idle', './testing']);
  const dot = pkg.exports['.'] as Record<string, unknown>;
  const idleEntry = pkg.exports['./idle'] as Record<string, unknown>;
  for (const [entry, map] of [['.', dot], ['./idle', idleEntry]] as const) {
    assert.ok(typeof map === 'object' && map !== null, entry);
    assert.ok('react-native' in (map as object) && 'browser' in (map as object), `${entry} has react-native and browser conditions`);
  }
});

test('sandboxApi() is built (M4): the sandbox API adapter behind one Provider', () => {
  const p = kit.sandboxApi({ baseUrl: 'http://sandbox.test/api/v1', label: 'L', prices: [], key: async () => '' });
  assert.equal(p.id, 'sandbox-api');
  assert.equal(p.label, 'L');
  assert.deepEqual(p.sizes(), [
    { id: 'small', cpus: 2, memoryGb: 4, diskGb: 12 },
    { id: 'default', cpus: 4, memoryGb: 8, diskGb: 50 },
  ]);
  for (const m of ['create', 'wake', 'sleep', 'snapshot', 'fork', 'remove', 'url', 'usage', 'key', 'plan', 'why'] as const) {
    assert.equal(typeof p[m], 'function', m);
  }
  assert.equal(p.adopt, undefined);
  assert.equal(p.selfId, undefined);
});

test('stubs throw not built with their package id', async () => {
  assert.throws(() => idle.idle({ linked: () => 0, held: () => false, minutes: 5, stop: async () => {} }), /not built: M7/);
  assert.throws(() => idle.stopSelf({ baseUrl: 'http://sandbox.test/api/v1', id: 'x', key: async () => '' }), /not built: M7/);
  assert.throws(() => kit.claim({ baseUrl: 'http://sandbox.test/api/v1' }), /not built: M8/);
  assert.throws(() => kit.wakeResolve({ provider: testing.fakeProvider(), ref: { provider: 'sandbox-api', account: 'a', id: 'i', name: 'n', keepCopies: true }, port: 443 }), /not built: M7/);
  const m = machine({ provider: testing.fakeProvider(), store: memoryStore() });
  await m.create({ name: 'web', size: 'small', keepCopies: true });
  const recipe = {
    name: 'web',
    node: { version: '24.15.0', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'a'.repeat(64) } },
    install: [['npm', 'ci']],
    run: { argv: ['node', 'server.mjs'], env: {} },
    workDir: '/home/user/app',
  };
  await assert.rejects(m.install(recipe), /not built: M3/);
  await assert.rejects(m.update(recipe), /not built: M3/);
  await assert.rejects(m.host(), /not built: M3/);
  await assert.rejects(m.logs(10), /not built: M3/);
  await assert.rejects(m.deliver(recipe, 'a.txt', new Uint8Array([1])), /not built: M3/);
});

test('words: the frozen table answers in plain sentences (12)', () => {
  assert.equal(kit.words('state.on', {}), 'Your cloud computer is on.');
  assert.equal(kit.stateWords('asleep', { app: 'App', label: 'L' }), 'Your cloud computer is asleep. Opening App wakes it.');
  assert.equal(kit.hostWords('running', { app: 'App' }), 'App is running on your cloud computer.');
});
