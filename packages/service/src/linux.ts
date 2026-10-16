// The systemd --user half (docs/service-kit.md 4.1), built on cloud's per-user unit writer (section 5):
// no second writer, and cloud's linger rule. Only `systemctl --user` and `loginctl enable-linger` run.
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import { MachineError } from '@byokit/cloud';
import { renderUnit, userUnitPath, writeUserUnit, type UnitExec } from '@byokit/cloud/unit';
import { ServiceError } from './errors.ts';
import type { ServiceOptions, ServiceState } from './index.ts';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Spawn with an env built from nothing (S3): a fixed PATH and the login's runtime dir, which is
 * how `systemctl --user` finds the user manager's bus.
 */
const spawnExec: UnitExec = (argv, o) => new Promise((resolve) => {
  const env = { LANG: 'C.UTF-8', PATH: SYSTEM_PATH, XDG_RUNTIME_DIR: `/run/user/${userInfo().uid}` };
  const child = spawn(argv[0], argv.slice(1), { env, timeout: o.timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout += s; });
  child.stderr.setEncoding('utf8').on('data', (s: string) => { stderr += s; });
  child.on('error', (e) => resolve({ code: 127, stdout, stderr: e.message, timedOut: false }));
  child.on('close', (code, signal) => resolve({ code: code ?? 1, stdout, stderr, timedOut: signal !== null && child.killed }));
  child.stdin.on('error', () => undefined);
  child.stdin.end(o.input);
});

const unitOf = (name: string): string => `byokit-${name}.service`;

/** Run one `systemctl --user` command; a nonzero exit rejects `provider` with the last of stderr. */
async function systemctl(exec: UnitExec, timeoutMs: number, args: readonly string[]): Promise<string> {
  const argv = ['systemctl', '--user', ...args];
  const r = await exec(argv, { timeoutMs });
  if (r.code !== 0) throw new ServiceError('provider', `${argv.join(' ')} failed with exit ${r.code}: ${r.stderr.slice(-200)}`);
  return r.stdout;
}

export async function install(o: ServiceOptions & { bin: string; env: Readonly<Record<string, string>> }): Promise<void> {
  const exec = o.exec ?? spawnExec;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const { homedir: home, username: login } = userInfo();
  const bytes = renderUnit(
    { name: o.name, workDir: dirname(o.bin), run: { argv: [o.bin], env: o.env } },
    { kind: 'user', runUser: login, nodePath: o.bin, selfId: false },
  );
  const unitPath = userUnitPath(home, o.name);
  const had = (await exec(['test', '-f', unitPath], { timeoutMs })).code === 0;
  try {
    await writeUserUnit({ exec, home, name: o.name, bytes, machineUser: login, timeoutMs });
  } catch (e) {
    if (!(e instanceof MachineError)) throw e;
    if (e.code === 'linger') throw new ServiceError('linger', e.message, { detail: { command: e.extra.command ?? '' }, cause: e });
    throw new ServiceError('provider', e.message, { cause: e });
  }
  // enable --now leaves an already running unit alone; a re-install restarts it on the new bytes.
  if (had) await systemctl(exec, timeoutMs, ['restart', unitOf(o.name)]);
}

export async function uninstall(o: ServiceOptions): Promise<void> {
  const exec = o.exec ?? spawnExec;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const path = userUnitPath(userInfo().homedir, o.name);
  if ((await exec(['test', '-f', path], { timeoutMs })).code !== 0) return;
  await systemctl(exec, timeoutMs, ['disable', '--now', unitOf(o.name)]);
  const rm = await exec(['rm', '-f', path], { timeoutMs });
  if (rm.code !== 0) throw new ServiceError('provider', `rm -f ${path} failed with exit ${rm.code}: ${rm.stderr.slice(-200)}`);
  await systemctl(exec, timeoutMs, ['daemon-reload']);
}

export async function status(o: ServiceOptions): Promise<ServiceState> {
  const exec = o.exec ?? spawnExec;
  const out = await systemctl(exec, o.timeoutMs ?? 10_000, ['show', unitOf(o.name), '--property=LoadState,ActiveState,Result']);
  const p = Object.fromEntries(out.trim().split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  if (p.LoadState === 'not-found') return { phase: 'not-installed' };
  if (p.LoadState !== 'loaded') return { phase: 'failed', why: 'load' };
  if (p.ActiveState === 'active') return { phase: 'running' };
  // Restart=always keeps a crashing host in auto-restart (activating) rather than failed.
  if (p.ActiveState === 'failed' || (p.Result !== undefined && p.Result !== 'success')) return { phase: 'failed', why: 'exit' };
  return { phase: 'stopped' };
}
