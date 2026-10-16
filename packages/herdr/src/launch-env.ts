// The pinned agent.start launches through the pane shell. Values stay in a private host file,
// never terminal text or argv. Only an idle POSIX shell may source it; preparation fails closed.
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Call } from './agents.ts';
import { accountKind } from './kinds.ts';

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

// An idle pane shell the kit may type a sourcing line into. Herdr panes can run other shells
// (fish, csh, PowerShell), whose sourcing and function syntax differs; those never qualify.
const POSIX_IDLE_SHELL = /^(?:-)?(?:ba|z|da|k)?sh$/;

// Herdr 0.9.1 launches every `agent.start` kind under a fixed executable name
// (src/detect/mod.rs:153-186). These two differ from the kind; every other kind launches
// under its own name, and a kind Herdr does not know launches under no name (the start is
// refused before the name matters).
const LAUNCH_EXECUTABLES: Record<string, string> = { cursor: 'cursor-agent', kiro: 'kiro-cli' };

/** The executable name Herdr's `agent.start` will run for a kit kind, '' when unknown. */
export function launchExecutableOf(kind: string): string {
  const row = accountKind(kind);
  const canonical = row?.kind ?? '';
  return /^[a-z][a-z0-9-]*$/.test(canonical) ? LAUNCH_EXECUTABLES[canonical] ?? canonical : '';
}

/** The sourced hint script: a shell function shadowing the launch executable, so the
 * `agent.start` launch command runs `env HERDR_AGENT=<kind> <exe>` — Herdr's documented
 * foreground-process hint (docs/agents: "Set HERDR_AGENT=<agent> on the wrapper command"),
 * scoped to the agent's own process. `env` execs the real binary from PATH, so the function
 * never recurses, and the assignment never touches the pane shell's own environment. */
export function agentHintScript(exe: string, kind: string, marker: string): string {
  return `${exe}() { env HERDR_AGENT=${kind} ${exe} "$@"; }\nprintf '%s\\n' ${quote(marker)}`;
}

// Node 24 and 26 rename the runtime main thread (`MainThread`, `node-MainThread`), and Herdr
// 0.9.1 names a pane's foreground agent by process name, so a CLI running on those runtimes
// (Gemini CLI proved) goes unidentified and `agent.start` times out. The kit answers with the
// hint above, set on the agent process through the launch command — never in the pane env,
// where the hint marks the shell itself and the start is refused `agent_pane_busy`.
// Best effort by contract: a pane that is busy, runs a non-POSIX shell, or never confirms the
// function keeps today's behavior — the caller's start proceeds without it. Nothing here fails
// a start that would otherwise have worked.
export async function prepareAgentHint(call: Call, paneId: string, kind: string, timeout: number): Promise<void> {
  let dir: string | undefined;
  try {
    const exe = launchExecutableOf(kind);
    if (exe === '' || !Number.isFinite(timeout) || timeout <= 0) return;
    const deadline = Date.now() + timeout;
    // Type nothing into a busy pane (another program is foreground) or a non-POSIX shell: skip
    // at once. Wait only for a pane whose shell is still settling. A server that does not answer
    // `pane.process_info` at all never gets typed into — the hint is best effort, not a stall.
    for (;;) {
      const result = await call('pane.process_info', { pane_id: paneId }, Math.max(1, deadline - Date.now())) as
        { process_info?: { shell_pid?: number; foreground_processes?: { pid: number; name: string }[] } };
      const info = result?.process_info;
      if (info === undefined) return;
      const foreground = info.foreground_processes ?? [];
      const shell = foreground.find((process) => process?.pid === info.shell_pid);
      if (shell !== undefined) {
        if (foreground.length !== 1) return; // a job the shell holds: not idle
        if (!POSIX_IDLE_SHELL.test(shell.name)) return;
        break;
      }
      if (foreground.length > 0) return; // a program without the shell: busy
      if (Date.now() >= deadline) return;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    const marker = `BYOKIT_AGENT_${randomBytes(16).toString('hex')}`;
    dir = mkdtempSync(join(tmpdir(), 'byokit-agent-'));
    const file = join(dir, 'hint.sh');
    writeFileSync(file, agentHintScript(exe, kind, marker) + '\n', { mode: 0o600, flag: 'wx' });
    await call('pane.send_text', { pane_id: paneId, text: `set +x +v; . ${quote(file)}\n` }, Math.max(1, deadline - Date.now()));
    for (;;) {
      const result = await call('pane.read', { pane_id: paneId, source: 'recent_unwrapped', lines: 40,
        format: 'text', strip_ansi: true }, Math.max(1, deadline - Date.now())) as { read?: { text?: string } };
      if (result?.read?.text?.split(/\r?\n/).some((line) => line.trim() === marker)) return;
      if (Date.now() >= deadline) return;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  } catch {
    return; // the hint is an enhancement; the caller's start answers for itself
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
