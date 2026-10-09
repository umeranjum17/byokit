// Consumer journeys for the published @byokit/cloud surface (the built package exports), driven the
// way an app uses it: rent a cloud computer on the person's own provider account, install the app's
// host on it, supervise it to running, drive the Boat provider over its real HTTP API, and tell the
// person what it costs in plain words. Every security and correctness contract the removed unit and
// fake-provider cases held survives as an assertion inside a journey: a deliver can never escape into
// a root-owned path, a staged write is 0600, a recipe with a secret or an unsafe path is refused, an
// installRoot step runs once behind its marker, a machine without root is refused rather than
// half-installed, a rejected key never appears in an error, and a delete removes only the kit's own
// snapshots. The provider is the kit's own bench (in-memory fake, loopback fake server); no network,
// key or real machine is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  machine, boat, estimate, words, stateWords, hostWords, errorWords, keyWords, WORDS, MachineError,
} from '@byokit/cloud';
import type {
  HostRecipe, MachineErrorCode, MachineState, HostState, Price, KeyInfo,
} from '@byokit/cloud';
import { fakeProvider, memoryStore, startFakeSandboxServer } from '@byokit/cloud/testing';

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
    assert.deepEqual(await provider.key!(), { expires: null, scopes: [] });
    server.setBalance(0);
    await assert.rejects(provider.usage!(ref, '2026-09-01T00:00:00.000Z'), /balance/);

    // plan maps the trial answer, and why maps every stop reason (or null without one).
    server.setPlan({ trialEndsAt: '2026-10-06', canStayOn: false, checkoutUrl: 'http://boat.test/checkout' });
    assert.deepEqual(await provider.plan!(), { inTrial: false, trialEndsAt: '2026-10-06', canStayOn: false, checkoutUrl: 'http://boat.test/checkout' });
    const reasons: Array<[string, string]> = [['user', 'you'], ['balance', 'out-of-credit'], ['trial', 'trial-limit'], ['idle', 'idle'], ['strange', 'provider']];
    for (const [raw, mapped] of reasons) {
      server.setStopReason(raw);
      server.setState(ref.id, 'ready');
      await provider.sleep!(ref);
      assert.equal(await provider.why!(ref), mapped, raw);
    }
    server.setStopReason(null);
    server.setState(ref.id, 'ready');
    await provider.sleep!(ref);
    assert.equal(await provider.why!(ref), null);

    // remove confirms with the id header, waits out the deletion, and deletes only the kit's snapshots.
    await provider.snapshot!(ref, 'a');
    await provider.snapshot!({ ...ref, name: 'other' }, 'x');
    await m.remove(ref.id);
    assert.equal(server.requests.find((r) => r.method === 'DELETE' && r.path === `/sandboxes/${ref.id}`)?.headers['x-delete-confirmation'], ref.id);
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
  } finally {
    await failing.close();
  }

  // A key that expires soon is mapped from the provider route.
  const keyed = await startFakeSandboxServer({ keyExpiresAt: '2027-01-01', keyScopes: ['read', 'resume'] });
  try {
    const provider = boat({ baseUrl: keyed.url, label: 'Test', prices: prices(), key: async () => 'test-key' });
    assert.deepEqual(await provider.key!(), { expires: '2027-01-01', scopes: ['read', 'resume'] });
  } finally {
    await keyed.close();
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
    'host-key', 'unauthorized', 'balance', 'unreachable', 'provider', 'needs-root', 'timeout',
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
