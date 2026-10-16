// The launchd half (docs/service-kit.md 4.2): one per-user LaunchAgent, written here because cloud has no
// launchd writer (section 5). Only `launchctl … gui/<uid>…` runs; nothing outside ~/Library/LaunchAgents is written.
// Every file step goes through `exec` too, so an injected exec (a fake) touches no real disk.
import { dirname, join } from 'node:path';
import { userInfo } from 'node:os';
import { WRITE_SHELL, type UnitExec } from '@byokit/cloud/unit';
import { ServiceError } from './errors.ts';
import type { ServiceOptions, ServiceState } from './index.ts';
import { spawnIn } from './linux.ts';

const SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

const spawnExec: UnitExec = spawnIn({ LANG: 'en_US.UTF-8', PATH: SYSTEM_PATH });

const labelOf = (name: string): string => `com.byokit.${name}`;
const plistPath = (name: string): string => join(userInfo().homedir, 'Library/LaunchAgents', `${labelOf(name)}.plist`);
const target = (name: string): string => `gui/${userInfo().uid}/${labelOf(name)}`;

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const str = (s: string): string => `<string>${xml(s)}</string>`;

/** The agent's bytes: ProgramArguments [bin], the caller's env plus a PATH headed by bin's directory (S3). */
function renderPlist(name: string, bin: string, env: Readonly<Record<string, string>>): string {
  const all = Object.hasOwn(env, 'PATH') ? env : { PATH: `${dirname(bin)}:${SYSTEM_PATH}`, ...env };
  const vars = Object.keys(all).sort().map((k) => `\t\t<key>${xml(k)}</key>\n\t\t${str(all[k])}\n`).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n<dict>\n' +
    `\t<key>Label</key>\n\t${str(labelOf(name))}\n` +
    `\t<key>ProgramArguments</key>\n\t<array>\n\t\t${str(bin)}\n\t</array>\n` +
    `\t<key>WorkingDirectory</key>\n\t${str(dirname(bin))}\n` +
    `\t<key>EnvironmentVariables</key>\n\t<dict>\n${vars}\t</dict>\n` +
    '\t<key>RunAtLoad</key>\n\t<true/>\n\t<key>KeepAlive</key>\n\t<true/>\n</dict>\n</plist>\n';
}

/** Run one command; a nonzero exit rejects `provider` with the command and the last of stderr. */
async function run(exec: UnitExec, timeoutMs: number, argv: readonly string[], input?: string): Promise<void> {
  const r = await exec(argv, input === undefined ? { timeoutMs } : { timeoutMs, input: new TextEncoder().encode(input) });
  const shown = argv[0] === 'sh' ? `write ${argv[4]}` : argv.join(' ');
  if (r.code !== 0) throw new ServiceError('provider', `${shown} failed with exit ${r.code}: ${r.stderr.slice(-200)}`);
}

/** `launchctl print` of the agent, or null when launchd has no such service loaded. */
async function print(exec: UnitExec, timeoutMs: number, name: string): Promise<string | null> {
  const r = await exec(['launchctl', 'print', target(name)], { timeoutMs });
  if (r.timedOut) throw new ServiceError('provider', `launchctl print ${target(name)} timed out`);
  return r.code === 0 ? r.stdout : null;
}

export async function install(o: ServiceOptions & { bin: string; env: Readonly<Record<string, string>> }): Promise<void> {
  const exec = o.exec ?? spawnExec;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const path = plistPath(o.name);
  await run(exec, timeoutMs, ['mkdir', '-p', dirname(path)]);
  await run(exec, timeoutMs, ['sh', '-c', WRITE_SHELL, 'sh', path, '644'], renderPlist(o.name, o.bin, o.env));
  // bootstrap refuses a loaded label, so a re-install boots the old one out first and loads the new bytes.
  if (await print(exec, timeoutMs, o.name) !== null) await run(exec, timeoutMs, ['launchctl', 'bootout', target(o.name)]);
  await run(exec, timeoutMs, ['launchctl', 'bootstrap', `gui/${userInfo().uid}`, path]);
  // bootstrap only schedules the RunAtLoad spawn; kickstart returns once it ran, so status reads running next.
  await run(exec, timeoutMs, ['launchctl', 'kickstart', target(o.name)]);
}

export async function uninstall(o: ServiceOptions): Promise<void> {
  const exec = o.exec ?? spawnExec;
  const timeoutMs = o.timeoutMs ?? 10_000;
  if (await print(exec, timeoutMs, o.name) !== null) await run(exec, timeoutMs, ['launchctl', 'bootout', target(o.name)]);
  await run(exec, timeoutMs, ['rm', '-f', plistPath(o.name)]);
}

export async function status(o: ServiceOptions): Promise<ServiceState> {
  const out = await print(o.exec ?? spawnExec, o.timeoutMs ?? 10_000, o.name);
  if (out === null) return { phase: 'not-installed' };
  return /^\s*state = running$/m.test(out) ? { phase: 'running' } : { phase: 'stopped' };
}
