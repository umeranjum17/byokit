// Consumer journeys for the published @byokit/cloud surface (the built package exports), driven the
// way an app uses it: rent a cloud computer on the person's own provider account, install the app's
// host on it, supervise it to running, drive the Boat provider over its real HTTP API, and tell the
// person what it costs in plain words. Every security and correctness contract the removed unit and
// fake-provider cases held survives as an assertion inside a journey: a deliver can never escape into
// a root-owned path, a staged write is 0600, a recipe with a secret or an unsafe path is refused, an
// installRoot step runs once behind its marker, a machine without root is refused rather than
// half-installed, a rejected key never appears in an error, a delete removes only the kit's own
// snapshots, and a reset brings back a saved copy while pruning only the kit's own copies. The provider is the kit's own bench (in-memory fake, loopback fake server); no network,
// key or real machine is used.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  machine, boat, estimate, status, setup, sshHostKey, sshVm, words, stateWords, hostWords, errorWords, errorKey, keyWords, WORDS, MachineError,
} from '@byokit/cloud';
import type {
  HostRecipe, Status, SetupStep, MachineErrorCode, MachineRef, MachineState, HostState, Price, KeyInfo, Snapshot, Provider, ExecResult,
} from '@byokit/cloud';
import { fakeProvider, fakeSshTransport, memoryStore, startFakeSandboxServer } from '@byokit/cloud/testing';

const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });

const recipe = (name = 'web'): HostRecipe => ({
  name,
  node: { version: '24.15.0', sha256: sha('a') },
  install: [['npm', 'ci']],
  run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } },
  workDir: '/home/user/app',
});

const prices = (): readonly Price[] => [{
  size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
  currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://boat.test/prices', checked: '2026-09-29',
}];

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

const collectSteps = async (it: AsyncIterable<SetupStep>): Promise<SetupStep[]> => {
  const steps: SetupStep[] = [];
  for await (const s of it) steps.push(s);
  return steps;
};

const pickId = (id: string) => (listed: MachineRef[]): MachineRef => {
  const found = listed.find((r) => r.id === id);
  assert.ok(found !== undefined);
  return found;
};

test('an app picks an existing Boat computer, consents to installation, and retries without another rental', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Boat', prices: prices(), key: async () => 'test-key' });
    const existing = await provider.create!({ name: 'old', size: 'small', keepCopies: true, idempotencyKey: 'seed' });
    const [selected] = await provider.list!();
    assert.deepEqual(selected, { ...existing, name: 'computer' });
    assert.equal(server.machine.runs.length, 0);
    const start = server.requests.length;
    const store = memoryStore();
    const m = machine({ provider, store });
    const opts = { confirmId: selected.id, recipe: recipe() };
    await rejects(m.adopt(selected, { ...opts, confirmId: 'another' }), 'confirm');
    await rejects(m.adopt({ ...selected, account: 'another' }, opts), 'wrong-account');
    await rejects(m.adopt({ ...selected, id: 'missing' }, { ...opts, confirmId: 'missing' }), 'no-machine');
    assert.equal(server.machine.runs.length, 0);
    assert.equal(await store.load(), null);
    // Refuse existing files, service ownership, and a redirected parent without writing.
    for (const path of [recipe().workDir, '/etc/systemd/system/byokit-web.service']) {
      server.machine.writeFile(path, new TextEncoder().encode('keep'), 0o600);
      const before = [...server.machine.files];
      await rejects(m.adopt(selected, opts), 'exists');
      assert.deepEqual([...server.machine.files], before);
      assert.equal(await store.load(), null);
      server.machine.files.delete(path);
    }
    server.machine.symlink('/home/user', '/elsewhere');
    await rejects(m.adopt(selected, opts), 'exists');
    server.machine.symlinks.clear();
    // A live status reply for a different id must not authorize installation.
    const wrong = boat({ baseUrl: server.url, label: 'Boat', prices: prices(), key: async () => 'test-key',
      fetch: async (url, init) => String(url).endsWith(`/sandboxes/${selected.id}`) && init?.method === 'GET'
        ? Response.json({ sandbox: { id: 'another', state: 'ready' } }) : fetch(url, init) });
    await rejects(machine({ provider: wrong, store: memoryStore() }).adopt(selected, opts), 'provider');
    server.machine.script('npm', { code: 1, stdout: '', stderr: 'install refused', timedOut: false });
    const adopting = rejects(m.adopt(selected, opts), 'provider');
    await rejects(m.create({ name: 'extra', size: 'small', keepCopies: true }), 'busy');
    const installError = await adopting;
    assert.ok(installError instanceof MachineError);
    assert.deepEqual(installError.extra, { step: '0', tail: 'install refused' });
    assert.deepEqual(m.ref, { ...selected, name: 'web' });
    server.machine.script('npm', { code: 0, stdout: '', stderr: '', timedOut: false });
    await m.install(recipe());
    assert.equal(await m.host(), 'running');
    assert.deepEqual(JSON.parse(textOf(server.machine.files.get('/home/user/app/.byokit/installed.json')!.bytes)), { id: selected.id });
    await rejects(m.adopt(selected, opts), 'exists');
    assert.equal(server.requests.slice(start).filter((r) => r.method === 'POST' && r.path === '/sandboxes').length, 0);
    assert.equal(server.requests.slice(start).filter((r) => r.path.endsWith('/resume')).length, 0);
    // A second app installs under a fresh name and directory on the same existing id.
    const other = machine({ provider, store: memoryStore() });
    const adopted = await other.adopt(selected, { confirmId: selected.id, recipe: { ...recipe('other'), workDir: '/home/user/other' } });
    assert.equal(adopted.id, selected.id);
    assert.equal(await other.host(), 'running');
  } finally { await server.close(); }
});

test('Boat existing-computer listing follows pages and rejects malformed responses', async () => {
  let bad = false;
  const calls: string[] = [];
  const provider = boat({ baseUrl: 'http://boat.test', label: 'Boat', prices: prices(), key: async () => 'test-key',
    fetch: async (url) => {
      calls.push(String(url));
      if (String(url).endsWith('/me')) return Response.json({ user: { id: 'acct' } });
      if (bad) return Response.json({ pageInfo: { hasMore: true } });
      const second = String(url).includes('cursor=');
      return Response.json({ sandboxes: second ? [{ id: 'two', snapshots: false }] : [
        { id: 'one', snapshots: true, access: 'owner', desktopUrl: 'must-not-escape' }, { id: 'view-only', access: 'view' },
      ], pageInfo: { hasMore: !second, nextCursor: second ? null : 'next/page' } });
    } });
  assert.deepEqual((await provider.list!()).map((r) => [r.id, r.keepCopies]), [['one', true], ['two', false]]);
  assert.ok(calls.at(-1)?.endsWith('cursor=next%2Fpage'));
  bad = true;
  await rejects(provider.list!(), 'provider');
});

test('an app rents its own cloud computer, installs its host, and supervises it through its life', async () => {
  const provider = fakeProvider();
  const store = memoryStore();
  const m = machine({ provider, store });
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  assert.equal(ref.name, 'web');
  assert.deepEqual(m.ref, ref);
  assert.deepEqual(await store.load(), { providerKey: '', ref });
  assert.equal(await m.state(), 'on');

  // The install step lines reach the app in order, then the host is running.
  provider.fake.machine.script('npm', { code: 0, stdout: 'installed\n', stderr: 'warn\n', timedOut: false });
  const lines: string[] = [];
  await m.install(recipe('web'), (line) => lines.push(line));
  assert.deepEqual(lines, ['installed', 'warn']);
  assert.equal(await m.host(), 'running');

  // installed.json is written at 0600 with the ref id, so a restart knows where it runs.
  const installed = provider.fake.machine.files.get('/home/user/app/.byokit/installed.json');
  assert.ok(installed !== undefined && installed.mode === 0o600);
  assert.deepEqual(JSON.parse(textOf(installed.bytes)), { id: ref.id });

  // update keeps the same host running.
  await m.update({ ...recipe('web'), update: [['npm', 'run', 'migrate']] });
  assert.equal(await m.host(), 'running');

  // deliver lands the bytes at 0600 in the inbox, owned by the run user.
  const key = new TextEncoder().encode('phone-key');
  await m.deliver(recipe('web'), 'phone-key.txt', key);
  const delivered = provider.fake.machine.files.get('/home/user/app/.byokit/inbox/phone-key.txt');
  assert.ok(delivered !== undefined && delivered.mode === 0o600 && delivered.owner === 'user');
  assert.deepEqual(delivered.bytes, key);

  // A symlinked inbox pointing at a root-owned directory refuses the write: nothing lands there and
  // the app learns the real cause instead of a silent success.
  const inbox = '/home/user/app/.byokit/inbox';
  provider.fake.machine.symlink(inbox, '/root/elsewhere');
  provider.fake.machine.dirs.set('/root/elsewhere', { owner: 'root', mode: 0o755 });
  await rejects(m.deliver(recipe('web'), 'note.txt', new TextEncoder().encode('hi')), 'provider');
  assert.equal(provider.fake.machine.files.get('/root/elsewhere/note.txt'), undefined);

  // The person reads the logs, sleeps the machine, and removes it for good.
  provider.fake.machine.log('web', 'hello');
  assert.deepEqual(await m.logs(5), ['hello']);
  await m.sleep();
  assert.equal(await m.state(), 'asleep');
  await m.remove(ref.id);
  assert.equal(m.ref, null);
});

test('an app runs its own command on the kit machine with the unit\'s node, user and work directory and reads the newest offer', async () => {
  const provider = fakeProvider();
  const m = machine({ provider, store: memoryStore() });
  await m.create({ name: 'web', size: 'small', keepCopies: true });
  const fake = provider.fake.machine;
  const r = { ...recipe('web'), user: 'svc', workDir: '/home/user/.users/svc/app' };
  // Before install the node is missing: the app learns the real cause and nothing is installed.
  fake.nodeVersion = null;
  await rejects(m.run(r, ['muxr', 'self-host']), 'provider');
  assert.ok(!fake.runs.some((x) => x.argv.some((a) => a.includes('sha256sum'))));
  fake.nodeVersion = 'v24.15.0';
  fake.script('muxr', { code: 3, stdout: 'out', stderr: 'err', timedOut: false });
  // Any exit code and both streams pass through; the argv runs as the run user, in workDir, with the recipe env.
  const done = await m.run(r, ['muxr', 'pair', '--handoff'], { timeoutMs: 5_000 });
  assert.deepEqual(done, { code: 3, stdout: 'out', stderr: 'err', timedOut: false });
  const sent = fake.runs.at(-1)!;
  assert.equal(sent.asUser, 'svc');
  assert.deepEqual(sent.argv.slice(-7), [
    '/home/user/.users/svc/app', '/home/user/.users/svc/.local/share/byokit/node/24.15.0/bin',
    'env', 'PORT=7310', 'muxr', 'pair', '--handoff',
  ]);
  await rejects(m.run(r, []), 'bad-recipe');
  await rejects(m.run(r, ['A=1', 'x']), 'bad-recipe');

  // The newest offer by prefix: the last written wins, other prefixes and absent files give null, a bad prefix is refused.
  assert.equal(await m.newest(r, 'offer-'), null);
  for (const [file, text] of [['offer-1.json', 'one'], ['other.json', 'x'], ['offer-2.json', 'two']] as const) {
    fake.writeFile(`/home/user/.users/svc/app/.byokit/outbox/${file}`, new TextEncoder().encode(text), 0o600, 'svc');
  }
  assert.deepEqual(await m.newest(r, 'offer-'), { file: 'offer-2.json', text: 'two' });
  await rejects(m.newest(r, '../x'), 'bad-recipe');
});

test('a phone polls one status while it creates, installs, stops, starts and deletes its cloud computer', async () => {
  // Boat's create resolves before the machine is on; the fake reads creating twice, and a command
  // sent to a machine that is not on fails, so the poll must not ask the host until it is on.
  const provider = fakeProvider({ createReads: 2 });
  const store = memoryStore();
  const m = machine({ provider, store });
  const vars = { app: 'Muxr', label: 'Boat' };
  const seen: string[] = [];
  const poll = async (until: (s: Status) => boolean): Promise<Status> => {
    for (let i = 0; i < 10; i++) {
      const s = await status(m, vars);
      if (seen.at(-1) !== s.words) seen.push(s.words);
      if (until(s)) return s;
    }
    assert.fail(`status never settled: ${seen.join(' | ')}`);
  };

  const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
  await rejects(m.host(), 'unreachable');
  assert.deepEqual(await poll((s) => s.machine === 'on'), { machine: 'on', host: 'not-installed', words: "Muxr isn't on your cloud computer yet." });

  await m.install(recipe('web'));
  assert.equal((await poll((s) => s.host === 'running')).words, 'Muxr is running on your cloud computer.');

  await m.sleep();
  assert.deepEqual(await status(m, vars), { machine: 'asleep', host: null, words: 'Your cloud computer is asleep. Opening Muxr wakes it.' });
  await m.wake();
  assert.equal((await poll((s) => s.host === 'running')).words, 'Muxr is running on your cloud computer.', 'the unit comes back with the machine');

  // A machine that sleeps between the state read and the host read reads asleep, not an error.
  const racing = machine({
    provider: { ...provider, status: async (r) => { const s = await provider.status(r); provider.fake.setState(r.id, 'asleep'); return s; } },
    store,
  });
  assert.deepEqual(await status(racing, vars), { machine: 'asleep', host: null, words: 'Your cloud computer is asleep. Opening Muxr wakes it.' });
  await m.wake();

  await m.remove(ref.id);
  assert.equal(await provider.status(ref), 'gone');
  await rejects(status(m, vars), 'no-machine');

  // A machine removed while it still reads creating reads gone at once and stays gone.
  const late = machine({ provider, store: memoryStore() });
  const lateRef = await late.create({ name: 'late', size: 'small', keepCopies: true });
  await late.remove(lateRef.id);
  assert.deepEqual(
    [await provider.status(lateRef), await provider.status(lateRef), await provider.status(lateRef)],
    ['gone', 'gone', 'gone'],
  );
  assert.deepEqual(seen, [
    'Setting up your cloud computer. This takes a minute or two.',
    "Muxr isn't on your cloud computer yet.",
    'Muxr is running on your cloud computer.',
  ]);
});

test('an app installs only when the machine and the recipe are safe, and the root steps run once', async () => {
  // Root steps behind the marker: installRoot runs as root once, a second install runs none.
  const rooted = fakeProvider();
  const m = machine({ provider: rooted, store: memoryStore() });
  await m.create({ name: 'web', size: 'small', keepCopies: true });
  rooted.fake.machine.script('apt-get', { code: 0, stdout: '', stderr: '', timedOut: false });
  const rootRecipe: HostRecipe = { ...recipe('web'), installRoot: [['apt-get', 'install', '-y', 'foo']] };
  await m.install(rootRecipe);
  assert.equal(await m.host(), 'running');
  const rootRuns = (): number => rooted.fake.machine.runs.filter((run) => run.argv[0] === 'apt-get').length;
  assert.equal(rootRuns(), 1);
  await m.install(rootRecipe);
  assert.equal(rootRuns(), 1, 'a second install with the marker runs no root step');

  // Without root access, a recipe that needs root is refused; nothing runs, nothing is written.
  const noroot = fakeProvider({ id: 'ssh-vm', root: false });
  const stuck = machine({ provider: noroot, store: memoryStore() });
  await stuck.create({ name: 'web', size: 'small', keepCopies: false });
  const refused = await rejects(stuck.install(rootRecipe), 'needs-root');
  assert.match(refused.extra.command, /^sudo /);
  assert.equal(noroot.fake.machine.units.size, 0);
  assert.equal(noroot.fake.machine.files.size, 0);

  // A no-sudo run user needs root on every install, and the refusal carries no command to run.
  const userRefused = await rejects(
    stuck.install({ ...recipe('web'), user: 'appbot', workDir: '/home/user/.users/appbot/app' }),
    'needs-root',
  );
  assert.ok(!('command' in userRefused.extra));

  // A user recipe on a rooted machine runs the app as that user, under a system unit with User=.
  const rootedUser = fakeProvider({ id: 'ssh-vm' });
  const um = machine({ provider: rootedUser, store: memoryStore() });
  await um.create({ name: 'web', size: 'small', keepCopies: false });
  await um.install({ ...recipe('web'), user: 'appbot', workDir: '/home/user/.users/appbot/app' });
  assert.equal(await um.host(), 'running');
  assert.ok(rootedUser.fake.machine.users.has('appbot'));
  const userUnit = rootedUser.fake.machine.files.get('/etc/systemd/system/byokit-web.service');
  assert.ok(userUnit !== undefined && textOf(userUnit.bytes).includes('User=appbot'));

  // A plain SSH user unit needs lingering; a refusal names the line the person runs by hand.
  const linger = fakeProvider({ id: 'ssh-vm' });
  linger.fake.machine.lingerOk = false;
  const lm = machine({ provider: linger, store: memoryStore() });
  await lm.create({ name: 'web', size: 'small', keepCopies: false });
  const lingerErr = await rejects(lm.install(recipe('web')), 'linger');
  assert.equal(lingerErr.extra.command, 'sudo loginctl enable-linger user');

  // Node: a machine node inside the recipe's range is used as-is.
  const inRange = fakeProvider();
  inRange.fake.machine.nodeVersion = 'v24.21.0';
  const im = machine({ provider: inRange, store: memoryStore() });
  await im.create({ name: 'web', size: 'small', keepCopies: true });
  await im.install({ ...recipe('web'), node: { version: '24.15.0', sha256: sha('a'), range: '>=24.15.0 <25' } });
  const inRangeUnit = inRange.fake.machine.files.get('/etc/systemd/system/byokit-web.service');
  assert.ok(inRangeUnit !== undefined && textOf(inRangeUnit.bytes).includes('ExecStart="/usr/bin/node"'));

  // A missing or out-of-range node runs the pinned install; a checksum mismatch is a bad recipe.
  const pinned = fakeProvider();
  pinned.fake.machine.nodeVersion = null;
  const pm = machine({ provider: pinned, store: memoryStore() });
  await pm.create({ name: 'web', size: 'small', keepCopies: true });
  await pm.install(recipe('web'));
  const pinnedUnit = pinned.fake.machine.files.get('/etc/systemd/system/byokit-web.service');
  assert.ok(pinnedUnit !== undefined && textOf(pinnedUnit.bytes).includes('/home/user/.local/share/byokit/node/24.15.0/bin/node'));

  const bad = fakeProvider();
  bad.fake.machine.nodeVersion = null;
  bad.fake.machine.nodeInstallCode = 3;
  const bm = machine({ provider: bad, store: memoryStore() });
  await bm.create({ name: 'web', size: 'small', keepCopies: true });
  await rejects(bm.install(recipe('web')), 'bad-recipe');

  // A machine whose login is root cannot host a no-sudo user recipe.
  const asRoot = fakeProvider({ id: 'ssh-vm' });
  asRoot.fake.machine.user = 'root';
  asRoot.fake.machine.home = '/root';
  const rm = machine({ provider: asRoot, store: memoryStore() });
  await rm.create({ name: 'web', size: 'small', keepCopies: false });
  await rejects(rm.install({ ...recipe('web'), user: 'appbot', workDir: '/root/.users/appbot/app' }), 'bad-recipe');
});

test('an app rents on Boat and drives the real HTTP machine: no-env, status, exec, write', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const ref = await provider.create!({ name: 'web', size: 'small', keepCopies: true, idempotencyKey: 'bench-1' });

    // create is no-env and snapshot-on, and no request body ever carries env.
    const creates = server.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.deepEqual(creates[0].body, { type: 'small', ttlSeconds: null, noEnv: true, snapshots: true });
    for (const r of server.requests) {
      if (r.body !== null && typeof r.body === 'object') assert.ok(!('env' in (r.body as object)), `${r.method} ${r.path} carries env`);
    }

    // status maps every provider row, a 404 is gone, and a request that failed after retries is unknown.
    const rows: Array<[string, string]> = [
      ['init', 'creating'], ['provisioning', 'creating'], ['provisioned', 'creating'], ['cloning', 'creating'],
      ['ready', 'on'], ['idle', 'on'], ['running', 'on'], ['archiving', 'stopping'], ['archived', 'asleep'],
      ['error', 'failed'], ['cancelled', 'gone'],
    ];
    for (const [raw, mapped] of rows) {
      server.setState(ref.id, raw);
      assert.equal(await provider.status(ref), mapped, raw);
    }
    assert.equal(await provider.status({ ...ref, id: 'sb-nope' }), 'gone');
    server.failNext([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    assert.equal(await provider.status(ref), 'unknown');

    // exec round-trips a hostile argv, adds sudo for root, stages stdin at 0600, and keeps the code.
    const argv = ['echo', "it's", 'a;b', '$x', 'back\\slash', 'plain'];
    server.machine.script('echo', { code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    assert.deepEqual(await provider.exec(ref, argv, { timeoutMs: 5000 }), { code: 0, stdout: 'hi\n', stderr: '', timedOut: false });
    const wire = server.requests.filter((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/commands`).at(-1)?.body as Record<string, unknown>;
    assert.match(wire['command'] as string, /^timeout -k 10 5 /);
    assert.match(wire['command'] as string, /'it'\\''s'/);
    assert.deepEqual(server.machine.runs.at(-1)?.argv, argv);

    server.machine.script('true', { code: 0, stdout: '', stderr: '', timedOut: false });
    await provider.exec(ref, ['true'], { timeoutMs: 1000, root: true });
    const rootWire = server.requests.filter((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/commands`).at(-1)?.body as Record<string, unknown>;
    assert.match(rootWire['command'] as string, /^sudo -n timeout -k 10 1 /);

    server.machine.script('cat', { code: 3, stdout: '', stderr: 'nope', timedOut: false });
    const input = new TextEncoder().encode('secret-bytes');
    const withInput = await provider.exec(ref, ['cat'], { timeoutMs: 5000, input });
    assert.deepEqual([withInput.code, withInput.stderr], [3, 'nope']);
    const stagedCmd = (server.requests.filter((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/commands`).at(-1)?.body as Record<string, unknown>)['command'] as string;
    const stagePath = / < (\/tmp\/byokit-in-[0-9a-z]{16}); r=\$\?; rm -f \1; exit \$r$/.exec(stagedCmd)?.[1];
    assert.ok(stagePath !== undefined);
    assert.equal(server.machine.files.get(stagePath)?.mode, 0o600);

    // A command over the non-detached ceiling runs detached and reads the result from the route.
    server.machine.script('long', { code: 0, stdout: 'done\n', stderr: '', timedOut: false });
    assert.deepEqual(await provider.exec(ref, ['long'], { timeoutMs: 600_000 }), { code: 0, stdout: 'done\n', stderr: '', timedOut: false });
    const posts = server.requests.filter((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/commands`);
    assert.equal((posts.at(-1)?.body as Record<string, unknown>)['detached'], true);
    assert.ok(server.requests.some((r) => r.method === 'GET' && r.path.startsWith(`/sandboxes/${ref.id}/commands/`)));

    // A lost command read (running false, exitCode null) is a provider failure, never exit 0.
    server.machine.script('lost', { code: 0, stdout: '', stderr: '', timedOut: false });
    server.loseNextCommand();
    await rejects(provider.exec(ref, ['lost'], { timeoutMs: 600_000 }), 'provider');

    // write outside /home/user/ and /tmp/ rejects before any request; an allowed path lands at its mode.
    const before = server.requests.length;
    const bad = await provider.write(ref, '/etc/evil', new Uint8Array([1]), 0o644).then(() => null, (e) => e as MachineError);
    assert.equal(bad?.code, 'bad-recipe');
    assert.equal(server.requests.length, before);
    const bytes = new TextEncoder().encode('hello');
    await provider.write(ref, '/home/user/app/x.txt', bytes, 0o600);
    assert.deepEqual(server.machine.readFile('/home/user/app/x.txt'), bytes);
    assert.equal(server.machine.files.get('/home/user/app/x.txt')?.mode, 0o600);
  } finally {
    await server.close();
  }

  // A create whose first connection dropped retries with the same Idempotency-Key.
  const flaky = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: flaky.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const m = machine({ provider, store: memoryStore() });
    await provider.account();
    flaky.dropNext(1);
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    assert.equal(ref.name, 'web');
    const creates = flaky.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.equal(creates.length, 2, 'the dropped attempt was retried');
    assert.equal(creates[0].dropped, true);
    assert.equal(new Set(creates.map((r) => r.headers['idempotency-key'])).size, 1, 'every attempt carries the same key');
  } finally {
    await flaky.close();
  }

  // During a trial, create/resume/fork retry once with the 2-hour cap and the same idempotency key.
  const trial = await startFakeSandboxServer({ trial: true });
  try {
    const provider = boat({ baseUrl: trial.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const m = machine({ provider, store: memoryStore() });
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    const creates = trial.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.equal(creates.length, 2);
    assert.deepEqual([
      (creates[0].body as Record<string, unknown>)['ttlSeconds'],
      (creates[1].body as Record<string, unknown>)['ttlSeconds'],
    ], [null, 7200]);
    assert.equal(creates[0].headers['idempotency-key'], creates[1].headers['idempotency-key']);
    trial.setState(ref.id, 'archived');
    await m.wake();
    const resumes = trial.requests.filter((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/resume`);
    assert.deepEqual((resumes.at(-1)?.body as Record<string, unknown>)['ttlSeconds'], 7200);
    await provider.fork!(ref, { name: 'copy', size: 'small', idempotencyKey: 'fork-1' });
    const forks = trial.requests.filter((r) => r.method === 'POST' && r.path === `/sandboxes/${ref.id}/fork`);
    assert.deepEqual((forks.at(-1)?.body as Record<string, unknown>)['ttlSeconds'], 7200);
    assert.equal(forks.at(-1)?.headers['idempotency-key'], 'fork-1');
  } finally {
    await trial.close();
  }
});

test('a Boat bootstrap joins the private network without opening a public app port or carrying a join key', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Boat', prices: prices(), key: async () => 'test-key' });
    const m = machine({ provider, store: memoryStore() });
    await rejects(m.tailnet(), 'no-machine');
    await rejects(m.joinTailnet({ hostname: 'byokit-cloud' }), 'no-machine');
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: false });
    assert.deepEqual(await m.tailnet(), { state: 'off', name: null });
    server.machine.script('npm', { code: 0, stdout: '', stderr: '', timedOut: false });
    await m.install(recipe('web'));
    assert.equal(await m.host(), 'running');

    const before = server.machine.runs.length;
    const canary = ['tskey', 'canary', 'not', 'real'].join('-');
    const refused = await rejects(m.joinTailnet({ hostname: 'byokit-cloud', authKey: canary }), 'unsupported');
    assert.match(refused.message, /sign-in on your phone/);
    await rejects(m.joinTailnet({ hostname: 'byokit-cloud', authKey: '' }), 'unsupported');
    await rejects(m.joinTailnet({ hostname: 'bad;name' }), 'bad-recipe');
    assert.equal(server.machine.runs.length, before, 'a refused key or hostname runs nothing');
    assert.ok(!JSON.stringify(server.requests).includes(canary));

    // The HTTP bench carries the real argv; only the remote bootstrap and daemon are stand-ins.
    server.machine.script('sh', { code: 0, stdout: '', stderr: '', timedOut: false });
    const daemon = (BackendState: string, DNSName?: string, stderr = '') => server.machine.script('tailscale', {
      code: BackendState === 'Running' ? 0 : 1, stdout: JSON.stringify({ BackendState, Self: { DNSName } }), stderr, timedOut: false,
    });
    daemon('NeedsLogin', undefined, 'To authenticate, visit: https://login.tailscale.com/a/test-login\n');
    assert.deepEqual(await m.tailnet(), { state: 'needs-login', name: null });
    const steps: string[] = [];
    assert.deepEqual(await m.joinTailnet({ hostname: 'byokit-cloud' }, (s) => {
      steps.push(s.step);
      if (s.step === 'open-page') {
        assert.equal(s.url, 'https://login.tailscale.com/a/test-login');
        daemon('Running', 'cloud.lab.ts.net.'); // the person approved it on their phone
      }
    }), { name: 'cloud.lab.ts.net' });
    assert.deepEqual(steps, ['open-page', 'joined']);
    assert.deepEqual(await m.tailnet(), { state: 'joined', name: 'cloud.lab.ts.net' });
    const bootstrap = server.machine.runs.slice(before).find(r => r.argv[0] === 'sh' && r.argv[1] === '-c');
    assert.ok(bootstrap?.root && bootstrap.inputBytes === 0);
    assert.equal(server.requests.filter(r => r.path.endsWith('/host')).length, 0, 'bootstrap plus host makes no public hosting call');
    daemon('NeedsMachineAuth');
    const approvals: string[] = [];
    assert.deepEqual(await m.joinTailnet({ hostname: 'byokit-cloud' }, (s) => {
      approvals.push(s.step);
      if (s.step === 'approve') {
        assert.equal(s.name, 'byokit-cloud');
        daemon('Running', 'cloud.lab.ts.net.'); // the tailnet admin approved the machine
      }
    }), { name: 'cloud.lab.ts.net' });
    assert.deepEqual(approvals, ['approve', 'joined']);
    daemon('NeedsLogin', undefined, 'To authenticate, visit: https://login.tailscale.com/a/test-approve\n');
    const afterLink: string[] = [];
    assert.deepEqual(await m.joinTailnet({ hostname: 'byokit-cloud' }, (s) => {
      afterLink.push(s.step);
      if (s.step === 'open-page') daemon('NeedsMachineAuth', 'cloud.lab.ts.net.'); // signed in; the admin still must approve
      if (s.step === 'approve') daemon('Running', 'cloud.lab.ts.net.');
    }), { name: 'cloud.lab.ts.net' });
    assert.deepEqual(afterLink, ['open-page', 'approve', 'joined']);
    daemon('NeedsMachineAuth', 'cloud.lab.ts.net.');
    assert.equal((await m.tailnet()).state, 'needs-approval');
    daemon('Stopped');
    assert.equal((await m.tailnet()).state, 'off');
    daemon('Starting');
    assert.deepEqual(await m.tailnet(), { state: 'starting', name: null });
    server.machine.script('tailscale', { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled', timedOut: false });
    assert.deepEqual(await m.tailnet(), { state: 'starting', name: null });
    daemon('Unexpected');
    await rejects(m.tailnet(), 'provider');
    daemon('Running', 'not-a-tailnet-name');
    await rejects(m.tailnet(), 'provider');
    await m.remove(ref.id);
  } finally { await server.close(); }
});

test('a sign-in link shown late in the startup wait keeps a full five minutes to sign in', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const base = fakeProvider();
    const signInAfter = 2 * 60_000;
    let upAt: number | null = null;
    const provider: Provider = {
      ...base,
      exec: async (ref, argv, opts) => {
        const now = Date.now();
        if (argv[0] === 'true' || argv[0] === 'sh' || argv[0] === 'systemctl') return { code: 0, stdout: '', stderr: '', timedOut: false };
        if (argv[0] === 'tailscale' && argv[1] === 'up') {
          upAt = now;
          return { code: 1, stdout: '', stderr: 'To authenticate, visit: https://login.tailscale.com/a/fake-clock\n', timedOut: false };
        }
        if (argv[0] === 'tailscale' && argv[1] === 'status') {
          const signedIn = upAt !== null && now >= upAt + signInAfter;
          const status = now < 299_000 ? { BackendState: 'Starting' }
            : signedIn ? { BackendState: 'Running', Self: { DNSName: 'cloud.lab.ts.net.' } }
              : { BackendState: 'NeedsLogin' };
          return { code: 0, stdout: JSON.stringify(status), stderr: '', timedOut: false };
        }
        return base.exec(ref, argv, opts);
      },
    };
    const m = machine({ provider, store: memoryStore() });
    await m.create({ name: 'web', size: 'small', keepCopies: false });
    const steps: string[] = [];
    let outcome: { name: string } | MachineError | undefined;
    const joined = m.joinTailnet({ hostname: 'byokit-cloud' }, (s) => { steps.push(s.step); }).then(
      (v) => { outcome = v; },
      (e: MachineError) => { outcome = e; },
    );
    for (let ticks = 0; outcome === undefined; ticks += 1) {
      assert.ok(ticks < 1000, 'the join settles inside the fake clock');
      await new Promise((resolve) => setImmediate(resolve));
      if (outcome === undefined) mock.timers.tick(1000);
    }
    await joined;
    assert.deepEqual(outcome, { name: 'cloud.lab.ts.net' });
    assert.deepEqual(steps, ['open-page', 'joined']);
    assert.ok(upAt !== null && upAt >= 299_000, 'the link shows only after the startup wait');
    assert.ok(Date.now() >= upAt + signInAfter, 'the person signed in two minutes after the link');
  } finally { mock.timers.reset(); }
});

for (const forever of [false, true]) test(forever
  ? 'hung sign-in status checks end at the window deadline, not the first check timeout'
  : 'a hung status check mid-sign-in is retried and a ready machine joins', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  try {
    const base = fakeProvider();
    let upAt: number | null = null, hung = 0;
    const provider: Provider = { ...base, exec: async (ref, argv, opts) => {
      if (argv[0] === 'tailscale' && argv[1] === 'up') {
        upAt = Date.now();
        return { code: 1, stdout: 'https://login.tailscale.com/a/hung-check', stderr: '', timedOut: false };
      }
      if (argv[0] === 'tailscale' && argv[1] === 'status') {
        if (upAt !== null && Date.now() >= upAt + 60_000 && (forever || hung === 0)) {
          hung++;
          assert.equal(opts.timeoutMs, 30_000);
          return new Promise<ExecResult>(resolve => setTimeout(() => resolve({ code: 124, stdout: '', stderr: '', timedOut: true }), 30_000));
        }
        return { code: 0, stdout: JSON.stringify(hung
          ? { BackendState: 'Running', Self: { DNSName: 'hung-check.tail.ts.net.' } }
          : { BackendState: 'NeedsLogin' }), stderr: '', timedOut: false };
      }
      if (['true', 'sh', 'systemctl'].includes(argv[0])) return { code: 0, stdout: '', stderr: '', timedOut: false };
      return base.exec(ref, argv, opts);
    } };
    const m = machine({ provider, store: memoryStore() });
    await m.create({ name: 'hung-check', size: 'small', keepCopies: false });
    const steps: string[] = [];
    let settled = false, outcome: unknown;
    const joined = m.joinTailnet({ hostname: 'hung-check' }, s => steps.push(s.step)).then(
      v => { outcome = v; settled = true; }, e => { outcome = e; settled = true; },
    );
    for (let ticks = 0; !settled; ticks++) {
      assert.ok(ticks < 340, 'status timeouts never restart the sign-in window');
      await new Promise(resolve => setImmediate(resolve));
      if (!settled) mock.timers.tick(1000);
    }
    await joined;
    assert.ok(upAt !== null);
    if (forever) {
      assert.ok(outcome instanceof MachineError);
      assert.equal(outcome.code, 'timeout');
      assert.equal(outcome.message, 'Starting your private network took too long.');
      assert.ok(Date.now() >= upAt + 300_000 && Date.now() < upAt + 330_000);
      assert.ok(hung > 1);
      assert.deepEqual(steps, ['open-page']);
    } else {
      assert.deepEqual(outcome, { name: 'hung-check.tail.ts.net' });
      assert.equal(hung, 1);
      assert.ok(Date.now() >= upAt + 90_000 && Date.now() < upAt + 300_000);
      assert.deepEqual(steps, ['open-page', 'joined']);
    }
  } finally { mock.timers.reset(); }
});

test('private-network deadlines distinguish startup, approval, an unused link and no link', async () => {
  for (const [state, link, message, expectedSteps] of [
    ['Starting', false, 'Starting your private network took too long.', []],
    ['NeedsMachineAuth', true, words('tailnet.approvalNeeded'), ['open-page', 'approve']],
    ['NeedsLogin', true, words('tailnet.loginExpired'), ['open-page']],
    ['NeedsLogin', false, 'Starting your private network took too long.', []],
    // A real control server can hand out the link after `up` returned: the daemon's status carries it.
    ['NeedsLogin', 'status', words('tailnet.loginExpired'), ['open-page']],
  ] as const) {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
    try {
      const base = fakeProvider();
      let upCalls = 0;
      const provider: Provider = { ...base, exec: async (ref, argv, opts) => {
        if (argv[0] === 'tailscale' && argv[1] === 'up') {
          upCalls++;
          return { code: 0, stdout: link === true ? 'https://login.tailscale.com/a/deadline' : '', stderr: '', timedOut: false };
        }
        if (argv[0] === 'tailscale' && argv[1] === 'status') {
          const late = link === 'status' && upCalls > 0 ? { AuthURL: 'https://login.tailscale.com/a/late' } : {};
          return { code: 0, stdout: JSON.stringify({ BackendState: state, ...late }), stderr: '', timedOut: false };
        }
        if (['true', 'sh', 'systemctl'].includes(argv[0])) return { code: 0, stdout: '', stderr: '', timedOut: false };
        return base.exec(ref, argv, opts);
      } };
      const m = machine({ provider, store: memoryStore() });
      await m.create({ name: 'deadline', size: 'small', keepCopies: false });
      const steps: string[] = [];
      const urls: string[] = [];
      let error: unknown;
      const joined = m.joinTailnet({ hostname: 'deadline' }, s => { steps.push(s.step); if (s.step === 'open-page') urls.push(s.url); }).then(
        () => { error = new Error('join unexpectedly succeeded'); }, e => { error = e; },
      );
      for (let ticks = 0; error === undefined; ticks++) {
        assert.ok(ticks < 310, 'deadline must settle in five fake minutes');
        await new Promise(resolve => setImmediate(resolve));
        if (error === undefined) mock.timers.tick(1000);
      }
      await joined;
      assert.ok(error instanceof MachineError);
      assert.equal(error.code, 'timeout');
      assert.equal(error.message, message);
      assert.deepEqual(steps, expectedSteps);
      assert.equal(upCalls, state === 'Starting' ? 0 : 1, 'startup timeout must never run up');
      if (link === 'status') assert.deepEqual(urls, ['https://login.tailscale.com/a/late'], 'shown once, with a fresh five minutes');
      assert.ok(Date.now() >= 300_000 && Date.now() <= (link === 'status' ? 302_000 : 301_000));
    } finally { mock.timers.reset(); }
  }
});

test('an app cleans up on Boat and every failure stays honest: no key leak, no lying state', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const m = machine({ provider, store: memoryStore() });
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });

    // usage maps to the typed shape; a spent balance rejects balance.
    const used = await provider.usage!(ref, '2026-09-01T00:00:00.000Z');
    assert.deepEqual(
      { from: used.from, hours: used.hours, amount: used.amount, currency: used.currency },
      { from: '2026-09-01T00:00:00.000Z', hours: 24, amount: 0.5, currency: 'USD' },
    );
    // The public API has no current-key route, so the adapter exposes no key().
    assert.equal(provider.key, undefined);
    server.setBalance(0);
    await assert.rejects(provider.usage!(ref, '2026-09-01T00:00:00.000Z'), /balance/);

    // plan maps the public trial fields; the public sandbox has no stop reason, so why is absent.
    server.setPlan({ planKey: 'trial', subscriptionTrialEndsAt: '2026-10-06' });
    assert.deepEqual(await provider.plan!(), { inTrial: true, trialEndsAt: '2026-10-06', canStayOn: false, checkoutUrl: null });
    server.setPlan({ planKey: 'box_20', subscriptionTrialEndsAt: null });
    assert.deepEqual(await provider.plan!(), { inTrial: false, trialEndsAt: null, canStayOn: true, checkoutUrl: null });
    assert.equal(provider.why, undefined);

    // remove confirms with the id header, waits out the deletion, and deletes only the kit's snapshots.
    await provider.snapshot!(ref, 'a');
    await provider.snapshot!({ ...ref, name: 'other' }, 'x');
    // The public stop is asynchronous: sleep resolves only once the sandbox is archived.
    await provider.sleep!(ref);
    assert.equal(await provider.status(ref), 'asleep');
    await m.remove(ref.id);
    assert.equal(server.requests.find((r) => r.method === 'DELETE' && r.path === `/sandboxes/${ref.id}`)?.headers['x-ascii-confirm-delete'], ref.id);
    assert.ok(server.requests.some((r) => r.method === 'GET' && r.path.startsWith('/deletion-operations/')));
    const snapDeletes = server.requests.filter((r) => r.method === 'DELETE' && r.path.startsWith('/named-snapshots/'));
    assert.deepEqual(snapDeletes.map((r) => r.path), ['/named-snapshots/byokit-web-a']);
    assert.equal(m.ref, null);
  } finally {
    await server.close();
  }

  // A wrong key is unauthorized, the key never leaks, and 429/5xx retries three times then gives up.
  const failing = await startFakeSandboxServer();
  try {
    const bad = boat({ baseUrl: failing.url, label: 'Test', prices: prices(), key: async () => 'sk-secret-123' });
    const denied = await bad.account().then(() => null, (e) => e as MachineError);
    assert.equal(denied?.code, 'unauthorized');
    assert.ok(!denied.message.includes('sk-secret-123'), 'the key never appears in an error message');

    const good = boat({ baseUrl: failing.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    failing.failNext([{ status: 429 }, { status: 503 }, { status: 500 }]);
    const before = failing.requests.length;
    assert.equal(await good.account(), 'acct-test');
    assert.equal(failing.requests.length - before, 4, 'three retries after the first attempt');

    failing.failNext([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
    const exhausted = boat({ baseUrl: failing.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    assert.equal((await exhausted.account().then(() => null, (e) => e as MachineError))?.code, 'provider');

    // Cancel during a retry backoff ends the call at once with the same typed
    // error an aborted fetch gives; the caller's own aborted signal keeps
    // reading cancelled, exactly as before.
    const abort = new AbortController();
    const cancellable = boat({
      baseUrl: failing.url, label: 'Test', prices: prices(), key: async () => 'test-key', signal: abort.signal,
    });
    failing.failNext([{ status: 500 }]);
    const cancelStarted = Date.now();
    const cancelled = cancellable.account();
    setTimeout(() => abort.abort(), 50);
    assert.equal((await cancelled.then(() => null, (e) => e as MachineError))?.code, 'unreachable');
    assert.ok(abort.signal.aborted, 'the caller still distinguishes cancel from a dead provider');
    const cancelElapsed = Date.now() - cancelStarted;
    assert.ok(cancelElapsed < 500, `cancel returned in ${cancelElapsed} ms, not after the 1 s backoff`);

    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    const preCancelled = boat({
      baseUrl: failing.url, label: 'Test', prices: prices(), key: async () => 'test-key', signal: alreadyCancelled.signal,
    });
    failing.failNext([{ status: 500 }]);
    const preStarted = Date.now();
    assert.equal((await preCancelled.account().then(() => null, (e) => e as MachineError))?.code, 'unreachable');
    const preElapsed = Date.now() - preStarted;
    assert.ok(preElapsed < 500, `an already-cancelled call returned in ${preElapsed} ms, not after the 1 s backoff`);
  } finally {
    await failing.close();
  }

  const bodyAbort = new AbortController();
  const stalledBody: typeof fetch = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  }), { status: 200 });
  const midBody = boat({
    baseUrl: 'http://127.0.0.1:1', label: 'Test', prices: prices(), key: async () => 'k', fetch: stalledBody, signal: bodyAbort.signal,
  });
  const midBodyCall = midBody.account().then(() => null, (e) => e as MachineError);
  setTimeout(() => bodyAbort.abort(), 50);
  assert.equal((await midBodyCall)?.code, 'unreachable', 'an abort during the body read is the typed unreachable, not a raw AbortError');

  // Slow 429/5xx answers cannot stretch one call past the one overall
  // deadline: the last answer stands, with the same typed error as exhausted
  // retries. Three-second 500s used to cost 4 x 3 s attempts + 1+2+4 s waits.
  const slow500: typeof fetch = async () => {
    await new Promise((r) => setTimeout(r, 3000));
    return new Response('{}', { status: 500 });
  };
  const slow = boat({ baseUrl: 'http://127.0.0.1:1', label: 'Test', prices: prices(), key: async () => 'k', fetch: slow500 });
  const slowStarted = Date.now();
  assert.equal((await slow.account().then(() => null, (e) => e as MachineError))?.code, 'provider');
  const slowElapsed = Date.now() - slowStarted;
  assert.ok(slowElapsed >= 10_000, `the deadline, not the first waits, stopped the retries (${slowElapsed} ms)`);
  assert.ok(slowElapsed < 15_000, `one call stays near the 10 s deadline (${slowElapsed} ms)`);
});

test('a person saves copies of their cloud computer, resets it from one, and only the newest few are kept', async () => {
  const server = await startFakeSandboxServer();
  try {
    // A request the test refuses on purpose fails as a dropped connection, before it reaches the server.
    let refuse: (method: string, url: string) => boolean = () => false;
    const flaky: typeof fetch = (url, init) => (refuse(init?.method ?? 'GET', String(url)) ? Promise.reject(new TypeError('connection reset')) : fetch(url, init));
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key', fetch: flaky });
    const m = machine({ provider, store: memoryStore() });
    const listedNames = async (): Promise<string[]> => ((await (await fetch(`${server.url}/named-snapshots`, { headers: { Authorization: 'Bearer test-key' } })).json()) as { snapshots: { name: string }[] }).snapshots.map((s) => s.name);
    const old = await m.create({ name: 'web', size: 'small', keepCopies: true });
    // Another machine on the same account whose name starts with this one's: its copy is never this one's.
    const other = await provider.create!({ name: 'web-two', size: 'small', keepCopies: true, idempotencyKey: 'other-1' });
    await provider.snapshot!(other, 'x');

    const marker = '/home/user/marker.txt';
    const tailnet = '/etc/tailscale/tailscaled.state';
    await provider.write(old, marker, new TextEncoder().encode('Umer v1'), 0o600);
    server.machine.writeFile(tailnet, new TextEncoder().encode('node-key-1'), 0o600, 'root');
    const saved = await m.snapshot();
    assert.match(saved.id, /^byokit-web-[0-9a-z]{12}$/);
    assert.deepEqual((await m.snapshots()).map((c) => c.id), [saved.id], 'only this machine\'s ready copies are listed');

    // Reset: the old machine stops before the new one starts from the copy, the marker is back,
    // the tailnet identity is kept (same machine), and the old machine is deleted with its copies kept.
    await provider.write(old, marker, new TextEncoder().encode('Umer v2'), 0o600);
    const before = server.requests.length;
    await m.restore(saved.id);
    assert.equal(textOf(server.machine.readFile(marker)!), 'Umer v1');
    assert.equal(textOf(server.machine.readFile(tailnet)!), 'node-key-1');
    assert.notEqual(m.ref?.id, old.id);
    assert.equal(await m.state(), 'on');
    assert.equal(await provider.status(old), 'gone');
    const during = server.requests.slice(before);
    const stopAt = during.findIndex((r) => r.method === 'POST' && r.path === `/sandboxes/${old.id}/stop`);
    const fromAt = during.findIndex((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.ok(stopAt >= 0 && stopAt < fromAt, 'the old machine stops before the new one is made');
    assert.deepEqual(during[fromAt].body, { from: saved.id, snapshots: true, ttlSeconds: null }, 'a restore carries no noEnv');
    assert.ok(!during.some((r) => r.method === 'DELETE' && r.path.startsWith('/named-snapshots/')));
    assert.deepEqual((await m.snapshots()).map((c) => c.id), [saved.id]);

    // A copy that is gone, or another machine's, is a typed refusal with its own sentence.
    const gone = await rejects(m.restore('byokit-web-nope'), 'no-snapshot');
    await rejects(m.restore('byokit-web-two-x'), 'no-snapshot');
    assert.equal(errorWords(gone, { app: 'Umer', label: 'Test' }), 'That saved copy of your cloud computer is gone. Choose another one.');
    assert.equal(
      words('snapshot.restore', { date: saved.at.slice(0, 10) }),
      `Resetting brings your cloud computer back to how it was on ${saved.at.slice(0, 10)}. Everything changed on it since then is lost.`,
    );

    // A second Reset tapped while the first runs is refused before it creates anything.
    const beforeTap = server.requests.length;
    const tapped = m.restore(saved.id);
    await rejects(m.restore(saved.id), 'busy');
    await tapped;
    const tapCreates = server.requests.slice(beforeTap).filter((r) => r.method === 'POST' && r.path === '/sandboxes');
    assert.equal(tapCreates.length, 1, 'only the first reset creates a machine');

    // One save, reset or remove at a time: a remove tapped during a save is refused and changes nothing.
    const savedRef = m.ref;
    const saving = m.snapshot();
    await rejects(m.remove(savedRef!.id), 'busy');
    await saving;
    assert.deepEqual(m.ref, savedRef, 'the store still has the machine');
    assert.equal(await m.state(), 'on');

    // Keep 3 by default: a fourth copy deletes the oldest only after it is ready, and never another machine's.
    for (let i = 0; i < 3; i++) await m.snapshot();
    const kept = await m.snapshots();
    assert.equal(kept.length, 3);
    assert.ok(!kept.some((c) => c.id === saved.id), 'the oldest copy was pruned');
    assert.ok(kept.every((c, i) => i === 0 || Date.parse(kept[i - 1].at) >= Date.parse(c.at)), 'newest first');
    const latest = await m.snapshot({ keep: 1 });
    assert.deepEqual((await m.snapshots()).map((c) => c.id), [latest.id]);
    assert.deepEqual((await listedNames()).sort(), [latest.id, 'byokit-web-two-x'].sort());

    // A prune that fails does not fail the save: the made copy comes back with the error, and the next save prunes.
    refuse = (method, url) => method === 'DELETE' && url.includes('/named-snapshots/');
    const unpruned = await m.snapshot({ keep: 1 });
    refuse = () => false;
    assert.equal(unpruned.pruneError?.code, 'unreachable');
    assert.deepEqual((await m.snapshots()).map((c) => c.id).sort(), [latest.id, unpruned.id].sort());
    const pruned = await m.snapshot({ keep: 1 });
    assert.equal(pruned.pruneError, undefined);
    assert.deepEqual((await m.snapshots()).map((c) => c.id), [pruned.id]);
    await rejects(m.snapshot({ keep: 0 }), 'bad-recipe');

    // The kit's own timer: a copy made while it waits is reported null; each later due tick saves one, in a row.
    await rejects(m.scheduleSnapshots({ everyMs: 0, onResult: () => {} }), 'bad-recipe');
    await rejects(m.scheduleSnapshots({ everyMs: 2_147_483_648, onResult: () => {} }), 'bad-recipe');
    // Each check starts everyMs after the previous one finished, so a copy it made is always due by the next check:
    // no check between two scheduled copies comes back null (a fixed-rate timer skips every other period).
    let skipped = 0;
    const copies = await new Promise<Snapshot[]>((resolve, reject) => {
      const saved: Snapshot[] = [];
      let handle: { stop(): void };
      m.scheduleSnapshots({
        everyMs: 300,
        keep: 1,
        onResult: (r) => {
          if (r instanceof Error) {
            handle.stop();
            reject(r);
            return;
          }
          if (r === null) {
            if (saved.length > 0) skipped += 1;
            return;
          }
          saved.push(r);
          if (saved.length < 2) return;
          handle.stop();
          resolve(saved);
        },
      }).then((h) => { handle = h; }, reject);
    });
    assert.deepEqual((await m.snapshots()).map((c) => c.id), [copies[1].id]);
    assert.equal(skipped, 0, 'no period is skipped between scheduled copies');
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual((await m.snapshots()).map((c) => c.id), [copies[1].id], 'no tick runs after stop()');
    const plain = machine({ provider: fakeProvider(), store: memoryStore() });
    await plain.create({ name: 'web', size: 'small', keepCopies: false });
    await rejects(plain.scheduleSnapshots({ everyMs: 5 }), 'unsupported');

    // Disk space from the machine itself, in plain words; a failed read says so.
    server.machine.script('df', { code: 0, stdout: 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 12582912 3250586 9332326 26% /\n', stderr: '', timedOut: false });
    const disk = await m.disk();
    assert.deepEqual(disk, { usedGb: 3.3, totalGb: 12.9 });
    assert.equal(words('disk.used', { used: String(disk.usedGb), total: String(disk.totalGb) }), '3.3 GB of 12.9 GB used on your cloud computer.');
    server.machine.script('df', { code: 1, stdout: '', stderr: 'df: /: No such file', timedOut: false });
    await rejects(m.disk(), 'provider');

    // A replacement that never comes on is deleted, and the store keeps the machine the person had.
    const oldRef = m.ref;
    assert.ok(oldRef !== null);
    server.nextCreateState('error');
    const beforeFailure = server.requests.length;
    const [latestCopy] = await m.snapshots();
    await rejects(m.restore(latestCopy.id), 'provider');
    assert.equal(m.ref?.id, oldRef.id, 'the store still points at the old machine');
    assert.equal(await provider.status(oldRef), 'asleep', 'the old machine is not deleted');
    const deleted = server.requests.slice(beforeFailure).filter((r) => r.method === 'DELETE' && r.path.startsWith('/sandboxes/')).map((r) => r.path.slice('/sandboxes/'.length));
    assert.equal(deleted.length, 1, 'only the replacement is deleted');
    assert.notEqual(deleted[0], oldRef.id);
    assert.equal(server.getState(deleted[0]), null, 'the replacement is gone');

    // The replacement is saved before the old machine is deleted; when that delete keeps failing, the store
    // already points at the replacement and the error names the old machine, which may still bill.
    const [copyToRestore] = await m.snapshots();
    let refused = 0;
    refuse = (method, url) => {
      if (method !== 'DELETE' || !url.endsWith(`/sandboxes/${oldRef.id}`)) return false;
      refused += 1;
      return true;
    };
    const stuck = await m.restore(copyToRestore.id).then(() => null, (e: MachineError) => e);
    refuse = () => false;
    assert.equal(refused, 4, 'the old delete is tried once and retried three times');
    assert.equal(stuck?.code, 'provider');
    assert.equal(stuck?.extra.sandbox, oldRef.id);
    assert.ok(stuck?.message.includes(oldRef.id) && stuck.message.includes('may still bill'));
    assert.notEqual(m.ref?.id, oldRef.id, 'the store keeps the replacement');
    assert.notEqual(server.getState(oldRef.id), null, 'the old machine is still there');

    // A broken machine cannot be stopped; resetting it skips the stop and builds from the copy.
    const broken = m.ref;
    assert.ok(broken !== null);
    server.setState(broken.id, 'error');
    assert.equal(await m.state(), 'failed');
    const beforeBroken = server.requests.length;
    await m.restore(copyToRestore.id);
    assert.ok(!server.requests.slice(beforeBroken).some((r) => r.path.endsWith('/stop')), 'no stop for a failed machine');
    assert.notEqual(m.ref?.id, broken.id);
    assert.equal(await m.state(), 'on');
    assert.equal(await provider.status(broken), 'gone');

    // Removing this machine deletes its own copies and keeps another machine's copy whose name starts with its name.
    assert.ok((await m.snapshots()).length > 0);
    const live = m.ref;
    assert.ok(live !== null);
    // A schedule running when its machine is removed reports no-machine once and stops itself.
    const orphaned: unknown[] = [];
    let orphanGone: () => void = () => {};
    const orphanStopped = new Promise<void>((r) => { orphanGone = r; });
    await m.scheduleSnapshots({ everyMs: 100, onResult: (r) => {
      orphaned.push(r);
      if (r instanceof MachineError && r.code === 'no-machine') orphanGone();
    } });
    await m.remove(live.id);
    assert.deepEqual(await listedNames(), ['byokit-web-two-x']);
    await orphanStopped;
    const reports = orphaned.length;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(orphaned.length, reports, 'no check runs after the machine is gone');
    assert.equal(orphaned.filter((r) => r instanceof MachineError && r.code === 'no-machine').length, 1);
    await rejects(m.scheduleSnapshots({ everyMs: 10 }), 'no-machine');
  } finally {
    await server.close();
  }

  // A machine without copies, or a provider that keeps none, cannot save or reset.
  const noCopies = machine({ provider: fakeProvider(), store: memoryStore() });
  await noCopies.create({ name: 'web', size: 'small', keepCopies: false });
  await rejects(noCopies.snapshot(), 'unsupported');
  const vm = machine({ provider: fakeProvider({ id: 'ssh-vm' }), store: memoryStore() });
  await vm.create({ name: 'web', size: 'small', keepCopies: false });
  await rejects(vm.snapshots(), 'unsupported');
  await rejects(vm.restore('byokit-web-a'), 'unsupported');

  // Boat keeps 10 copies free; an 11th is saved and billed, and with no credit the save is refused as a spent balance.
  const paid = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: paid.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const p = machine({ provider, store: memoryStore() });
    const ref = await p.create({ name: 'web', size: 'small', keepCopies: true });
    for (let i = 0; i < 10; i++) await provider.snapshot!(ref, `free${i}`);
    const eleventh = await p.snapshot({ keep: 20 });
    assert.equal((await p.snapshots()).length, 11);
    paid.setBalance(0);
    const noCredit = await rejects(p.snapshot({ keep: 20 }), 'balance');
    assert.equal(errorWords(noCredit, { app: 'Umer', label: 'Test' }), 'Your Test balance ran out. Your cloud computer stops in a day unless you add funds.');
    const kept = await p.snapshots();
    assert.equal(kept.length, 11, 'a refused save deletes nothing');
    assert.equal(kept[0].id, eleventh.id);
  } finally {
    await paid.close();
  }
});

test('a replacement that never comes on is deleted with retries, and a delete that keeps failing names it', async () => {
  const server = await startFakeSandboxServer();
  try {
    let refuse: (method: string, url: string) => boolean = () => false;
    const flaky: typeof fetch = (url, init) => (refuse(init?.method ?? 'GET', String(url)) ? Promise.reject(new TypeError('connection reset')) : fetch(url, init));
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key', fetch: flaky });
    const m = machine({ provider, store: memoryStore() });
    await m.create({ name: 'web', size: 'small', keepCopies: true });
    const saved = await m.snapshot();
    const oldRef = m.ref!;
    server.nextCreateState('error');
    const refused: string[] = [];
    refuse = (method, url) => {
      if (method !== 'DELETE' || !url.includes('/sandboxes/')) return false;
      refused.push(new URL(url).pathname);
      return true;
    };
    const stuck = await rejects(m.restore(saved.id), 'provider');
    refuse = () => false;
    const replacement = refused[0].split('/').pop()!;
    assert.equal(refused.length, 4, 'the replacement delete is tried once and retried three times');
    assert.ok(refused.every((p) => p === refused[0]), 'every try deletes the replacement');
    assert.equal(stuck.extra.sandbox, replacement);
    assert.ok(stuck.message.includes(replacement) && stuck.message.includes('may still bill'));
    assert.equal(m.ref?.id, oldRef.id, 'the store keeps the old machine');
    assert.notEqual(server.getState(replacement), null, 'the replacement is still there, and it is named');
    assert.equal(await provider.status(oldRef), 'asleep');
  } finally {
    await server.close();
  }
});

test('two machine objects on one store share its one-at-a-time guard and its record', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    const store = memoryStore();
    const first = machine({ provider, store });
    const second = machine({ provider, store });
    await first.create({ name: 'web', size: 'small', keepCopies: true });
    const saved = await first.snapshot();
    const oldRef = first.ref!;
    assert.equal(second.ref?.id, oldRef.id, 'the second object reads the same machine');

    const saving = first.snapshot();
    await rejects(second.remove(oldRef.id), 'busy');
    await saving;
    assert.notEqual(server.getState(oldRef.id), null, 'the busy remove deleted nothing');

    const reset = first.restore(saved.id);
    await rejects(second.remove(oldRef.id), 'busy');
    await reset;
    assert.notEqual(first.ref?.id, oldRef.id);
    assert.equal(second.ref?.id, first.ref?.id, 'the second object sees the new ref');
    assert.equal(await second.state(), 'on');
    assert.equal(await provider.status(oldRef), 'gone');

    await second.remove(first.ref!.id);
    assert.equal(first.ref, null);
  } finally {
    await server.close();
  }
});

test('an app tells the person what the cloud computer costs and speaks in plain words', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const small: Price = { size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0, currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://boat.test/prices', checked: today };
  const defaultSize: Price = { ...small, size: 'default', perHour: 0.036 };
  const budgetVm: Price = { size: 'vm-small', perMonthCap: 5.99, asleepPerHour: 5.99 / 730, currency: 'EUR', basis: 'list', source: 'http://boat.test/prices', checked: today };
  const mainstreamVm: Price = { size: 'vm-main', perMonthCap: 24, asleepPerHour: 24 / 730, currency: 'USD', basis: 'list', source: 'http://boat.test/prices', checked: today };

  // The four always-on figures, the plan floor while asleep, and the stale-price note.
  assert.deepEqual(
    [estimate(small, { label: 'Boat' }).perMonth, estimate(small, { label: 'Boat' }).floor, estimate(small, { label: 'Boat' }).basis],
    [20, 20, 'list'],
  );
  assert.ok(Math.abs(estimate(defaultSize, { label: 'Boat' }).perMonth - 26.28) < 1e-9);
  assert.deepEqual(
    [estimate(budgetVm, { label: 'Boat' }).perMonth, estimate(budgetVm, { label: 'Boat' }).floor, estimate(budgetVm, { label: 'Boat' }).currency],
    [5.99, null, 'EUR'],
  );
  assert.equal(estimate(mainstreamVm, { label: 'Boat' }).perMonth, 24);
  assert.equal(estimate(small, { label: 'Boat' }).words, "About $20.00 a month, billed by Boat to your own account. {app} doesn't charge for this.");
  assert.equal(estimate(budgetVm, { label: 'Boat' }).words, '€5.99 a month, the price you told us Boat charges you.');
  assert.equal(estimate(small, { label: 'Boat', hoursOn: 240 }).perMonth, 20, 'the plan floor holds while asleep');
  assert.ok(estimate({ ...small, checked: '2020-01-01' }, { label: 'Boat' }).words.endsWith('Price last checked 2020-01-01.'));

  // What the machine itself reports: projected usage, a spent balance, or the app's entered price.
  const usage = fakeProvider({ prices: [small] });
  const um = machine({ provider: usage, store: memoryStore() });
  await um.create({ name: 'web', size: 'small', keepCopies: true });
  const projected = await um.cost();
  assert.equal(projected.basis, 'usage');
  assert.ok(projected.perMonth >= 20, 'projected usage is raised to the floor');
  assert.match(projected.checked, /^\d{4}-\d{2}-\d{2}$/);
  usage.fake.setBalance(0);
  assert.equal((await um.cost()).words, 'Your Fake balance ran out. Your cloud computer stops in a day unless you add funds.');

  const entered = fakeProvider({ usage: false });
  const em = machine({ provider: entered, store: memoryStore({ ref: null, providerKey: '', monthlyEntered: 10 }) });
  await em.create({ name: 'web', size: 'small', keepCopies: true });
  const priced = await em.cost();
  assert.deepEqual([priced.perMonth, priced.basis, priced.currency], [10, 'entered', 'USD']);
  const noPrice = fakeProvider({ usage: false });
  const nm = machine({ provider: noPrice, store: memoryStore() });
  await nm.create({ name: 'web', size: 'small', keepCopies: true });
  await rejects(nm.cost(), 'unsupported');

  // Plain words: every machine and host state has its own slot-free sentence, and every error code too.
  const vars = { app: 'Umer', label: 'Boat' };
  const machineStates = ['creating', 'on', 'asleep', 'waking', 'stopping', 'unknown', 'failed', 'host-key-changed', 'gone'] as const satisfies readonly MachineState[];
  const hostStates = ['not-installed', 'installing', 'running', 'restarting', 'stopped', 'failed'] as const satisfies readonly HostState[];
  const seen = new Set<string>();
  for (const s of machineStates) {
    const w = stateWords(s, vars);
    assert.ok(w.length > 0 && !/\{|\}/.test(w), s);
    seen.add(w);
  }
  assert.equal(seen.size, machineStates.length);
  const hostSeen = new Set<string>();
  for (const s of hostStates) {
    const w = hostWords(s, vars);
    assert.ok(w.length > 0 && !/\{|\}/.test(w), s);
    hostSeen.add(w);
  }
  assert.equal(hostSeen.size, hostStates.length);

  const codes: readonly MachineErrorCode[] = [
    'no-machine', 'exists', 'wrong-account', 'unsupported', 'confirm', 'bad-recipe', 'not-linux', 'linger',
    'host-key', 'unauthorized', 'balance', 'unreachable', 'provider', 'needs-root', 'timeout', 'no-snapshot', 'owner-enrolled',
  ];
  for (const code of codes) {
    const w = errorWords(new MachineError(code, 'detail'), vars);
    assert.ok(w.length > 0 && !/\{|\}/.test(w), code);
  }
  assert.equal(errorWords(new MachineError('unauthorized', 'x'), vars), "Boat didn't accept your key. Make a new one and try again.");
  assert.equal(
    errorWords(new MachineError('needs-root', 'x'), vars),
    'Umer needs admin rights on your cloud computer. Sign in to it with a login that has them.',
  );
  assert.equal(
    errorWords(new MachineError('needs-root', 'x', { command: 'sudo a\nsudo b' }), vars),
    "Umer needs a few setup steps that only your cloud computer's owner can run. Run the lines below on it once, then try again.",
  );

  const now = new Date('2026-09-29T00:00:00.000Z');
  const keyInfo = (expires: string | null): KeyInfo => ({ expires, scopes: [] });
  assert.equal(keyWords(keyInfo(null), { label: 'Boat', now }), null);
  assert.equal(
    keyWords(keyInfo('2026-10-05T00:00:00.000Z'), { label: 'Boat', now }),
    'Your Boat key expires on 2026-10-05. Make a new one to keep your cloud computer working.',
  );
  assert.equal(keyWords(keyInfo('2027-01-01T00:00:00.000Z'), { label: 'Boat', now }), null);

  // Unfilled slots stay visible for the app to fill, and the shipped table carries no jargon at all.
  assert.equal(words('setup.typeCode', { label: 'Boat' }), 'Open the Boat page and type this code: {code}');
  assert.equal(words('setup.typeCode', {}), 'Open the {label} page and type this code: {code}');
  const banned = /\b(oauth|token|api|cli|http|json|error|exception|null|undefined|status|config|env|localhost|\d{3}|gpt-|pi\b|codex|device_code|credential|refresh)|[`$~\/\\]|%/i;
  for (const [k, w] of Object.entries(WORDS)) assert.doesNotMatch(w.replace(/\{\w+\}/g, 'X'), banned, k);
});

test('a connect screen follows setup steps in order and retries a failed install on the saved machine', async () => {
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Boat', prices: prices(), key: async () => 'test-key' });
    const existing = await provider.create!({ name: 'old', size: 'small', keepCopies: true, idempotencyKey: 'seed' });
    const pick = pickId(existing.id);

    // Full happy sequence in order, with install lines and Pair ready: no new rental after selection.
    server.machine.script('npm', { code: 0, stdout: 'installed\n', stderr: '', timedOut: false });
    const lines: string[] = [];
    const steps = await collectSteps(setup({
      provider, store: memoryStore(), recipe: recipe(), pick, confirmId: existing.id,
      onLine: (l) => lines.push(l), pair: async (ref) => { assert.equal(ref.name, 'web'); },
    }));
    assert.deepEqual(steps.map((s) => s.step), ['checking-access', 'listing', 'inspecting', 'installing', 'pairing', 'ready']);
    assert.equal(steps[0].step === 'checking-access' ? steps[0].account : null, 'acct-test');
    assert.deepEqual(steps[1].step === 'listing' ? steps[1].machines.map((r) => r.id) : [], [existing.id]);
    const ready = steps.at(-1);
    assert.ok(ready?.step === 'ready' && ready.ref.name === 'web');
    assert.deepEqual(lines, ['installed']);
    assert.equal(server.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes').length, 1);

    // A failed install names installing with a retryable cause; the retry resumes on the saved ref.
    // A second existing computer with its own app name and directory keeps this leg clear of the first run.
    const existing2 = await provider.create!({ name: 'old-two', size: 'small', keepCopies: true, idempotencyKey: 'seed-two' });
    const retryRecipe = { ...recipe('retry'), workDir: '/home/user/retry' };
    server.machine.script('npm', { code: 1, stdout: '', stderr: 'install refused', timedOut: false });
    const retrying = { provider, store: memoryStore(), recipe: retryRecipe, pick: pickId(existing2.id), confirmId: existing2.id };
    const failed = await collectSteps(setup(retrying));
    assert.deepEqual(failed.map((s) => s.step), ['checking-access', 'listing', 'failed']);
    assert.deepEqual(failed.at(-1), { step: 'failed', at: 'installing', cause: 'state.failed', retryable: true });
    server.machine.script('npm', { code: 1, stdout: '', stderr: 'install refused again', timedOut: false });
    const resumedFailure = await collectSteps(setup(retrying));
    assert.deepEqual(resumedFailure.at(-1), { step: 'failed', at: 'installing', cause: 'state.failed', retryable: true });
    server.machine.script('npm', { code: 0, stdout: '', stderr: '', timedOut: false });
    const resumed = await collectSteps(setup(retrying));
    assert.deepEqual(resumed.map((s) => s.step), ['checking-access', 'listing', 'inspecting', 'installing', 'ready']);
    const reready = resumed.at(-1);
    assert.ok(reready?.step === 'ready' && reready.ref.id === existing2.id && reready.ref.name === 'retry');
    assert.equal(server.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes').length, 2);

    // Guard failures stay inspecting on both fresh and saved computers.
    const refused = await collectSteps(setup({
      provider, store: memoryStore(), recipe: recipe('guarded'), pick: pickId(existing2.id), confirmId: 'wrong-id',
    }));
    assert.deepEqual(refused.at(-1), { step: 'failed', at: 'inspecting', cause: 'error.app', retryable: false });
    const foreign = await collectSteps(setup({
      ...retrying, store: memoryStore({ providerKey: '', ref: { ...reready.ref, account: 'another' } }),
    }));
    assert.deepEqual(foreign.at(-1), { step: 'failed', at: 'inspecting', cause: 'error.wrongAccount', retryable: false });

    // Even a non-Error thrown by an app's install-line callback belongs to installing.
    server.machine.script('npm', { code: 0, stdout: 'installed\n', stderr: '', timedOut: false });
    const callbackFailure = await collectSteps(setup({
      provider, store: memoryStore(), recipe: { ...recipe('callback'), workDir: '/home/user/callback' },
      pick, confirmId: existing.id, onLine: () => { throw null; },
    }));
    assert.deepEqual(callbackFailure.at(-1), { step: 'failed', at: 'installing', cause: 'error.app', retryable: false });
  } finally { await server.close(); }
});

test('a phone with no computer yet rents one through setup, and a retry resumes on it instead of renting another', async () => {
  // Boat's create resolves while the new machine is still provisioning: setup waits for it to come on.
  const server = await startFakeSandboxServer({ slowCreateReads: 2 });
  try {
    const provider = boat({ baseUrl: server.url, label: 'Boat', prices: prices(), key: async () => 'test-key' });
    const rentals = () => server.requests.filter((r) => r.method === 'POST' && r.path === '/sandboxes').length;
    const fresh = { provider, store: memoryStore(), recipe: recipe(), create: { size: 'small', keepCopies: true } };

    server.machine.script('npm', { code: 1, stdout: '', stderr: 'install refused', timedOut: false });
    const failed = await collectSteps(setup(fresh));
    assert.deepEqual(failed.map((s) => s.step), ['checking-access', 'creating', 'failed']);
    const made = failed[1];
    assert.ok(made.step === 'creating' && made.ref.name === 'web' && made.ref.keepCopies);
    assert.equal(words('setup.creating', { label: 'Boat' }), 'Setting up a new cloud computer on your own Boat account. Boat bills you for it.');
    assert.deepEqual(failed.at(-1), { step: 'failed', at: 'installing', cause: 'state.failed', retryable: true });

    server.machine.script('npm', { code: 0, stdout: 'installed\n', stderr: '', timedOut: false });
    const lines: string[] = [];
    const resumed = await collectSteps(setup({ ...fresh, onLine: (l) => lines.push(l) }));
    assert.deepEqual(resumed.map((s) => s.step), ['checking-access', 'creating', 'installing', 'ready']);
    const ready = resumed.at(-1);
    assert.ok(ready?.step === 'ready' && ready.ref.id === made.ref.id);
    assert.deepEqual(lines, ['installed']);
    assert.equal(rentals(), 1);

    // A recipe the kit refuses fails before any rental, so it never bills.
    const refused = await collectSteps(setup({ ...fresh, store: memoryStore(), recipe: { ...recipe('bad'), workDir: 'relative' } }));
    assert.deepEqual(refused.at(-1), { step: 'failed', at: 'creating', cause: 'error.app', retryable: false });
    assert.equal(rentals(), 1);
  } finally { await server.close(); }
});

test('a phone with only its own SSH module deploys onto any SSH box and gives it a private address', async () => {
  // The app's transport stands in for a React Native SSH module: the kit sends it quoted command lines only.
  const transport = fakeSshTransport();
  let pin: string | null = null;
  const pins = { load: async () => pin, save: async (f: string) => { pin = f; } };
  const box = { transport, pins, host: 'box.example', user: 'user', label: 'My server' };
  const provider = sshVm(box);
  const store = memoryStore();
  const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '', timedOut: false });

  // Before the person confirms the server's key, nothing runs on it and setup says why.
  const unpinned = await collectSteps(setup({ provider, store, recipe: recipe(), pick: (l) => l[0], confirmId: 'x' }));
  assert.deepEqual(unpinned.at(-1), { step: 'failed', at: 'listing', cause: 'state.host-key-changed', retryable: false });
  assert.equal(transport.commands.length, 0);
  const first = await sshHostKey(box);
  assert.deepEqual([first.fingerprint, first.pinned], [transport.fingerprint, false]);
  await first.confirm();
  assert.equal((await sshHostKey(box)).pinned, true);

  // Tailscale on the box: already signed in, then serving the app port privately.
  transport.machine.script('npm', ok(''));
  transport.machine.script('tailscale', ok(JSON.stringify({
    BackendState: 'Running', Self: { DNSName: 'box.tail-test.ts.net.' }, TCP: { 7300: { TCPForward: '127.0.0.1:7300' } },
  })));
  const steps = await collectSteps(setup({
    provider, store, recipe: recipe(), pick: (listed) => listed[0], confirmId: first.fingerprint,
    address: { hostname: 'box', port: 7300 },
  }));
  assert.deepEqual(steps.map((s) => s.step), ['checking-access', 'listing', 'inspecting', 'installing', 'securing', 'ready'], JSON.stringify(steps.at(-1)));
  assert.deepEqual(steps[0], { step: 'checking-access', account: 'user@box.example:22' });
  assert.deepEqual(steps[4], { step: 'securing', name: 'box.tail-test.ts.net' });
  const runs = transport.machine.runs.map((r) => r.argv.join(' '));
  assert.ok(runs.includes('tailscale serve --bg --tcp=7300 tcp://127.0.0.1:7300'), 'the app port is served on the tailnet only');
  assert.ok(transport.commands.every((c) => c.startsWith('timeout -k 10 ') || c.startsWith('sudo -n timeout -k 10 ')));

  // A join key never reaches the app's transport.
  const m = machine({ provider, store });
  const sent = transport.commands.length;
  const canary = ['tskey', 'canary', 'not', 'real'].join('-');
  await rejects(m.joinTailnet({ hostname: 'box', authKey: canary }), 'unsupported');
  assert.equal(transport.commands.length, sent);

  // A replaced server is refused, never repinned.
  transport.fingerprint = `SHA256:${'B'.repeat(43)}`;
  assert.equal(await m.state(), 'host-key-changed');
  await rejects(m.host(), 'host-key');
  assert.match(stateWords('host-key-changed', { app: 'Runner', label: 'My server' }), /identity changed. Check with My server/);
  assert.equal(transport.commands.length, sent);
});

test('setup failures name their step: access, pairing, and a provider without listing', async () => {
  const unreachablePick = (): MachineRef => { throw new Error('pick runs only after a listing'); };

  // A wrong key fails checking-access, non-retryable, before any listing or choice.
  const locked = boat({ baseUrl: 'http://boat.test', label: 'Boat', prices: prices(), key: async () => 'test-key',
    fetch: async () => new Response('no', { status: 401 }) });
  assert.deepEqual(
    await collectSteps(setup({ provider: locked, store: memoryStore(), recipe: recipe(), pick: unreachablePick, confirmId: 'x' })),
    [{ step: 'failed', at: 'checking-access', cause: 'error.key', retryable: false }],
  );

  // A lost pairing fails at pairing with a retryable cause, after a finished install.
  const server = await startFakeSandboxServer();
  try {
    const provider = boat({ baseUrl: server.url, label: 'Boat', prices: prices(), key: async () => 'test-key' });
    const existing = await provider.create!({ name: 'old', size: 'small', keepCopies: true, idempotencyKey: 'seed' });
    server.machine.script('npm', { code: 0, stdout: '', stderr: '', timedOut: false });
    const unpaired = await collectSteps(setup({
      provider, store: memoryStore(), recipe: recipe(), pick: pickId(existing.id), confirmId: existing.id,
      pair: async () => { throw new MachineError('unreachable', 'pair lost'); },
    }));
    assert.deepEqual(unpaired.map((s) => s.step), ['checking-access', 'listing', 'inspecting', 'installing', 'failed']);
    assert.deepEqual(unpaired.at(-1), { step: 'failed', at: 'pairing', cause: 'state.unknown', retryable: true });
  } finally { await server.close(); }

  // An SSH VM has no listing: setup reports that instead of inventing computers.
  const ssh = fakeProvider({ id: 'ssh-vm' });
  assert.deepEqual(
    await collectSteps(setup({ provider: ssh, store: memoryStore(), recipe: recipe(), pick: unreachablePick, confirmId: 'x' })),
    [{ step: 'checking-access', account: 'acct-test' }, { step: 'failed', at: 'listing', cause: 'error.app', retryable: false }],
  );

  // No step is emitted before its result: a held access check yields nothing until it answers.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const held: typeof ssh = { ...ssh, account: () => gate.then(() => 'acct-test') };
  const iter = setup({ provider: held, store: memoryStore(), recipe: recipe(), pick: unreachablePick, confirmId: 'x' })[Symbol.asyncIterator]();
  const first = iter.next();
  assert.equal(await Promise.race([first.then(() => 'emitted'), new Promise((r) => setTimeout(() => r('waiting'), 50))]), 'waiting');
  release();
  assert.deepEqual((await first).value, { step: 'checking-access', account: 'acct-test' });
  await iter.return?.(undefined);
});
