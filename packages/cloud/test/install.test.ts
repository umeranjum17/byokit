// M3 acceptance (docs/cloud-kit.md 14.2): install and supervise on fakeMachine() —
// step order, Node selection, root steps, `user`, the linger refusal, deliver, and
// the M8 step left as a no-op — plus the unit rewrite and probe-kind rules of 8.5.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { machine } from '../src/machine.ts';
import { fakeProvider, memoryStore } from '../src/testing/fake-provider.ts';
import { markerPath } from '../src/recipe.ts';
import { DELIVER_SHELL, PROBE_SHELL, WORKDIR_SHELL, WRITE_SHELL } from '../src/unit.ts';
import { words } from '../src/words.ts';
import type { MachineError } from '../src/errors.ts';
import type { FakeControl } from '../src/testing/fake-provider.ts';
import type { HostRecipe, Machine, Provider } from '../src/types.ts';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });

const recipe = (name: string): HostRecipe => ({
  name,
  node: { version: '24.15.0', sha256: sha('a') },
  install: [['npm', 'ci']],
  run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } },
  workDir: '/home/user/app',
});

const setup = async (name = 'web', keepCopies = true): Promise<{ f: Provider & { fake: FakeControl }; m: Machine }> => {
  const f = fakeProvider();
  const m = machine({ provider: f, store: memoryStore() });
  await m.create({ name, size: 'small', keepCopies });
  return { f, m };
};

const rejects = async (p: Promise<unknown>, code: string): Promise<MachineError> => {
  try {
    await p;
  } catch (e) {
    assert.equal((e as MachineError).code, code);
    return e as MachineError;
  }
  assert.fail(`expected rejection with ${code}`);
};

const textOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

test('a three-step recipe reaches running; onLine receives every step lines in order', async () => {
  const { f, m } = await setup();
  f.fake.machine.script('one', { code: 0, stdout: 'one\n', stderr: '', timedOut: false });
  f.fake.machine.script('two', { code: 0, stdout: 'two-a\ntwo-b\n', stderr: 'two-err\n', timedOut: false });
  f.fake.machine.script('three', { code: 0, stdout: 'three\n', stderr: '', timedOut: false });
  const lines: string[] = [];
  await m.install({ ...recipe('web'), install: [['one'], ['two'], ['three']] }, (line) => lines.push(line));
  assert.equal(await m.host(), 'running');
  assert.deepEqual(lines, ['one', 'two-a', 'two-b', 'two-err', 'three']);
});

test('host() is installing while an install is in flight', async () => {
  const { m } = await setup();
  const installing = m.install(recipe('web'));
  assert.equal(await m.host(), 'installing');
  await installing;
  assert.equal(await m.host(), 'running');
});

test('8.3 step order for a plain recipe', async () => {
  const { f, m } = await setup();
  await m.install(recipe('web'));
  const runs = f.fake.machine.runs;
  assert.equal(runs[0].argv[2], PROBE_SHELL);
  assert.deepEqual(runs[1].argv, ['/home/user/.local/share/byokit/node/24.15.0/bin/node', '--version']);
  assert.deepEqual(runs[2].argv, ['mkdir', '-p', '/home/user/app']);
  assert.deepEqual(runs[3].argv, ['mkdir', '-p', '-m', '0700', '/home/user/app/.byokit']);
  assert.equal(runs[4].argv[2], WORKDIR_SHELL);
  assert.deepEqual(runs[4].argv.slice(-2), ['npm', 'ci']);
  assert.equal(runs[5].argv[2], WRITE_SHELL);
  assert.equal(runs[5].argv[4], '/home/user/app/.byokit/installed.json');
  assert.equal(runs[6].argv[2], WRITE_SHELL);
  assert.equal(runs[6].argv[4], '/etc/systemd/system/byokit-web.service');
  assert.equal(runs[6].root, true);
  assert.deepEqual(runs[7].argv, ['systemctl', 'daemon-reload']);
  assert.deepEqual(runs[8].argv, ['systemctl', 'enable', '--now', 'byokit-web.service']);
  assert.equal(runs.length, 9);
});

test('8.3 step order with installRoot: marker, root steps, marker write', async () => {
  const { f, m } = await setup();
  f.fake.machine.script('apt-get', { code: 0, stdout: '', stderr: '', timedOut: false });
  const r = { ...recipe('web'), installRoot: [['apt-get', 'install', '-y', 'foo']] };
  await m.install(r);
  const runs = f.fake.machine.runs;
  const at = (pred: (argv: readonly string[]) => boolean): number => runs.findIndex((run) => pred(run.argv));
  const marker = markerPath('web', r);
  assert.equal(at((a) => a[2] === PROBE_SHELL), 0);
  assert.deepEqual(runs[at((a) => a[0] === 'test')].argv, ['test', '-e', marker]);
  const rootStep = at((a) => a.includes('apt-get'));
  assert.ok(rootStep > 0 && runs[rootStep].root, 'installRoot runs as root');
  const mkdirVar = at((a) => a.join(' ') === 'mkdir -p /var/lib/byokit');
  const touch = at((a) => a[0] === 'touch');
  assert.deepEqual(runs[touch].argv, ['touch', marker]);
  assert.ok(rootStep < mkdirVar && mkdirVar < touch, 'root steps run before the marker write');
  assert.ok(touch < at((a) => a[0].endsWith('/bin/node')), 'the marker is written before Node');
});

test('8.3 step order with user: homes, useradd, runuser, and User= in the unit', async () => {
  const { f, m } = await setup();
  const r: HostRecipe = { ...recipe('web'), user: 'appbot', workDir: '/home/user/.users/appbot/app' };
  await m.install(r);
  const runs = f.fake.machine.runs;
  assert.deepEqual(f.fake.machine.dirs.get('/home/user/.users'), { owner: 'root', mode: 0o711 });
  assert.ok(runs.some((run) => run.root && run.argv.join(' ') === 'chmod o+x /home/user'), 'the machine home gets o+x');
  assert.ok(f.fake.machine.users.has('appbot'));
  assert.equal(runs.filter((run) => run.argv[0] === 'useradd').length, 1, 'useradd runs once');
  const nodeCheck = runs.find((run) => run.argv.includes('--version') && run.argv.some((a) => a.endsWith('/bin/node')));
  assert.equal(nodeCheck?.asUser, 'appbot');
  const wrap = runs.find((run) => run.argv.includes(WORKDIR_SHELL));
  assert.equal(wrap?.asUser, 'appbot');
  const installed = runs.find((run) => run.argv.includes(WRITE_SHELL) && run.argv.includes('/home/user/.users/appbot/app/.byokit/installed.json'));
  assert.equal(installed?.asUser, 'appbot');
  for (const run of runs) {
    if (run.root && run.asUser === null) {
      const [head, ...rest] = run.argv;
      assert.ok(
        ['install', 'chmod', 'id', 'useradd', 'mkdir', 'touch', 'systemctl'].includes(head)
        || (head === 'sh' && rest[2] === 'sh' && String(run.argv[4]).startsWith('/etc/')),
        `no step under the run home runs as plain root, got ${JSON.stringify(run.argv)}`,
      );
    }
  }
  const unit = f.fake.machine.files.get('/etc/systemd/system/byokit-web.service');
  assert.ok(unit !== undefined && textOf(unit.bytes).includes('User=appbot'));
});

test('a machine node inside the range is used', async () => {
  const { f, m } = await setup();
  f.fake.machine.nodeVersion = 'v24.21.0';
  const r: HostRecipe = { ...recipe('web'), node: { ...recipe('web').node, range: '>=24.15.0 <25' } };
  await m.install(r);
  const unit = f.fake.machine.files.get('/etc/systemd/system/byokit-web.service');
  assert.ok(unit !== undefined && textOf(unit.bytes).includes('ExecStart="/usr/bin/node" "server.mjs"'));
});

test('a machine node outside the range or missing runs the step 4 script', async () => {
  for (const nodeVersion of ['v22.0.0', null]) {
    const { f, m } = await setup();
    f.fake.machine.nodeVersion = nodeVersion;
    await m.install(recipe('web'));
    assert.ok(
      f.fake.machine.runs.some((run) => run.argv[4] !== undefined && String(run.argv[4]).startsWith('https://nodejs.org/')),
      `the step 4 script runs when node is ${nodeVersion}`,
    );
    const unit = f.fake.machine.files.get('/etc/systemd/system/byokit-web.service');
    assert.ok(unit !== undefined && textOf(unit.bytes).includes('ExecStart="/home/user/.local/share/byokit/node/24.15.0/bin/node"'));
  }
});

test('a checksum failure rejects bad-recipe', async () => {
  const { f, m } = await setup();
  f.fake.machine.nodeVersion = null;
  f.fake.machine.nodeInstallCode = 3;
  await rejects(m.install(recipe('web')), 'bad-recipe');
});

test('root steps run as root and write the marker; a second install runs none', async () => {
  const { f, m } = await setup();
  f.fake.machine.script('echo', { code: 0, stdout: '', stderr: '', timedOut: false });
  const r = { ...recipe('web'), installRoot: [['echo', 'root-ok']] };
  await m.install(r);
  assert.ok(f.fake.machine.files.has(markerPath('web', r)), 'the marker is written');
  const count = (): number =>
    f.fake.machine.runs.filter((run) => run.argv.join(' ').includes('root-ok')).length;
  assert.equal(count(), 1);
  await m.install(r);
  assert.equal(count(), 1, 'a second install with the marker runs no root step');
  assert.equal(await m.host(), 'running');
});

test('update reruns root steps only when the marker is gone', async () => {
  const { f, m } = await setup();
  f.fake.machine.script('echo', { code: 0, stdout: '', stderr: '', timedOut: false });
  const r = { ...recipe('web'), installRoot: [['echo', 'root-ok']], update: [['echo', 'upd']] };
  await m.install(r);
  const count = (): number =>
    f.fake.machine.runs.filter((run) => run.argv.join(' ').includes('root-ok')).length;
  await m.update(r);
  assert.equal(count(), 1, 'update with the marker runs no root step');
  f.fake.machine.files.delete(markerPath('web', r));
  await m.update(r);
  assert.equal(count(), 2, 'update without the marker reruns the root steps');
});

test('a machine user of root with user set rejects bad-recipe', async () => {
  const { f, m } = await setup();
  f.fake.machine.user = 'root';
  f.fake.machine.home = '/root';
  await rejects(
    m.install({ ...recipe('web'), user: 'appbot', workDir: '/root/.users/appbot/app' }),
    'bad-recipe',
  );
});

test('the linger refusal rejects linger, and host.linger is a filled sentence', async () => {
  const f = fakeProvider({ id: 'ssh-vm' });
  f.fake.machine.lingerOk = false;
  const m = machine({ provider: f, store: memoryStore() });
  await m.create({ name: 'web', size: 'small', keepCopies: false });
  const err = await rejects(m.install(recipe('web')), 'linger');
  assert.equal(err.extra.command, 'sudo loginctl enable-linger user');
  const sentence = words('host.linger', { app: 'Demo' });
  assert.ok(sentence.includes('Demo') && !sentence.includes('{') && !sentence.includes('}'));
});

test('deliver lands owned by the run user at 0600', async () => {
  const { f, m } = await setup();
  const bytes = new TextEncoder().encode('new-phone-key');
  await m.deliver(recipe('web'), 'phone-key.txt', bytes);
  const file = f.fake.machine.files.get('/home/user/app/.byokit/inbox/phone-key.txt');
  assert.ok(file !== undefined);
  assert.equal(file.mode, 0o600);
  assert.equal(file.owner, 'user');
  assert.deepEqual(file.bytes, bytes);
  const r: HostRecipe = { ...recipe('web'), user: 'appbot', workDir: '/home/user/.users/appbot/app' };
  await m.deliver(r, 'phone-key.txt', bytes);
  const owned = f.fake.machine.files.get('/home/user/.users/appbot/app/.byokit/inbox/phone-key.txt');
  assert.ok(owned !== undefined);
  assert.equal(owned.owner, 'appbot');
  assert.equal(owned.mode, 0o600);
});

test('with inbox replaced by a symlink to a root-owned directory, nothing is written there', async () => {
  const { f, m } = await setup();
  const inbox = '/home/user/app/.byokit/inbox';
  f.fake.machine.symlink(inbox, '/root/elsewhere');
  f.fake.machine.dirs.set('/root/elsewhere', { owner: 'root', mode: 0o755 });
  await rejects(m.deliver(recipe('web'), 'note.txt', new TextEncoder().encode('hi')), 'provider');
  assert.equal(f.fake.machine.files.get('/root/elsewhere/note.txt'), undefined);
  assert.equal(f.fake.machine.files.get(`${inbox}/note.txt`), undefined);
});

test('step 7 is a no-op without selfId: no boot.mjs is written', async () => {
  const { f, m } = await setup();
  await m.install(recipe('web'));
  assert.deepEqual([...f.fake.machine.files.keys()].filter((k) => k.endsWith('boot.mjs')), []);
});

test('update rewrites the unit only when its bytes changed', async () => {
  const { f, m } = await setup();
  const r = recipe('web');
  await m.install(r);
  const writes = (): number =>
    f.fake.machine.runs.filter((run) => run.argv[2] === WRITE_SHELL && run.argv[4] === '/etc/systemd/system/byokit-web.service').length;
  const reloads = (): number =>
    f.fake.machine.runs.filter((run) => run.argv.includes('daemon-reload')).length;
  const restarts = (): number =>
    f.fake.machine.runs.filter((run) => run.argv.includes('restart')).length;
  assert.equal(writes(), 1);
  assert.equal(reloads(), 1);
  await m.update(r);
  assert.equal(writes(), 1, 'an unchanged unit is not rewritten');
  assert.equal(reloads(), 1, 'an unchanged unit needs no reload');
  assert.equal(restarts(), 1);
  assert.equal(await m.host(), 'running');
  await m.update({ ...r, run: { ...r.run, env: { PORT: '7311' } } });
  assert.equal(writes(), 2, 'a changed unit is rewritten');
  assert.equal(reloads(), 2, 'a rewritten unit is reloaded');
  assert.equal(restarts(), 2);
});

test('host, logs and sleep pick the unit kind from the test -e probe', async () => {
  const { f, m } = await setup();
  await m.install(recipe('web'));
  f.fake.machine.log('web', 'hello');
  assert.deepEqual(await m.logs(5), ['hello']);
  assert.deepEqual(await m.logs(10000), ['hello']);
  const journal = [...f.fake.calls].reverse().find((c) =>
    c.op === 'exec' && Array.isArray(c.args[1]) && (c.args[1] as string[])[0] === 'journalctl');
  assert.deepEqual((journal?.args[1] as string[]).slice(0, 5), ['journalctl', '-u', 'byokit-web.service', '-n', '500']);
  await m.sleep();
  const stop = [...f.fake.calls].reverse().find((c) =>
    c.op === 'exec' && Array.isArray(c.args[1]) && (c.args[1] as string[]).includes('stop'));
  assert.deepEqual(stop?.args[1], ['systemctl', 'stop', 'byokit-web.service']);

  const g = fakeProvider({ id: 'ssh-vm' });
  const m2 = machine({ provider: g, store: memoryStore() });
  await m2.create({ name: 'web', size: 'small', keepCopies: false });
  await m2.install(recipe('web'));
  assert.equal(await m2.host(), 'running');
  assert.deepEqual(await m2.logs(5), []);
  const journal2 = [...g.fake.machine.runs].reverse().find((run) => run.argv[0] === 'journalctl');
  assert.deepEqual(journal2?.argv.slice(0, 5), ['journalctl', '--user', '-u', 'byokit-web.service', '-n']);
});

test('the deliver shell matches 5.8', () => {
  assert.ok(DELIVER_SHELL.includes('umask 077') && DELIVER_SHELL.includes('.in-XXXXXX'));
});
