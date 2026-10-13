// machine() (docs/cloud-kit.md section 5). M1 builds the 5.1 checks of every method
// and 5.2-5.5 and 5.7; M3 builds install, update, host, logs and deliver (section 8).
import { MachineError } from './errors.ts';
import { balanceCost, dateOf, enteredCost, monthStartIso, usageCost } from './cost.ts';
import { archOf, nodeInstallArgv, nodePath } from './node.ts';
import { checkRecipe, defaultRange, markerPath, satisfiesRange } from './recipe.ts';
import {
  DELIVER_SHELL, PROBE_SHELL, WORKDIR_SHELL, WRITE_SHELL, renderUnit, systemUnitPath,
  userUnitPath, writeUnitFile, writeUserUnit,
} from './unit.ts';
import type {
  AsleepWhy, Disk, ExecResult, HostRecipe, HostState, Machine, MachineRecord, MachineRef, MachineStore, Plan, Provider,
  Snapshot,
} from './types.ts';

const EXEC_TIMEOUT_MS = 30_000;
/** 8.3 steps 3-5: each installRoot, install and update argv gets 20 minutes. */
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DELIVER_LIMIT = 64 * 1024;
/** 8.3 step 5: a failed step reports the last 2 KB of stderr. */
const STEP_TAIL = 2048;
/** 5.10: copies kept by default, well inside Boat's 10 free per wallet. */
const KEEP = 3;
/** The longest delay a timer accepts; a longer one would fire at once. */
const TIMER_MAX_MS = 2_147_483_647;

const randomBase36 = (n: number): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => '0123456789abcdefghijklmnopqrstuvwxyz'[b % 36]).join('');
};

/** POSIX single-quote quoting, as the adapters quote argv (6.4). */
const shellQuote = (argv: readonly string[]): string =>
  argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');

const feedLines = (text: string, onLine: (line: string) => void): void => {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) onLine(line);
};

type ExecOpts = { timeoutMs: number; root?: boolean; input?: Uint8Array };

type StoreState = { loading: Promise<void> | null; record: MachineRecord | null; busyWith: string | null };
const stores = new WeakMap<MachineStore, StoreState>();

export function machine(o: { provider: Provider; store: MachineStore }): Machine {
  const shared = stores.get(o.store) ?? { loading: null, record: null, busyWith: null };
  stores.set(o.store, shared);
  // host() resolves 'installing' while an install or update of this object is in flight (5.6).
  let installing = false;

  const load = (): Promise<void> => {
    shared.loading ??= o.store.load().then((r) => {
      shared.record = r;
    });
    return shared.loading;
  };
  const current = (): MachineRef | null => shared.record?.ref ?? null;

  const save = async (next: MachineRef | null): Promise<void> => {
    const saved: MachineRecord = { ...(shared.record ?? { providerKey: '' }), ref: next };
    await o.store.save(saved);
    shared.record = saved;
  };

  const checkAccount = async (r: MachineRef | null): Promise<void> => {
    if (r !== null && (r.provider !== o.provider.id || r.account !== (await o.provider.account()))) {
      throw new MachineError('wrong-account', `stored ref belongs to another account than ${o.provider.id}`);
    }
  };

  // 5.1 check order: load; wrong-account; no-machine. The kit never uses, repairs or
  // overwrites a mismatched ref; the app decides.
  const need = async (): Promise<MachineRef> => {
    await load();
    const r = current();
    await checkAccount(r);
    if (r === null) throw new MachineError('no-machine', 'no machine in the store');
    return r;
  };

  const checkPort = (port: number): void => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new MachineError('bad-recipe', `port: must be an integer 1-65535, got ${JSON.stringify(port)}`);
    }
  };

  // 5.10: create, and every retry of it, carries one idempotency key; unreachable only.
  const withKey = async <T>(name: string, run: (idempotencyKey: string) => Promise<T>): Promise<T> => {
    const idempotencyKey = `byokit-${name}-${randomBase36(16)}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await run(idempotencyKey);
      } catch (e) {
        if ((e as { code?: string }).code === 'unreachable' && attempt < 3) continue;
        throw e;
      }
    }
  };

  // 5.10: the kit's own copies of this machine, newest first.
  const listCopies = async (r: MachineRef): Promise<Snapshot[]> => {
    if (o.provider.snapshots === undefined) throw new MachineError('unsupported', 'this provider cannot list saved copies');
    return (await o.provider.snapshots(r)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  };

  const needCopies = (r: MachineRef): void => {
    if (!r.keepCopies) throw new MachineError('unsupported', 'the provider keeps no copies of a machine made without them');
  };

  const checkCount = (field: string, n: number, min: number): void => {
    if (!Number.isInteger(n) || n < min) {
      throw new MachineError('bad-recipe', `${field}: must be an integer >= ${min}, got ${JSON.stringify(n)}`);
    }
  };

  // 5.10: save one copy, confirm it is listed ready, and only then prune past `keep`. A failed
  // prune does not fail the save: the made copy comes back with the error, and the next save prunes again.
  const saveCopy = async (r: MachineRef, keep: number): Promise<Snapshot & { pruneError?: MachineError }> => {
    const { snapshot, snapshots, deleteSnapshot } = o.provider;
    if (snapshot === undefined || snapshots === undefined || deleteSnapshot === undefined) {
      throw new MachineError('unsupported', 'this provider cannot save copies');
    }
    const { name } = await snapshot(r, randomBase36(12));
    const copies = await listCopies(r);
    const made = copies.find((c) => c.id === name);
    if (made === undefined) throw new MachineError('provider', 'the saved copy is not listed as ready');
    let pruneError: MachineError | undefined;
    try {
      for (const old of copies.filter((c) => c.id !== made.id).slice(keep - 1)) await deleteSnapshot(r, old.id);
    } catch (e) {
      pruneError = e as MachineError;
    }
    return pruneError === undefined ? made : { ...made, pruneError };
  };

  // The check and claim run before the first await, so two calls in one tick cannot both pass.
  const exclusive = async <T>(what: string, run: () => Promise<T>): Promise<T> => {
    if (shared.busyWith !== null) throw new MachineError('busy', `${shared.busyWith} of this machine is already running`);
    shared.busyWith = what;
    try {
      return await run();
    } finally {
      shared.busyWith = null;
    }
  };

  // 5.10: the scheduler's tick. Due when the newest copy is at least everyMs old; otherwise null.
  const autoCopy = (everyMs: number, keep: number): Promise<Snapshot | null> => exclusive('a save', async () => {
    const r = await need();
    needCopies(r);
    const [newest] = await listCopies(r);
    if (newest !== undefined && Date.now() - Date.parse(newest.at) < everyMs) return null;
    return saveCopy(r, keep);
  });

  // 8.2 without a recipe: probe for a system unit; exit 0 means a system unit.
  const stopUnit = async (r: MachineRef): Promise<void> => {
    const unit = `byokit-${r.name}.service`;
    let system = false;
    try {
      system = (await o.provider.exec(r, ['test', '-e', `/etc/systemd/system/${unit}`], { timeoutMs: EXEC_TIMEOUT_MS })).code === 0;
    } catch {
      system = false;
    }
    try {
      if (system) await o.provider.exec(r, ['systemctl', 'stop', unit], { timeoutMs: EXEC_TIMEOUT_MS, root: true });
      else await o.provider.exec(r, ['systemctl', '--user', 'stop', unit], { timeoutMs: EXEC_TIMEOUT_MS });
    } catch {
      // A missing unit is ignored, so the host gets SIGTERM and flushes whether or not
      // the provider's stop is a clean OS shutdown (G10).
    }
  };

  // 8.2 without a recipe (`host`, `logs`, `sleep`): the probe decides the unit kind.
  // Unlike stopUnit, a transport failure propagates instead of guessing a kind.
  const probeKind = async (r: MachineRef): Promise<'system' | 'user'> => {
    const unit = `byokit-${r.name}.service`;
    const probe = await o.provider.exec(r, ['test', '-e', `/etc/systemd/system/${unit}`], { timeoutMs: EXEC_TIMEOUT_MS });
    return probe.code === 0 ? 'system' : 'user';
  };

  // 8.2: as the run user. Without `user`, plain `exec`; with `user`,
  // `exec` with `root: true` of `runuser -u <user> -- ...argv`.
  const asRunUser = (r: MachineRef, user: string | undefined, argv: readonly string[], execOpts: ExecOpts): Promise<ExecResult> =>
    user === undefined
      ? o.provider.exec(r, argv, execOpts)
      : o.provider.exec(r, ['runuser', '-u', user, '--', ...argv], { ...execOpts, root: true });

  // 8.2: in workDir, with the node bin dir first on PATH, then as the run user.
  const inWorkDir = (
    r: MachineRef, recipe: HostRecipe, nodeBinDir: string, argv: readonly string[], execOpts: ExecOpts,
  ): Promise<ExecResult> =>
    asRunUser(r, recipe.user, [
      'sh', '-c', WORKDIR_SHELL, 'sh', recipe.workDir, nodeBinDir, ...argv,
    ], execOpts);

  // 8.3 step 2: one probe; Linux, an arch we run on, a systemd line, and the
  // machine user and home. Then the 8.1 machine checks against them.
  const probeMachine = async (r: MachineRef, recipe: HostRecipe): Promise<{
    arch: 'linux-x64' | 'linux-arm64'; machineUser: string; machineHome: string; runHome: string;
  }> => {
    const probed = await o.provider.exec(r, ['sh', '-c', PROBE_SHELL], { timeoutMs: EXEC_TIMEOUT_MS });
    if (probed.code !== 0) {
      throw new MachineError('not-linux', `probe: the machine probe failed with exit ${probed.code}`);
    }
    const [sys = '', unameM = '', systemd = '', machineUser = '', machineHome = ''] =
      probed.stdout.split('\n');
    if (sys !== 'Linux') throw new MachineError('not-linux', `uname -s: expected Linux, got ${JSON.stringify(sys)}`);
    const arch = archOf(unameM);
    if (arch === null) throw new MachineError('not-linux', `uname -m: expected x86_64 or aarch64, got ${JSON.stringify(unameM)}`);
    if (!systemd.includes('systemd')) {
      throw new MachineError('not-linux', `systemd: expected a systemd line, got ${JSON.stringify(systemd)}`);
    }
    if (machineUser === '' || machineHome === '') {
      throw new MachineError('not-linux', 'machine user: the probe did not print a user and home');
    }
    if (recipe.user !== undefined && machineUser === recipe.user) {
      throw new MachineError('bad-recipe', `user: must differ from the machine user ${JSON.stringify(machineUser)}`);
    }
    if (recipe.user !== undefined && machineUser === 'root') {
      throw new MachineError('bad-recipe', 'user: the machine user is root, so no home under /root can be opened to another user safely');
    }
    const runHome = recipe.user === undefined ? machineHome : `${machineHome}/.users/${recipe.user}`;
    if (recipe.workDir !== runHome && !recipe.workDir.startsWith(`${runHome}/`)) {
      throw new MachineError('bad-recipe', `workDir: must live inside the run user's home ${JSON.stringify(runHome)}`);
    }
    return { arch, machineUser, machineHome, runHome };
  };

  // 8.2: root access. The sandbox API always has it; otherwise `sudo -n true`
  // decides (exit 0 means passwordless sudo).
  const hasRoot = async (r: MachineRef): Promise<boolean> => {
    if (o.provider.id === 'sandbox-api') return true;
    const probed = await o.provider.exec(r, ['true'], { timeoutMs: EXEC_TIMEOUT_MS, root: true });
    return probed.code === 0;
  };

  // 8.3 step 3: the `needs-root` refusal. With `user` there is no command (a
  // no-sudo run user needs root on every install and update); with only
  // `installRoot` the extra holds every line plus the marker lines.
  const needsRoot = (recipe: HostRecipe, name: string): MachineError => {
    if (recipe.user !== undefined) {
      return new MachineError('needs-root', `user: installing as ${JSON.stringify(recipe.user)} needs root on the machine`);
    }
    const lines = (recipe.installRoot ?? []).map((argv) => `sudo ${shellQuote(argv)}`);
    lines.push('sudo mkdir -p /var/lib/byokit', `sudo touch ${markerPath(name, recipe)}`);
    return new MachineError('needs-root', 'installRoot: installing needs root on the machine', { command: lines.join('\n') });
  };

  // 8.3 step 3: root steps (G5b, G7), only when the recipe has `installRoot`
  // or `user`. The marker skips them; without root access nothing else runs.
  const rootSteps = async (r: MachineRef, recipe: HostRecipe, name: string, machineHome: string): Promise<void> => {
    if (recipe.installRoot === undefined && recipe.user === undefined) return;
    const marker = markerPath(name, recipe);
    const seen = await o.provider.exec(r, ['test', '-e', marker], { timeoutMs: EXEC_TIMEOUT_MS });
    if (seen.code === 0) return;
    if (!(await hasRoot(r))) throw needsRoot(recipe, name);
    const asRoot = (argv: readonly string[], timeoutMs: number): Promise<ExecResult> =>
      o.provider.exec(r, argv, { timeoutMs, root: true });
    if (recipe.user !== undefined) {
      const usersDir = `${machineHome}/.users`;
      const runHome = `${usersDir}/${recipe.user}`;
      const made = await asRoot(['install', '-d', '-m', '0711', '-o', 'root', '-g', 'root', usersDir], EXEC_TIMEOUT_MS);
      if (made.code !== 0) throw new MachineError('provider', `install -d ${usersDir} failed with exit ${made.code}`);
      const opened = await asRoot(['chmod', 'o+x', machineHome], EXEC_TIMEOUT_MS);
      if (opened.code !== 0) throw new MachineError('provider', `chmod o+x ${machineHome} failed with exit ${opened.code}`);
      const known = await asRoot(['id', '-u', recipe.user], EXEC_TIMEOUT_MS);
      if (known.code !== 0) {
        const added = await asRoot(
          ['useradd', '--system', '--no-create-home', '--home-dir', runHome, '--shell', '/usr/sbin/nologin', recipe.user],
          EXEC_TIMEOUT_MS,
        );
        if (added.code !== 0) {
          throw new MachineError('provider', `useradd ${recipe.user} failed with exit ${added.code}`);
        }
        const homed = await asRoot(['install', '-d', '-m', '0700', '-o', recipe.user, '-g', recipe.user, runHome], EXEC_TIMEOUT_MS);
        if (homed.code !== 0) throw new MachineError('provider', `install -d ${runHome} failed with exit ${homed.code}`);
      }
    }
    for (const argv of recipe.installRoot ?? []) {
      const done = await asRoot(argv, STEP_TIMEOUT_MS);
      if (done.code !== 0) {
        throw new MachineError('provider', `installRoot step ${shellQuote(argv)} failed with exit ${done.code}`);
      }
    }
    const dirMade = await asRoot(['mkdir', '-p', '/var/lib/byokit'], EXEC_TIMEOUT_MS);
    if (dirMade.code !== 0) throw new MachineError('provider', `mkdir -p /var/lib/byokit failed with exit ${dirMade.code}`);
    const marked = await asRoot(['touch', marker], EXEC_TIMEOUT_MS);
    if (marked.code !== 0) throw new MachineError('provider', `touch ${marker} failed with exit ${marked.code}`);
  };

  // 8.3 step 4: Node (G5a), as the run user. The pinned binary, else a machine
  // node inside the range, else the install script. Exit 3 is a checksum
  // mismatch (`bad-recipe`); any other failure is the provider's.
  const resolveNode = async (
    r: MachineRef, recipe: HostRecipe, runHome: string, arch: 'linux-x64' | 'linux-arm64',
  ): Promise<string> => {
    const pinned = nodePath(runHome, recipe.node.version);
    const has = await asRunUser(r, recipe.user, [pinned, '--version'], { timeoutMs: EXEC_TIMEOUT_MS });
    if (has.code === 0 && has.stdout.trim() === `v${recipe.node.version}`) return pinned;
    const range = recipe.node.range ?? defaultRange(recipe.node.version);
    const found = await asRunUser(r, recipe.user, ['sh', '-c', 'command -v node && node --version'], { timeoutMs: EXEC_TIMEOUT_MS });
    if (found.code === 0) {
      const lines = found.stdout.trim().split('\n');
      const version = /^v(\d+\.\d+\.\d+)$/.exec(lines[lines.length - 1].trim())?.[1];
      const path = lines[0].trim();
      if (version !== undefined && path !== '' && satisfiesRange(version, range)) return path;
    }
    const installed = await asRunUser(r, recipe.user, [...nodeInstallArgv(recipe, arch, runHome)], { timeoutMs: STEP_TIMEOUT_MS });
    if (installed.code === 3) {
      throw new MachineError('bad-recipe', `node.sha256: the node ${recipe.node.version} tarball failed its checksum`);
    }
    if (installed.code !== 0) {
      throw new MachineError('provider', `node install failed with exit ${installed.code}: ${installed.stderr.slice(-STEP_TAIL)}`);
    }
    return pinned;
  };

  // 8.3 step 5 tail: each install/update argv in workDir. A non-zero exit
  // rejects `provider` with the step index and the last 2 KB of stderr.
  // `onLine` gets each step's stdout then stderr lines, in order, after it ends.
  const runSteps = async (
    r: MachineRef,
    recipe: HostRecipe,
    nodeBinDir: string,
    steps: readonly (readonly string[])[],
    onLine: ((line: string) => void) | undefined,
    label: 'install' | 'update',
  ): Promise<void> => {
    for (let i = 0; i < steps.length; i++) {
      const done = await inWorkDir(r, recipe, nodeBinDir, steps[i], { timeoutMs: STEP_TIMEOUT_MS });
      if (onLine !== undefined) {
        feedLines(done.stdout, onLine);
        feedLines(done.stderr, onLine);
      }
      if (done.code !== 0) {
        throw new MachineError(
          'provider',
          `${label} step ${i} (${steps[i][0]}) failed with exit ${done.code}`,
          { step: String(i), tail: done.stderr.slice(-STEP_TAIL) },
        );
      }
    }
  };

  // 8.3 step 6: `<workDir>/.byokit/installed.json` with the ref's id at 0600 (G4).
  const writeInstalled = async (r: MachineRef, recipe: HostRecipe): Promise<void> => {
    const bytes = new TextEncoder().encode(JSON.stringify({ id: r.id }));
    const done = await asRunUser(r, recipe.user, ['sh', '-c', WRITE_SHELL, 'sh', `${recipe.workDir}/.byokit/installed.json`, '600'], {
      timeoutMs: EXEC_TIMEOUT_MS, input: bytes,
    });
    if (done.code !== 0) {
      throw new MachineError('provider', `write installed.json failed with exit ${done.code}: ${done.stderr.slice(-200)}`);
    }
  };

  // 8.3 steps 1-5 shared by install and update (update reruns the root steps only
  // when the marker is missing, 8.5), plus the step 5 mkdirs.
  const prepare = async (r: MachineRef, recipe: HostRecipe): Promise<{
    machineUser: string; machineHome: string; node: string; nodeBinDir: string;
  }> => {
    const { arch, machineUser, machineHome, runHome } = await probeMachine(r, recipe);
    await rootSteps(r, recipe, r.name, machineHome);
    const node = await resolveNode(r, recipe, runHome, arch);
    const nodeBinDir = node.slice(0, node.lastIndexOf('/'));
    for (const argv of [
      ['mkdir', '-p', recipe.workDir],
      ['mkdir', '-p', '-m', '0700', `${recipe.workDir}/.byokit`],
    ] as const) {
      const made = await asRunUser(r, recipe.user, [...argv], { timeoutMs: EXEC_TIMEOUT_MS });
      if (made.code !== 0) {
        throw new MachineError('provider', `${argv.join(' ')} failed with exit ${made.code}: ${made.stderr.slice(-200)}`);
      }
    }
    return { machineUser, machineHome, node, nodeBinDir };
  };

  const renderFor = (
    recipe: HostRecipe, machineUser: string, nodeResolved: string,
  ): { kind: 'system' | 'user'; runUser: string; bytes: string } => {
    const kind = o.provider.id === 'sandbox-api' || recipe.user !== undefined ? 'system' : 'user';
    const runUser = recipe.user ?? machineUser;
    // 8.3 step 7 (boot.mjs) is M8's: no adapter has `selfId` before M8.
    if (o.provider.selfId !== undefined) throw new Error('not built: M8');
    return { kind, runUser, bytes: renderUnit(recipe, { kind, runUser, nodePath: nodeResolved, selfId: false }) };
  };

  // 8.3 steps 8-9, system half: the unit file as root, then reload and enable.
  const enableSystemUnit = async (r: MachineRef, name: string, bytes: string): Promise<void> => {
    const unit = `byokit-${name}.service`;
    await writeUnitFile(
      (argv, execOpts) => o.provider.exec(r, argv, execOpts),
      systemUnitPath(name),
      bytes,
      { timeoutMs: EXEC_TIMEOUT_MS, root: true },
    );
    for (const argv of [
      ['systemctl', 'daemon-reload'],
      ['systemctl', 'enable', '--now', unit],
    ] as const) {
      const done = await o.provider.exec(r, [...argv], { timeoutMs: EXEC_TIMEOUT_MS, root: true });
      if (done.code !== 0) {
        throw new MachineError('provider', `${argv.join(' ')} failed with exit ${done.code}: ${done.stderr.slice(-200)}`);
      }
    }
  };

  const self: Machine = {
    get ref(): MachineRef | null {
      return current();
    },

    async create({ name, size, keepCopies }): Promise<MachineRef> {
      await load();
      const existing = current();
      await checkAccount(existing);
      if (existing !== null) throw new MachineError('exists', 'the store already holds a machine');
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
        throw new MachineError('bad-recipe', `name: must match ^[a-z][a-z0-9-]{0,31}$, got ${JSON.stringify(name)}`);
      }
      const sizes = o.provider.sizes();
      if (sizes.length > 0 && !sizes.some((s) => s.id === size)) {
        throw new MachineError('bad-recipe', `size: must be one of ${sizes.map((s) => s.id).join(', ')}, got ${JSON.stringify(size)}`);
      }
      const { create } = o.provider;
      if (create !== undefined) {
        const created = await withKey(name, (idempotencyKey) => create({ name, size, keepCopies, idempotencyKey }));
        await save(created);
        return created;
      }
      // Provider without create (SSH VM): adopt the machine that already exists (5.2 step 4).
      if (keepCopies !== false) throw new MachineError('bad-recipe', 'keepCopies: must be false when the provider has no create');
      if (o.provider.adopt === undefined) throw new MachineError('unsupported', 'this provider cannot adopt a machine');
      const id = await o.provider.adopt();
      const adopted: MachineRef = { provider: o.provider.id, account: await o.provider.account(), id, name, keepCopies: false };
      const s = await o.provider.status(adopted);
      if (s !== 'on') {
        if (s === 'host-key-changed') throw new MachineError('host-key', 'the pinned host key no longer matches');
        throw new MachineError('unreachable', `adopted machine is ${s}, not on`);
      }
      await save(adopted);
      return adopted;
    },

    async state() {
      const r = await need();
      return o.provider.status(r);
    },

    async wake(): Promise<void> {
      const r = await need();
      if (o.provider.wake === undefined) throw new MachineError('unsupported', 'this provider cannot wake a machine');
      if ((await o.provider.status(r)) === 'on') return;
      await o.provider.wake(r);
    },

    async sleep(): Promise<void> {
      const r = await need();
      if (o.provider.sleep === undefined) throw new MachineError('unsupported', 'this provider cannot sleep a machine');
      if (r.keepCopies === false) {
        throw new MachineError('unsupported', 'a stop without copies erases the disk, so the kit never sleeps such a machine');
      }
      await stopUnit(r);
      await o.provider.sleep(r);
    },

    async install(r: HostRecipe, onLine?: (line: string) => void): Promise<void> {
      installing = true;
      try {
        const ref = await need();
        checkRecipe(r, ref.name);
        const { machineUser, machineHome, node } = await prepare(ref, r);
        await runSteps(ref, r, node.slice(0, node.lastIndexOf('/')), r.install, onLine, 'install');
        await writeInstalled(ref, r);
        const { kind, bytes } = renderFor(r, machineUser, node);
        if (kind === 'system') {
          await enableSystemUnit(ref, ref.name, bytes);
        } else {
          await writeUserUnit({
            exec: (argv, execOpts) => o.provider.exec(ref, argv, execOpts),
            home: machineHome, name: ref.name, bytes, machineUser, timeoutMs: EXEC_TIMEOUT_MS,
          });
        }
      } finally {
        installing = false;
      }
    },

    async update(r: HostRecipe): Promise<void> {
      installing = true;
      try {
        const ref = await need();
        checkRecipe(r, ref.name);
        const { machineUser, machineHome, node, nodeBinDir } = await prepare(ref, r);
        // A recipe with no `update` runs the same sequence with no update argv.
        await runSteps(ref, r, nodeBinDir, r.update ?? [], undefined, 'update');
        await writeInstalled(ref, r);
        // Re-render the unit and rewrite it only when its bytes changed (then
        // `daemon-reload`); then restart.
        const { kind, bytes } = renderFor(r, machineUser, node);
        const asRoot = kind === 'system';
        const unitPath = asRoot ? systemUnitPath(ref.name) : userUnitPath(machineHome, ref.name);
        const before = await o.provider.exec(ref, ['cat', unitPath], asRoot
          ? { timeoutMs: EXEC_TIMEOUT_MS, root: true }
          : { timeoutMs: EXEC_TIMEOUT_MS });
        if (!(before.code === 0 && before.stdout === bytes)) {
          await writeUnitFile(
            (argv, execOpts) => o.provider.exec(ref, argv, execOpts),
            unitPath,
            bytes,
            asRoot ? { timeoutMs: EXEC_TIMEOUT_MS, root: true } : { timeoutMs: EXEC_TIMEOUT_MS },
          );
          const reloaded = await o.provider.exec(
            ref,
            asRoot ? ['systemctl', 'daemon-reload'] : ['systemctl', '--user', 'daemon-reload'],
            asRoot ? { timeoutMs: EXEC_TIMEOUT_MS, root: true } : { timeoutMs: EXEC_TIMEOUT_MS },
          );
          if (reloaded.code !== 0) {
            throw new MachineError('provider', `systemctl daemon-reload failed with exit ${reloaded.code}: ${reloaded.stderr.slice(-200)}`);
          }
        }
        const unit = `byokit-${ref.name}.service`;
        const restarted = await o.provider.exec(
          ref,
          asRoot ? ['systemctl', 'restart', unit] : ['systemctl', '--user', 'restart', unit],
          asRoot ? { timeoutMs: EXEC_TIMEOUT_MS, root: true } : { timeoutMs: EXEC_TIMEOUT_MS },
        );
        if (restarted.code !== 0) {
          throw new MachineError('provider', `systemctl restart ${unit} failed with exit ${restarted.code}: ${restarted.stderr.slice(-200)}`);
        }
      } finally {
        installing = false;
      }
    },

    async host(): Promise<HostState> {
      const ref = await need();
      if (installing) return 'installing';
      const kind = await probeKind(ref);
      const asRoot = kind === 'system';
      const unit = `byokit-${ref.name}.service`;
      const shown = await o.provider.exec(
        ref,
        asRoot
          ? ['systemctl', 'show', unit, '-p', 'LoadState,ActiveState,SubState,NRestarts']
          : ['systemctl', '--user', 'show', unit, '-p', 'LoadState,ActiveState,SubState,NRestarts'],
        asRoot ? { timeoutMs: EXEC_TIMEOUT_MS, root: true } : { timeoutMs: EXEC_TIMEOUT_MS },
      );
      if (shown.code !== 0) {
        throw new MachineError('provider', `systemctl show ${unit} failed with exit ${shown.code}: ${shown.stderr.slice(-200)}`);
      }
      // 8.5 rows, in order; the first match wins.
      const fields = new Map<string, string>();
      for (const line of shown.stdout.split('\n')) {
        const eq = line.indexOf('=');
        if (eq > 0) fields.set(line.slice(0, eq), line.slice(eq + 1));
      }
      const active = fields.get('ActiveState') ?? '';
      const sub = fields.get('SubState') ?? '';
      const parsed = Number.parseInt(fields.get('NRestarts') ?? '0', 10);
      const restarts = Number.isInteger(parsed) ? parsed : 0;
      if ((fields.get('LoadState') ?? '') === 'not-found') return 'not-installed';
      if (active === 'active') return 'running';
      if (sub === 'auto-restart' || sub === 'auto-restart-queued') return restarts < 5 ? 'restarting' : 'failed';
      if (active === 'failed') return 'failed';
      if (active === 'activating' || active === 'reloading' || active === 'refreshing') return 'running';
      return 'stopped';
    },

    async logs(lines: number): Promise<string[]> {
      const ref = await need();
      if (!Number.isInteger(lines) || lines < 1) {
        throw new MachineError('bad-recipe', `lines: must be an integer >= 1, got ${JSON.stringify(lines)}`);
      }
      const kind = await probeKind(ref);
      const asRoot = kind === 'system';
      const unit = `byokit-${ref.name}.service`;
      const n = Math.min(lines, 500);
      const shown = await o.provider.exec(
        ref,
        asRoot
          ? ['journalctl', '-u', unit, '-n', String(n), '--no-pager', '-o', 'cat']
          : ['journalctl', '--user', '-u', unit, '-n', String(n), '--no-pager', '-o', 'cat'],
        asRoot ? { timeoutMs: EXEC_TIMEOUT_MS, root: true } : { timeoutMs: EXEC_TIMEOUT_MS },
      );
      if (shown.code !== 0) {
        throw new MachineError('provider', `journalctl ${unit} failed with exit ${shown.code}: ${shown.stderr.slice(-200)}`);
      }
      const out = shown.stdout.split('\n');
      if (out.length > 0 && out[out.length - 1] === '') out.pop();
      return out;
    },

    async url(port: number) {
      const r = await need();
      checkPort(port);
      return o.provider.url?.(r, port) ?? null;
    },

    async cost() {
      const r = await need();
      const today = dateOf(new Date());
      if (o.provider.usage !== undefined) {
        let u;
        try {
          u = await o.provider.usage(r, monthStartIso(new Date()));
        } catch (e) {
          if ((e as { code?: string }).code === 'balance') return balanceCost(o.provider.prices(), { label: o.provider.label, today });
          throw e;
        }
        return usageCost(u, o.provider.prices(), { label: o.provider.label, today });
      }
      const entered = enteredCost(shared.record?.monthlyEntered, o.provider.prices(), { label: o.provider.label, today });
      if (entered === null) throw new MachineError('unsupported', 'no usage and no entered price for this machine');
      return entered;
    },

    remove(confirm: string): Promise<void> {
      return exclusive('a removal', async () => {
        const r = await need();
        if (confirm !== r.id) throw new MachineError('confirm', 'confirm must equal the machine id');
        if (o.provider.remove === undefined) throw new MachineError('unsupported', 'this provider cannot remove a machine');
        await o.provider.remove(r, confirm);
        await save(null);
      });
    },

    async plan(): Promise<Plan | null> {
      await load();
      await checkAccount(current());
      return o.provider.plan?.() ?? null;
    },

    async why(): Promise<AsleepWhy | null> {
      const r = await need();
      const s = await o.provider.status(r);
      if (s !== 'asleep') return null;
      if (o.provider.why !== undefined) {
        try {
          const w = await o.provider.why(r);
          if (w !== null) return w;
        } catch {
          // Skip the rule; why() itself rejects only when state() does.
        }
      }
      if (o.provider.usage !== undefined) {
        try {
          await o.provider.usage(r, monthStartIso(new Date()));
        } catch (e) {
          if ((e as { code?: string }).code === 'balance') return 'out-of-credit';
        }
      }
      if (o.provider.plan !== undefined) {
        try {
          const p = await o.provider.plan();
          if (!p.canStayOn) return 'trial-limit';
        } catch {
          // Skip the rule.
        }
      }
      return 'provider';
    },

    async deliver(r: HostRecipe, file: string, bytes: Uint8Array): Promise<void> {
      const ref = await need();
      checkRecipe(r, ref.name);
      if (!FILE_NAME.test(file)) {
        throw new MachineError('bad-recipe', `file: must match ^[a-z0-9][a-z0-9._-]{0,63}$, got ${JSON.stringify(file)}`);
      }
      if (bytes.length > DELIVER_LIMIT) {
        throw new MachineError('bad-recipe', `bytes: at most ${DELIVER_LIMIT} bytes, got ${bytes.length}`);
      }
      // 5.8: one `exec` as the run user, with `input: bytes`. The file ends at
      // mode 0600 in a 0700 directory, owned by the run user.
      const done = await asRunUser(ref, r.user, ['sh', '-c', DELIVER_SHELL, 'sh', `${r.workDir}/.byokit/inbox`, file], {
        timeoutMs: EXEC_TIMEOUT_MS, input: bytes,
      });
      if (done.code !== 0) {
        throw new MachineError('provider', `deliver ${file} failed with exit ${done.code}: ${done.stderr.slice(-200)}`);
      }
    },

    async snapshots(): Promise<Snapshot[]> {
      return listCopies(await need());
    },

    snapshot(so?: { keep?: number }): Promise<Snapshot & { pruneError?: MachineError }> {
      return exclusive('a save', async () => {
        const r = await need();
        const keep = so?.keep ?? KEEP;
        checkCount('keep', keep, 1);
        needCopies(r);
        return saveCopy(r, keep);
      });
    },

    async scheduleSnapshots({ everyMs, keep = KEEP, onResult }): Promise<{ stop(): void }> {
      checkCount('everyMs', everyMs, 1);
      if (everyMs > TIMER_MAX_MS) throw new MachineError('bad-recipe', `everyMs: must be at most ${TIMER_MAX_MS}, got ${everyMs}`);
      checkCount('keep', keep, 1);
      // A schedule that could never save is refused here, not reported on every tick.
      const r = await need();
      if (o.provider.snapshot === undefined || o.provider.snapshots === undefined || o.provider.deleteSnapshot === undefined) {
        throw new MachineError('unsupported', 'this provider cannot save copies');
      }
      needCopies(r);
      let stopped = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const arm = (): void => {
        timer = setTimeout(() => {
          tick().catch(() => {});
        }, everyMs);
        (timer as unknown as { unref?: () => void }).unref?.();
      };
      // The next check starts once this copy is made, so a copy is never judged before it is everyMs old.
      const tick = async (): Promise<void> => {
        let result: Snapshot | null | Error;
        try {
          result = await autoCopy(everyMs, keep);
        } catch (e) {
          result = e instanceof Error ? e : new Error(String(e));
        }
        const gone = result instanceof MachineError && result.code === 'no-machine';
        if (!stopped && !gone) arm();
        onResult?.(result);
      };
      arm();
      return {
        stop: () => {
          stopped = true;
          clearTimeout(timer);
        },
      };
    },

    restore(id: string): Promise<void> {
      return exclusive('a reset', async () => {
        const r = await need();
        const { restore } = o.provider;
        if (restore === undefined) throw new MachineError('unsupported', 'this provider cannot reset a machine from a copy');
        needCopies(r);
        if (!(await listCopies(r)).some((c) => c.id === id)) {
          throw new MachineError('no-snapshot', 'no ready copy of this machine has that id');
        }
        // The app confirmed; the words say what is lost (`snapshot.restore`). The new ref is
        // saved (through `replaced`) before the adapter deletes the old machine.
        await withKey(r.name, (idempotencyKey) => restore(r, id, { idempotencyKey, replaced: save }));
      });
    },

    async disk(): Promise<Disk> {
      const r = await need();
      const shown = await o.provider.exec(r, ['df', '-P', '-k', '/'], { timeoutMs: EXEC_TIMEOUT_MS });
      // POSIX output: a header, then `<fs> <total 1K-blocks> <used> <available> <capacity> <mount>`.
      const [, total, used] = (shown.stdout.split('\n')[1] ?? '').trim().split(/\s+/).map(Number);
      if (shown.code !== 0 || !Number.isFinite(total) || !Number.isFinite(used)) {
        throw new MachineError('provider', `df / failed with exit ${shown.code}: ${shown.stderr.slice(-200)}`);
      }
      // Decimal GB (bytes / 1e9), as disks are sold and as the words say.
      const gb = (kb: number): number => Math.round((kb * 1024) / 1e8) / 10;
      return { usedGb: gb(used), totalGb: gb(total) };
    },
  };

  return self;
}
