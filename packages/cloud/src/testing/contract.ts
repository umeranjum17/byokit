// machineContract(): the same assertions run against the fake and each adapter's bench
// (docs/cloud-kit.md 13.3). `make` returns a bench `{ provider, store, fake?, installs? }`;
// `o` is `{ test? } | TestFn`. `installs: false` skips the install-family cases
// (5, 7, 8, 13, 14, 17-19) until M3. A case needing a method the bench's provider lacks
// skips. Cases marked *fake* skip on a bench without `fake`.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { MachineError } from '../errors.ts';
import { machine } from '../machine.ts';
import { nodePath } from '../node.ts';
import { markerPath } from '../recipe.ts';
import { renderUnit } from '../unit.ts';
import type { HostRecipe, Machine, MachineRef, Provider } from '../types.ts';
import { fakeProvider, memoryStore } from './fake-provider.ts';
import type { FakeControl } from './fake-provider.ts';

export type MachineBench = {
  provider: Provider;
  store: { load(): Promise<import('../types.ts').MachineRecord | null>; save(r: import('../types.ts').MachineRecord): Promise<void> };
  fake?: FakeControl;
  installs: boolean;
};

export type MachineContractTestContext = {
  skip: (message?: string) => void;
};

export type TestFn = (
  name: string,
  fn: (t: MachineContractTestContext) => void | Promise<void>,
) => void | Promise<void>;

export function machineContract(make: () => Promise<MachineBench>, o?: { test?: TestFn } | TestFn): void {
  const runTest: TestFn = typeof o === 'function'
    ? o
    : (o?.test ?? ((name, fn) => {
      void nodeTest(name, async (t) => {
        await fn({ skip: (msg) => t.skip(msg) });
      });
    }));

  const sha = (c: string): Record<'linux-x64' | 'linux-arm64', string> => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });
  const recipe = (name: string): HostRecipe => ({
    name,
    node: { version: '24.15.0', sha256: sha('a') },
    install: [['npm', 'ci']],
    run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } },
    workDir: '/home/user/app',
  });
  const variant = (name: string, patch: (r: HostRecipe) => HostRecipe): HostRecipe => patch(recipe(name));

  const createMachine = async (bench: MachineBench): Promise<Machine> => machine({ provider: bench.provider, store: bench.store });

  // A provider without `create` (the SSH VM) adopts the machine that already
  // exists, which needs `keepCopies: false` (5.2 step 4); every other bench
  // creates with copies on.
  const keepCopiesFor = (bench: MachineBench): boolean => bench.provider.create !== undefined;

  const rejectCode = async (p: Promise<unknown>, code: string): Promise<MachineError> => {
    try {
      await p;
    } catch (e) {
      assert.equal((e as MachineError).code, code);
      return e as MachineError;
    }
    assert.fail(`expected rejection with ${code}`);
  };

  runTest('1: create saves the ref, and a second create rejects exists', async () => {
    const bench = await make();
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return;
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    assert.equal(ref.name, 'web');
    assert.deepEqual(m.ref, ref);
    await rejectCode(m.create({ name: 'other', size: 'small', keepCopies: true }), 'exists');
  });

  runTest('2: a ref from another account rejects wrong-account and is not overwritten', async () => {
    const bench = await make();
    const foreign: MachineRef = { provider: bench.provider.id, account: 'acct-other', id: 'sb-x', name: 'web', keepCopies: true };
    const store = memoryStore({ ref: foreign, providerKey: '' });
    const m = machine({ provider: bench.provider, store });
    await rejectCode(m.state(), 'wrong-account');
    assert.deepEqual(await store.load(), { ref: foreign, providerKey: '' });
  });

  runTest('3: every 5.1 no-ref method rejects no-machine', async () => {
    const bench = await make();
    const m = await createMachine(bench);
    const r = recipe('web');
    await rejectCode(m.state(), 'no-machine');
    await rejectCode(m.wake(), 'no-machine');
    await rejectCode(m.sleep(), 'no-machine');
    await rejectCode(m.install(r), 'no-machine');
    await rejectCode(m.update(r), 'no-machine');
    await rejectCode(m.host(), 'no-machine');
    await rejectCode(m.logs(10), 'no-machine');
    await rejectCode(m.url(443), 'no-machine');
    await rejectCode(m.cost(), 'no-machine');
    await rejectCode(m.remove('x'), 'no-machine');
    await rejectCode(m.why(), 'no-machine');
    await rejectCode(m.deliver(r, 'a.txt', new Uint8Array([1])), 'no-machine');
  });

  runTest('4: remove with a wrong confirm rejects confirm and keeps the ref; with the right one clears it', async (t) => {
    const bench = await make();
    if (bench.provider.remove === undefined) return t.skip('no remove method');
    const m = await createMachine(bench);
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    await rejectCode(m.remove('wrong'), 'confirm');
    assert.deepEqual(m.ref, ref);
    await m.remove(ref.id);
    assert.equal(m.ref, null);
  });

  runTest('5: install of a valid recipe ends with host() running and one unit whose bytes equal renderUnit', async (t) => {
    const bench = await make();
    if (!bench.installs) return t.skip('installs off until M3');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    const r = recipe(ref.name);
    await m.install(r);
    assert.equal(await m.host(), 'running');
    if (bench.fake === undefined) return;
    const units = [...bench.fake.machine.units.values()];
    assert.equal(units.length, 1);
    const kind = bench.provider.id === 'sandbox-api' || r.user !== undefined ? 'system' : 'user';
    assert.equal(
      units[0].bytes,
      renderUnit(r, { kind, runUser: bench.fake.machine.user, nodePath: nodePath(bench.fake.machine.home, '24.15.0'), selfId: false }),
    );
  });

  runTest('6: after create, each 8.1 pure rule rejects bad-recipe with no provider call other than account()', async () => {
    const bench = await make();
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return;
    await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    const badRecipes: HostRecipe[] = [
      variant('Web', (r) => r),
      variant('other', (r) => r),
      variant('web', (r) => ({ ...r, workDir: '/home/user/../etc' })),
      variant('web', (r) => ({ ...r, install: [[]] })),
      variant('web', (r) => ({ ...r, run: { ...r.run, argv: ['node', 'a\nb'] } })),
      variant('web', (r) => ({ ...r, run: { ...r.run, env: { API_KEY: 'x' } } })),
      variant('web', (r) => ({ ...r, run: { ...r.run, argv: ['--api-key'] } })),
      variant('web', (r) => ({ ...r, node: { ...r.node, version: '24.x' } })),
      variant('web', (r) => ({ ...r, node: { ...r.node, sha256: sha('z') } })),
      variant('web', (r) => ({ ...r, node: { ...r.node, range: '>=99.0.0' } })),
      variant('web', (r) => ({ ...r, user: 'root' })),
      variant('web', (r) => ({ ...r, run: { ...r.run, argv: [] } })),
    ];
    for (const badRecipe of badRecipes) {
      const before = bench.fake?.calls.length ?? 0;
      await rejectCode(m.install(badRecipe), 'bad-recipe');
      if (bench.fake !== undefined) {
        const fresh = bench.fake.calls.slice(before);
        assert.ok(fresh.length > 0, 'the 5.1 checks still run');
        for (const c of fresh) assert.equal(c.op, 'account', JSON.stringify(badRecipe));
      }
    }
  });

  runTest('7: update restarts the unit', async (t) => {
    const bench = await make();
    if (!bench.installs) return t.skip('installs off until M3');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    await m.install(recipe(ref.name));
    const before = bench.fake?.calls.length ?? 0;
    await m.update({ ...recipe(ref.name), update: [['npm', 'run', 'migrate']] });
    assert.equal(await m.host(), 'running');
    if (bench.fake === undefined) return;
    const fresh = bench.fake.calls.slice(before);
    assert.ok(
      fresh.some((c) => c.op === 'exec' && Array.isArray(c.args[1]) && (c.args[1] as string[]).includes('restart')),
      `update restarts the unit, got ${JSON.stringify(fresh.map((c) => c.op))}`,
    );
  });

  runTest('8: logs(10000) asks for at most 500 lines', async (t) => {
    const bench = await make();
    if (!bench.installs) return t.skip('installs off until M3');
    if (bench.fake === undefined) return t.skip('no observation point without a fake');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    assert.deepEqual(await m.logs(10000), []);
    const journal = [...bench.fake.calls].reverse().find((c) =>
      c.op === 'exec' && Array.isArray(c.args[1]) && (c.args[1] as string[])[0] === 'journalctl');
    assert.ok(journal !== undefined, 'logs runs journalctl');
    const argv = journal.args[1] as string[];
    const n = Number.parseInt(argv[argv.indexOf('-n') + 1], 10);
    assert.ok(Number.isInteger(n) && n <= 500, `at most 500 lines, got ${n}`);
  });

  runTest('9: wake on an on machine calls status and never provider.wake', async (t) => {
    const bench = await make();
    if (bench.provider.wake === undefined) return t.skip('no wake method');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    await m.create({ name: 'web', size: 'small', keepCopies: true });
    const before = bench.fake?.calls.length ?? 0;
    await m.wake();
    if (bench.fake !== undefined) {
      const fresh = bench.fake.calls.slice(before);
      assert.ok(fresh.some((c) => c.op === 'status'), 'wake checks status first');
      assert.deepEqual(fresh.filter((c) => c.op === 'wake'), [], 'no provider.wake when already on');
    }
  });

  runTest('10: sleep with keepCopies false rejects unsupported', async (t) => {
    const bench = await make();
    if (bench.provider.sleep === undefined) return t.skip('no sleep method');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    await m.create({ name: 'web', size: 'small', keepCopies: false });
    await rejectCode(m.sleep(), 'unsupported');
  });

  runTest('11 (fake): without wake, sleep, url and remove, wake/sleep/remove reject unsupported and url resolves null', async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('fake only');
    if (bench.provider.create === undefined) return t.skip('no create');
    const bare = fakeProvider({ wake: false, sleep: false, url: false, remove: false });
    const m = machine({ provider: bare, store: memoryStore() });
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    await rejectCode(m.wake(), 'unsupported');
    await rejectCode(m.sleep(), 'unsupported');
    await rejectCode(m.remove(ref.id), 'unsupported');
    assert.equal(await m.url(443), null);
    void bench;
  });

  runTest('12: cost() returns the section 10 shape with filled label and amount', async () => {
    const bench = await make();
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return;
    await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    const c = await m.cost();
    assert.equal(typeof c.perMonth, 'number');
    assert.ok(c.floor === null || typeof c.floor === 'number');
    assert.ok(c.currency === 'USD' || c.currency === 'EUR');
    assert.ok(c.basis === 'list' || c.basis === 'usage' || c.basis === 'entered');
    assert.match(c.checked, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(c.words.includes(bench.provider.label), 'label is filled');
    assert.doesNotMatch(c.words, /\{amount\}/, 'amount is filled');
    // `cost.vm` (the entered basis, 10.1) holds no `{app}` slot; the sandbox
    // sentence keeps it visible for the app to fill (12).
    if (c.basis !== 'entered') assert.match(c.words, /\{app\}/, 'the app name stays visible for the app to fill');
  });

  runTest('13 (fake): host() maps every 8.5 row', async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('fake only');
    if (!bench.installs) return t.skip('installs off until M3');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined) return t.skip('no create');
    await m.create({ name: 'web', size: 'small', keepCopies: true });
    assert.equal(await m.host(), 'not-installed');
    const show = (ActiveState: string, SubState = 'running', NRestarts = 0): void => {
      bench.fake?.machine.addUnit('web', {
        kind: 'system',
        bytes: '',
        show: { LoadState: 'loaded', ActiveState, SubState, NRestarts },
        enabled: true,
      });
    };
    show('active');
    assert.equal(await m.host(), 'running');
    show('activating', 'start');
    assert.equal(await m.host(), 'running');
    show('reloading', 'reload');
    assert.equal(await m.host(), 'running');
    show('refreshing', 'refresh');
    assert.equal(await m.host(), 'running');
    show('inactive', 'auto-restart', 0);
    assert.equal(await m.host(), 'restarting');
    show('inactive', 'auto-restart-queued', 4);
    assert.equal(await m.host(), 'restarting');
    show('inactive', 'auto-restart', 5);
    assert.equal(await m.host(), 'failed');
    show('inactive', 'auto-restart-queued', 9);
    assert.equal(await m.host(), 'failed');
    show('failed', 'failed');
    assert.equal(await m.host(), 'failed');
    show('inactive', 'dead');
    assert.equal(await m.host(), 'stopped');
    show('deactivating', 'stop');
    assert.equal(await m.host(), 'stopped');
    show('mounting', 'mounted');
    assert.equal(await m.host(), 'stopped');
  });

  runTest('14 (fake): the linger refusal rejects linger with extra.command', async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('fake only');
    if (!bench.installs) return t.skip('installs off until M3');
    void bench;
    const bare = fakeProvider({ id: 'ssh-vm' });
    bare.fake.machine.lingerOk = false;
    const m = machine({ provider: bare, store: memoryStore() });
    await m.create({ name: 'web', size: 'small', keepCopies: false });
    const err = await rejectCode(m.install(recipe('web')), 'linger');
    assert.equal(err.extra.command, 'sudo loginctl enable-linger user');
  });

  runTest('15: plan() resolves the provider plan, or null when the provider has none', async () => {
    const bench = await make();
    const m = await createMachine(bench);
    const p = await m.plan();
    if (bench.fake !== undefined) {
      assert.deepEqual(p, { inTrial: false, trialEndsAt: null, canStayOn: true, checkoutUrl: null });
      const narrow = fakeProvider({ plan: false });
      const m2 = machine({ provider: narrow, store: memoryStore() });
      assert.equal(await m2.plan(), null);
    } else {
      assert.ok(p === null || typeof p === 'object');
    }
  });

  runTest('16 (fake): why() is null when on, and each 5.7 rule in order when asleep', async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('fake only');
    if (bench.provider.create === undefined) return t.skip('no create');
    const m = await createMachine(bench);
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    assert.equal(await m.why(), null);
    bench.fake.setState(ref.id, 'asleep');
    bench.fake.setWhy('you');
    assert.equal(await m.why(), 'you');
    bench.fake.setWhy(null);
    bench.fake.setBalance(0);
    assert.equal(await m.why(), 'out-of-credit');
    bench.fake.setBalance(null);
    bench.fake.setPlan({ inTrial: true, trialEndsAt: null, canStayOn: false, checkoutUrl: null });
    assert.equal(await m.why(), 'trial-limit');
    bench.fake.setPlan({ inTrial: false, trialEndsAt: null, canStayOn: true, checkoutUrl: null });
    assert.equal(await m.why(), 'provider');
  });

  runTest('17: deliver writes one file at mode 0600 under <workDir>/.byokit/inbox/, and rejects a bad name or 64 KB + 1', async (t) => {
    const bench = await make();
    if (!bench.installs) return t.skip('installs off until M3');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    const r = recipe(ref.name);
    const bytes = new TextEncoder().encode('owner-key');
    await m.deliver(r, 'owner-key.txt', bytes);
    await rejectCode(m.deliver(r, 'Bad name.txt', bytes), 'bad-recipe');
    await rejectCode(m.deliver(r, 'big.bin', new Uint8Array(64 * 1024 + 1)), 'bad-recipe');
    if (bench.fake === undefined) return;
    const file = bench.fake.machine.files.get('/home/user/app/.byokit/inbox/owner-key.txt');
    assert.ok(file !== undefined, 'the file lands in the inbox');
    assert.equal(file.mode, 0o600);
    assert.equal(file.owner, bench.fake.machine.user);
    assert.deepEqual(file.bytes, bytes);
  });

  runTest('18 (fake): without root access, installRoot and user reject needs-root; with the marker, install runs no root step', async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('fake only');
    if (!bench.installs) return t.skip('installs off until M3');
    void bench;
    const noroot = fakeProvider({ id: 'ssh-vm', root: false });
    const m = machine({ provider: noroot, store: memoryStore() });
    await m.create({ name: 'web', size: 'small', keepCopies: false });
    const withRoot = { ...recipe('web'), installRoot: [['apt-get', 'install', '-y', 'foo']] };
    const refused = await rejectCode(m.install(withRoot), 'needs-root');
    assert.equal(
      refused.extra.command,
      `sudo 'apt-get' 'install' '-y' 'foo'\nsudo mkdir -p /var/lib/byokit\nsudo touch ${markerPath('web', withRoot)}`,
    );
    const withUser = { ...recipe('web'), user: 'appbot', workDir: '/home/user/.users/appbot/app' };
    const refusedUser = await rejectCode(m.install(withUser), 'needs-root');
    assert.ok(!('command' in refusedUser.extra), 'a no-sudo run user carries no command');
    assert.equal(noroot.fake.machine.units.size, 0);
    assert.equal(noroot.fake.machine.files.size, 0);
    for (const run of noroot.fake.machine.runs) {
      assert.ok(
        run.argv[0] === 'true' || run.argv[0] === 'test' || run.argv[0] === 'sh' || (run.argv[0] as string).endsWith('/bin/node'),
        `no other step ran, got ${JSON.stringify(run.argv)}`,
      );
    }
    const rooted = fakeProvider({ id: 'ssh-vm' });
    const m2 = machine({ provider: rooted, store: memoryStore() });
    await m2.create({ name: 'web', size: 'small', keepCopies: false });
    rooted.fake.machine.writeFile(markerPath('web', withRoot), new Uint8Array(), 0o644);
    await m2.install(withRoot);
    assert.deepEqual(
      rooted.fake.machine.runs.filter((run) =>
        run.argv[0] === 'useradd' || run.argv[0] === 'install' || run.argv.includes('apt-get')),
      [],
      'with the marker, install runs no root step',
    );
    assert.equal(await m2.host(), 'running');
  });

  runTest('19: install writes installed.json with the ref id', async (t) => {
    const bench = await make();
    if (!bench.installs) return t.skip('installs off until M3');
    const m = await createMachine(bench);
    if (bench.provider.create === undefined && bench.provider.adopt === undefined) return t.skip('no create or adopt');
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: keepCopiesFor(bench) });
    await m.install(recipe(ref.name));
    if (bench.fake === undefined) return;
    const raw = bench.fake.machine.files.get('/home/user/app/.byokit/installed.json');
    assert.ok(raw !== undefined, 'installed.json is written');
    assert.equal(raw.mode, 0o600);
    assert.deepEqual(JSON.parse(Buffer.from(raw.bytes).toString('utf8')), { id: ref.id });
  });

  runTest('20 (fake): sleep stops the unit before provider.sleep, and succeeds when the unit is missing', async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('fake only');
    if (bench.provider.sleep === undefined) return t.skip('no sleep method');
    if (bench.provider.create === undefined) return t.skip('no create');
    const m = await createMachine(bench);
    const ref = await m.create({ name: 'web', size: 'small', keepCopies: true });
    const before = bench.fake.calls.length;
    await m.sleep();
    const fresh = bench.fake.calls.slice(before);
    const ops = fresh.map((c) => c.op);
    const probe = ops.indexOf('exec');
    const sleep = ops.indexOf('sleep');
    assert.ok(probe >= 0 && sleep > probe, `probe then stop then sleep, got ${JSON.stringify(ops)}`);
    const stop = fresh.find((c) => c.op === 'exec' && Array.isArray(c.args[1]) && (c.args[1] as string[])[0] === 'systemctl');
    assert.deepEqual((stop?.args[1] as string[]), ['systemctl', '--user', 'stop', `byokit-${ref.name}.service`]);
    assert.ok(sleep > fresh.indexOf(stop as (typeof fresh)[number]), 'the unit stops before provider.sleep');
  });
}
