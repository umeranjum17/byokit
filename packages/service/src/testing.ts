// `./testing` entry (Node only, docs/service-kit.md S8/A1): one fake `ServiceExec` — a small
// in-memory systemd --user — and the one contract suite that runs the same assertions against
// it and against the real Linux manager (the service-linux CI journey).
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { userInfo } from 'node:os';
import { dirname } from 'node:path';
import { renderUnit } from '@byokit/cloud/unit';
import type { ExecResult } from '@byokit/cloud';
import type { ServiceOptions, ServiceExec, ServiceState } from './index.ts';
import { ServiceError } from './errors.ts';

/** One recorded command: what ran, how many stdin bytes it took, and its exit. */
export type FakeRun = { argv: readonly string[]; inputBytes: number; code: number };

/** The `show` fields `status` reads; `setShow` forces them. */
export type FakeShow = { LoadState: string; ActiveState: string; Result: string };

/**
 * FakeSystemd: an in-memory stand-in for the per-user manager and its unit file. It answers
 * exactly the commands the kit runs (`mkdir -p`, cloud's WRITE_SHELL, `loginctl enable-linger`,
 * `systemctl --user …`, `test -f`, `rm -f`) through the `exec` seam, so the whole journey runs
 * with no real manager and nothing on disk. `lingerOk` models a polkit refusal; `fail` makes
 * every argv starting with its argv0 fail until cleared.
 */
export class FakeSystemd {
  readonly exec: ServiceExec = (argv, o) => this.run(argv, o.input);
  readonly runs: FakeRun[] = [];
  files = new Map<string, { bytes: Uint8Array; mode: number }>();
  /** `loginctl enable-linger` succeeds; false models the polkit refusal (spec 5). */
  lingerOk = true;
  linger = false;
  fail: { argv0: string; code: number; stderr: string } | null = null;
  private units = new Map<string, FakeShow>();

  /** The unit bytes install wrote, or null. */
  unitBytes(name: string): string | null {
    const path = this.pathOf(name);
    return path === undefined ? null : new TextDecoder().decode(this.files.get(path)?.bytes);
  }

  /** Force the show fields a later `status` reads (a real host is made to fail differently). */
  setShow(name: string, fields: Partial<FakeShow>): void {
    this.units.set(name, { LoadState: 'loaded', ActiveState: 'inactive', Result: 'success', ...this.units.get(name), ...fields });
  }

  private pathOf(name: string): string | undefined {
    return [...this.files.keys()].find((p) => p.endsWith(`/.config/systemd/user/byokit-${name}.service`));
  }

  private async run(argv: readonly string[], input?: Uint8Array): Promise<ExecResult> {
    const done = (code: number, stdout = '', stderr = ''): ExecResult => {
      this.runs.push({ argv, inputBytes: input?.byteLength ?? 0, code });
      return { code, stdout, stderr, timedOut: false };
    };
    const [cmd, ...rest] = argv;
    if (this.fail !== null && cmd === this.fail.argv0) return done(this.fail.code, '', this.fail.stderr);
    switch (cmd) {
      case 'test':
        return done(rest[0] === '-f' && this.files.has(rest[1]) ? 0 : 1);
      case 'rm':
        this.files.delete(rest[1]);
        return done(0);
      case 'mkdir':
        return done(0);
      case 'sh': // cloud's WRITE_SHELL: ['sh', '-c', WRITE_SHELL, 'sh', path, '644'] with the bytes on stdin
        this.files.set(argv[4], { bytes: input ?? new Uint8Array(), mode: 0o644 });
        return done(0);
      case 'loginctl':
        if (rest[0] !== 'enable-linger') return done(127, '', `${cmd}: unknown command`);
        if (!this.lingerOk) return done(1, '', 'Failed to enable linger: Access denied');
        this.linger = true;
        return done(0);
      case 'systemctl': {
        if (rest[0] !== '--user') return done(1, '', 'systemctl: only --user is allowed here');
        const args = rest.slice(1);
        const name = (rest.find((a) => a.endsWith('.service')) ?? '').slice('byokit-'.length, -'.service'.length);
        if (args[0] === 'daemon-reload') return done(0);
        if (args[0] === 'enable' || args[0] === 'restart') {
          this.setShow(name, { LoadState: 'loaded', ActiveState: 'active', Result: 'success' });
          return done(0);
        }
        if (args[0] === 'disable') {
          this.setShow(name, { ActiveState: 'inactive' });
          return done(0);
        }
        if (args[0] === 'show') {
          if (this.pathOf(name) === undefined) return done(0, 'LoadState=not-found\n');
          const u = this.units.get(name) ?? { LoadState: 'loaded', ActiveState: 'inactive', Result: 'success' };
          return done(0, `LoadState=${u.LoadState}\nActiveState=${u.ActiveState}\nResult=${u.Result}\n`);
        }
        return done(127, '', `systemctl --user: unknown command ${String(args[0])}`);
      }
      default:
        return done(127, '', `${String(cmd)}: not found`);
    }
  }
}

/** One bench for the contract: the kit surface over one exec, plus the fake when it is one. */
export type ServiceBench = {
  /** An absolute path to a real executable file (checkBin stats it; the real manager runs it). */
  bin: string;
  service: {
    install(o: ServiceOptions): Promise<void>;
    status(o: ServiceOptions): Promise<ServiceState>;
    uninstall(o: ServiceOptions): Promise<void>;
  };
  /** The FakeSystemd behind the bench, absent on a real manager. */
  fake?: FakeSystemd;
  dispose?(): void;
};

export type ContractTest = (
  name: string,
  fn: (t: { skip(message?: string): void }) => void | Promise<void>,
) => void;

/**
 * serviceContract(label, make, o?): the docs/service-kit.md 8 contract — the same assertions
 * against every bench. Cases marked (fake) need the fake's observation points and skip on a
 * real manager; everything else runs against both.
 */
export function serviceContract(
  label: string,
  make: () => ServiceBench | Promise<ServiceBench>,
  o?: { test?: ContractTest } | ContractTest,
): void {
  const runTest: ContractTest = typeof o === 'function'
    ? o
    : (name, fn) => {
      void nodeTest(name, async (t) => {
        await fn({ skip: (message) => t.skip(message) });
      });
    };

  const name = 'contract-echo';
  const env = { TRACKER_PORT: '4400' };

  const rejectCode = async (p: Promise<unknown>, code: string): Promise<ServiceError> => {
    try {
      await p;
    } catch (e) {
      assert.ok(e instanceof ServiceError, `a ServiceError, got ${String(e)}`);
      assert.equal(e.code, code);
      return e;
    }
    assert.fail(`expected rejection with ${code}`);
  };

  runTest(`${label} 1: status of a missing service resolves not-installed and uninstall resolves`, async () => {
    const bench = await make();
    try {
      assert.deepEqual(await bench.service.status({ name }), { phase: 'not-installed' });
      if (bench.fake === undefined) {
        await bench.service.uninstall({ name }); // idempotent: a missing service resolves
        return;
      }
      assert.equal(bench.fake.unitBytes(name), null, 'nothing was written');
      const before = bench.fake.runs.length;
      await bench.service.uninstall({ name }); // idempotent: a missing service resolves
      assert.deepEqual(
        bench.fake.runs.slice(before).filter((r) => r.argv[0] === 'systemctl' || r.argv[0] === 'loginctl'),
        [],
        'no manager command ran',
      );
    } finally {
      await bench.service.uninstall({ name }).catch(() => undefined);
      bench.dispose?.();
    }
  });

  runTest(`${label} 2: install ends running, a re-install keeps it running, uninstall returns not-installed`, async () => {
    const bench = await make();
    try {
      await bench.service.install({ name, bin: bench.bin, env });
      assert.deepEqual(await bench.service.status({ name }), { phase: 'running' });
      await bench.service.install({ name, bin: bench.bin, env }); // a rewrite and restart, not a duplicate
      assert.deepEqual(await bench.service.status({ name }), { phase: 'running' });
      if (bench.fake === undefined) return;
      assert.equal(
        bench.fake.unitBytes(name),
        renderUnit(
          { name, workDir: dirname(bench.bin), run: { argv: [bench.bin], env } },
          { kind: 'user', runUser: '', nodePath: bench.bin, selfId: false },
        ),
        'the unit bytes are cloud renderer bytes',
      );
      const ops = bench.fake.runs.filter((r) => r.argv[0] === 'systemctl')
        .map((r) => r.argv.slice(r.argv.indexOf('--user') + 1).join(' '));
      assert.equal(ops.filter((op) => op === `restart byokit-${name}.service`).length, 1, 'the re-install restarts once');
      assert.equal(ops.filter((op) => op === `enable --now byokit-${name}.service`).length, 2, 'each install enables');
      assert.ok(bench.fake.runs.some((r) => r.argv[0] === 'loginctl' && r.argv[1] === 'enable-linger'), 'linger enabled');
      await bench.service.uninstall({ name });
      assert.deepEqual(await bench.service.status({ name }), { phase: 'not-installed' });
    } finally {
      await bench.service.uninstall({ name }).catch(() => undefined);
      bench.dispose?.();
    }
  });

  runTest(`${label} 3: a bad name, a relative bin and a missing bin reject before anything runs`, async () => {
    const bench = await make();
    try {
      await rejectCode(bench.service.install({ name: 'Bad', bin: bench.bin }), 'bad-name');
      await rejectCode(bench.service.status({ name: 'Bad' }), 'bad-name');
      await rejectCode(bench.service.uninstall({ name: 'Bad' }), 'bad-name');
      await rejectCode(bench.service.install({ name, bin: 'rel/echo' }), 'bad-bin');
      await rejectCode(bench.service.install({ name, bin: '/nonexistent/byokit-echo' }), 'missing-bin');
      if (bench.fake === undefined) return;
      assert.deepEqual(bench.fake.runs, [], 'no command ran');
      assert.equal(bench.fake.unitBytes(name), null, 'nothing was written');
    } finally {
      bench.dispose?.();
    }
  });

  runTest(`${label} 4 (fake): install runs the spec 4.1 order, --user only, and never sudo`, async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('needs the fake bench');
    try {
      await bench.service.install({ name, bin: bench.bin, env });
      const shape = bench.fake.runs.map((r) => [
        r.argv[0],
        r.argv[1] === '-c' ? 'write' : r.argv[1],
        r.argv[0] === 'systemctl' ? r.argv.slice(2).join(' ') : '',
      ]);
      assert.deepEqual(shape, [
        ['test', '-f', ''],
        ['mkdir', '-p', ''],
        ['sh', 'write', ''],
        ['loginctl', 'enable-linger', ''],
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', `enable --now byokit-${name}.service`],
      ], `the 4.1 order, got ${JSON.stringify(bench.fake.runs.map((r) => r.argv))}`);
      assert.ok(bench.fake.runs.find((r) => r.argv[0] === 'sh')?.inputBytes ?? 0 > 0, 'the unit bytes ride the write');
      assert.deepEqual(bench.fake.runs.filter((r) => r.argv[0] === 'sudo'), [], 'never sudo');
    } finally {
      await bench.service.uninstall({ name }).catch(() => undefined);
      bench.dispose?.();
    }
  });

  runTest(`${label} 5 (fake): status maps every manager state row`, async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('needs the fake bench');
    try {
      await bench.service.install({ name, bin: bench.bin, env });
      const fake = bench.fake;
      assert.deepEqual(await bench.service.status({ name }), { phase: 'running' });
      fake.setShow(name, { ActiveState: 'inactive' });
      assert.deepEqual(await bench.service.status({ name }), { phase: 'stopped' });
      fake.setShow(name, { ActiveState: 'failed' });
      assert.deepEqual(await bench.service.status({ name }), { phase: 'failed', why: 'exit' });
      fake.setShow(name, { ActiveState: 'inactive', Result: 'exit-code' });
      assert.deepEqual(await bench.service.status({ name }), { phase: 'failed', why: 'exit' });
      fake.setShow(name, { LoadState: 'bad-setting', ActiveState: 'failed' });
      assert.deepEqual(await bench.service.status({ name }), { phase: 'failed', why: 'load' });
      fake.files.clear();
      assert.deepEqual(await bench.service.status({ name }), { phase: 'not-installed' });
    } finally {
      await bench.service.uninstall({ name }).catch(() => undefined);
      bench.dispose?.();
    }
  });

  runTest(`${label} 6 (fake): a failing command rejects provider with the command and the end of stderr`, async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('needs the fake bench');
    try {
      bench.fake.fail = { argv0: 'systemctl', code: 1, stderr: 'x'.repeat(300) };
      const err = await rejectCode(bench.service.install({ name, bin: bench.bin, env }), 'provider');
      assert.match(err.message, /daemon-reload failed with exit 1/);
      assert.ok(err.message.endsWith('x'.repeat(200)), 'the last 200 characters of stderr');
    } finally {
      if (bench.fake !== undefined) bench.fake.fail = null;
      await bench.service.uninstall({ name }).catch(() => undefined);
      bench.dispose?.();
    }
  });

  runTest(`${label} 7 (fake): a refused linger rejects linger with the line to run and nothing escalates`, async (t) => {
    const bench = await make();
    if (bench.fake === undefined) return t.skip('needs the fake bench');
    try {
      bench.fake.lingerOk = false;
      const err = await rejectCode(bench.service.install({ name, bin: bench.bin, env }), 'linger');
      assert.equal(err.detail.command, `sudo loginctl enable-linger ${userInfo().username}`);
      assert.deepEqual(bench.fake?.runs.filter((r) => r.argv[0] === 'sudo'), [], 'nothing escalated');
      assert.ok(bench.fake?.unitBytes(name) !== null, 'the unit file is written before enable-linger (4.1)');
    } finally {
      await bench.service.uninstall({ name }).catch(() => undefined);
      bench.dispose?.();
    }
  });
}
