// The pinned agent.start launches through the pane shell. Values stay in a private host file,
// never terminal text or argv. Only an idle POSIX shell may source it; preparation fails closed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Call } from './agents.ts';

export type LaunchEnvironment = { env: Record<string, string>; unset: string[] };
export type OverlayEnvironment = { overlay: Record<string, string>; unset?: string[] };
export const isLaunchEnvironment = (env: unknown): env is LaunchEnvironment =>
  typeof env === 'object' && env !== null && !Array.isArray(env)
  && typeof (env as { env?: unknown }).env === 'object' && (env as { env?: unknown }).env !== null
  && Array.isArray((env as { unset?: unknown }).unset);
export const isOverlayEnvironment = (env: unknown): env is OverlayEnvironment =>
  typeof env === 'object' && env !== null && !Array.isArray(env)
  && typeof (env as { overlay?: unknown }).overlay === 'object'
  && (env as { overlay?: unknown }).overlay !== null
  && !Array.isArray((env as { overlay?: unknown }).overlay);
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const validName = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
const validValue = (value: unknown): value is string => typeof value === 'string' && !/[\r\n\0]/.test(value);

// An idle POSIX shell gate: never send shell input to an agent or another foreground program.
async function waitIdleShell(call: Call, paneId: string, deadline: number): Promise<void> {
  for (;;) {
    const result = await call('pane.process_info', { pane_id: paneId }, Math.max(1, deadline - Date.now())) as
      { process_info?: { shell_pid?: number; foreground_processes?: { pid: number; name: string }[] } };
    const info = result?.process_info;
    if (info?.shell_pid && info.foreground_processes?.length === 1
      && info.foreground_processes[0]?.pid === info.shell_pid
      && /^(?:-)?(?:ba|z|da|k)?sh$/.test(info.foreground_processes[0].name)) break;
    if (Date.now() >= deadline) throw new Error();
    await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

// The private-file round trip: values stay in a host file sourced once, never terminal text or
// argv; the marker read proves the shell ran every step. Neither values nor variable listings
// reach the terminal.
async function runPrivateSteps(call: Call, paneId: string, steps: string[], deadline: number): Promise<void> {
  let dir: string | undefined;
  try {
    const marker = `BYOKIT_ENV_${randomBytes(16).toString('hex')}`;
    dir = mkdtempSync(join(tmpdir(), 'byokit-env-'));
    const file = join(dir, 'prepare.sh');
    writeFileSync(file, [...steps, `printf '%s\\n' ${quote(marker)}`].join(' &&\n') + '\n',
      { mode: 0o600, flag: 'wx' });
    await call('pane.send_text', { pane_id: paneId, text: `set +x +v; . ${quote(file)}\n` },
      Math.max(1, deadline - Date.now()));
    for (;;) {
      const result = await call('pane.read', { pane_id: paneId, source: 'recent_unwrapped', lines: 40,
        format: 'text', strip_ansi: true }, Math.max(1, deadline - Date.now())) as { read?: { text?: string } };
      if (result?.read?.text?.split(/\r?\n/).some((line) => line.trim() === marker)) return;
      if (Date.now() >= deadline) throw new Error();
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  } finally {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

export async function prepareLaunchEnv(call: Call, paneId: string, launch: LaunchEnvironment, timeout: number): Promise<void> {
  try {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error();
    const entries = Object.entries(launch.env);
    const unset = [...launch.unset];
    if (entries.some(([key, value]) => !validName(key) || !validValue(value))
      || unset.some((key) => !validName(key) || Object.hasOwn(launch.env, key))) throw new Error();
    const deadline = Date.now() + timeout;
    // Do not send shell input to an agent or another foreground program.
    await waitIdleShell(call, paneId, deadline);
    const steps = [
      'set +x +v',
      // Remove exports absent from the clean result too: a pane may inherit more than the host.
      // The pipeline is private; neither values nor variable listings reach the terminal.
      `for BYOKIT_ENV_KEY in $(/usr/bin/env | /usr/bin/cut -d= -f1); do
case "$BYOKIT_ENV_KEY" in ''|[!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac
case "$BYOKIT_ENV_KEY" in ${entries.length ? entries.map(([key]) => key).join('|') : 'BYOKIT_ENV_KEY'}) ;; *) unset "$BYOKIT_ENV_KEY" 2>/dev/null || return 1 ;; esac
done`,
      'unset BYOKIT_ENV_KEY',
      ...unset.map((key) => `unset ${key}`),
      ...entries.map(([key, value]) => `export ${key}=${quote(value)}`),
      ...unset.map((key) => `test "\${${key}+present}" = ''`),
      ...entries.map(([key, value]) => `test "\${${key}+present}" = present && test "$${key}" = ${quote(value)}`),
    ];
    await runPrivateSteps(call, paneId, steps, deadline);
  } catch {
    throw Object.assign(new Error('This pane could not use that sign-in.'), { code: 'env_mismatch' });
  }
}

// The additive overlay: values land on the pane's inherited environment and the named ones are
// removed, and both are verified in the pane before the caller starts anything. Unlike the
// replacement form above, every other export survives untouched.
export async function prepareOverlayEnv(call: Call, paneId: string, overlay: OverlayEnvironment,
  timeout: number): Promise<void> {
  try {
    if (!Number.isFinite(timeout) || timeout <= 0) throw new Error();
    const entries = Object.entries(overlay.overlay);
    const unset = [...(overlay.unset ?? [])];
    if (entries.some(([key, value]) => !validName(key) || !validValue(value))
      || unset.some((key) => !validName(key) || Object.hasOwn(overlay.overlay, key))) throw new Error();
    const deadline = Date.now() + timeout;
    await waitIdleShell(call, paneId, deadline);
    const steps = [
      'set +x +v',
      ...unset.map((key) => `unset ${key}`),
      ...entries.map(([key, value]) => `export ${key}=${quote(value)}`),
      ...unset.map((key) => `test "\${${key}+present}" = ''`),
      ...entries.map(([key, value]) => `test "\${${key}+present}" = present && test "$${key}" = ${quote(value)}`),
    ];
    await runPrivateSteps(call, paneId, steps, deadline);
  } catch {
    throw Object.assign(new Error('This pane could not use that sign-in.'), { code: 'env_mismatch' });
  }
}
