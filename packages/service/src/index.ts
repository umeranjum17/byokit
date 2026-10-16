// `@byokit/service` — per-user autostart of an app's host companion on the person's own computer
// (docs/service-kit.md). Node only: it spawns the OS's per-user service manager. Linux is
// systemd --user (linux.ts); macOS is a per-user LaunchAgent (macos.ts); every other platform is unsupported.
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { UnitExec } from '@byokit/cloud/unit';
import { ServiceError } from './errors.ts';
import * as linux from './linux.ts';
import * as macos from './macos.ts';

/** The command runner: argv in, exit code and output out (cloud's unit seam). */
export type ServiceExec = UnitExec;

export type ServiceOptions = {
  name: string;                                    // S6
  bin?: string;                                    // absolute; required by install, ignored by status/uninstall
  env?: Readonly<Record<string, string>>;          // the unit's whole environment besides PATH (S3)
  exec?: ServiceExec;                              // injectable command runner; defaults to a local spawn
  timeoutMs?: number;                              // per command; defaults to 10_000
};

export type ServiceState = {
  phase: 'running' | 'stopped' | 'not-installed' | 'failed' | 'unsupported';
  why?: 'load' | 'exit';                           // only for 'failed'
};

export { ServiceError } from './errors.ts';
export type { ServiceErrorCode } from './errors.ts';
export { WORDS, words, stateWords, errorWords } from './words.ts';
export type { WordKey } from './words.ts';

const NAME = /^[a-z][a-z0-9-]{0,30}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new ServiceError('bad-name', `name must match ${NAME.source}`);
}

function checkBin(bin: string | undefined): string {
  if (bin === undefined || bin === '' || !isAbsolute(bin)) throw new ServiceError('bad-bin', 'bin must be an absolute path');
  try {
    if (!statSync(bin).isFile()) throw new Error('not a file');
    accessSync(bin, constants.X_OK);
  } catch (cause) {
    throw new ServiceError('missing-bin', `${bin} is not an executable file`, { cause });
  }
  return bin;
}

const half = (): typeof linux | typeof macos | null =>
  process.platform === 'linux' ? linux : process.platform === 'darwin' ? macos : null;

const unsupported = (): ServiceError => new ServiceError('unsupported', `no per-user service manager for ${process.platform}`);

/** Write the unit, start it now and enable it at login. Re-running rewrites and restarts. */
export async function install(o: ServiceOptions): Promise<void> {
  checkName(o.name);
  const bin = checkBin(o.bin);
  const h = half();
  if (h === null) throw unsupported();
  await h.install({ ...o, bin, env: o.env ?? {} });
}

/** Stop the unit and remove its file; a service that is not installed resolves. */
export async function uninstall(o: ServiceOptions): Promise<void> {
  checkName(o.name);
  const h = half();
  if (h === null) throw unsupported();
  await h.uninstall(o);
}

/** Whether the unit is running, stopped, missing or failed; never throws for a missing service. */
export async function status(o: ServiceOptions): Promise<ServiceState> {
  checkName(o.name);
  return half()?.status(o) ?? { phase: 'unsupported' };
}
