// Explicit, opt-in official Muse installation. No auth, model calls or inherited environment.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const MUSE_INSTALL_URL = 'https://dev.meta.ai/install.sh';
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-R[0-9]+(?:\.[0-9]+)?$/;
const hash = (file: string): string => {
  const fd = openSync(file, 'r'); const digest = createHash('sha256'); const buf = Buffer.alloc(64 * 1024);
  try { for (;;) { const n = readSync(fd, buf); if (!n) return digest.digest('hex'); digest.update(buf.subarray(0, n)); } }
  finally { closeSync(fd); }
};
function launcherHead(file: string): string {
  const fd = openSync(file, 'r'); const buf = Buffer.alloc(2048);
  try { return buf.subarray(0, readSync(fd, buf)).toString('utf8'); } finally { closeSync(fd); }
}
const quote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/** A launcher alone cannot run without its selected native release. Never executes Muse. */
export function museNative(launcher: string): { native: string; version: string } | undefined {
  try {
    const state = join(dirname(launcher), '.muse-version');
    if (!lstatSync(state).isFile() || lstatSync(state).size > 128) return;
    const version = readFileSync(state, 'utf8').trim();
    if (!VERSION.test(version)) return;
    const native = join(dirname(launcher), `muse-bin-${version}`);
    const launcherStat = lstatSync(launcher); const nativeStat = lstatSync(native);
    if (!launcherStat.isFile() || launcherStat.size > 1024 * 1024
      || !nativeStat.isFile() || nativeStat.size > 512 * 1024 * 1024) return;
    accessSync(launcher, constants.X_OK); accessSync(native, constants.X_OK);
    return { native, version };
  } catch { return; }
}

export type MuseReadiness = { state: 'unknown' | 'missing' | 'launcher-only' | 'installed'; signedIn: 'unknown'; bin?: string; version?: string };
/** Only the supplied effective pane PATH is probed, never the controller's personal directories. */
export function museReadiness(env?: Record<string, string>): MuseReadiness {
  if (env?.PATH === undefined) return { state: 'unknown', signedIn: 'unknown' };
  for (const dir of env.PATH.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const bin = join(dir, 'muse');
    try {
      if (!lstatSync(bin).isFile()) continue;
      accessSync(bin, constants.X_OK);
      const selected = museNative(bin);
      const head = launcherHead(bin);
      const launcherOnly = head.startsWith('#!') && (head.includes('mise') || (!selected && head.includes('MUSE_CHANNEL')));
      return { state: launcherOnly ? 'launcher-only' : 'installed', signedIn: 'unknown', bin,
        ...(selected ? { version: selected.version } : {}) };
    } catch { /* next PATH entry */ }
  }
  return { state: 'missing', signedIn: 'unknown' };
}

export type InstallMuseOptions = {
  /** Caller-owned absolute private home. Never the person's default home or a system location. */
  home: string;
  /** Explicit clean tool PATH; also returned for launch with the installed bin directory prepended. */
  path: string[];
  /** Must be inside home; defaults to home/.local/bin. */
  installDir?: string;
  signal?: AbortSignal;
  /** Total download/process deadline, capped at five minutes. */
  timeoutMs?: number;
};
export type MuseInstallReceipt = {
  bin: string; native: string; version: string; launcherSha256: string; nativeSha256: string;
  installerSha256?: string; source: typeof MUSE_INSTALL_URL;
  path: string[]; env: Record<string, string>;
};
export type MuseInstallResult = { ok: true; receipt: MuseInstallReceipt } | {
  ok: false;
  code: 'unsupported_platform' | 'unsafe_path' | 'tools_missing' | 'cancelled' | 'timeout' | 'download_failed'
    | 'protected_download' | 'install_failed' | 'incomplete_install';
  message: string;
  installerSha256?: string;
};

// Walk existing ancestors before making anything: no symlink directory can redirect writes.
function safePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path || /[\0\r\n:]/.test(path)) throw new Error('unsafe_path');
  for (let p = path;; p = dirname(p)) {
    try { if (lstatSync(p).isSymbolicLink()) throw new Error('unsafe_path'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (dirname(p) === p) break;
  }
}
function tool(name: string, path: string[]): string {
  for (const dir of path) {
    const file = join(dir, name);
    try { accessSync(file, constants.X_OK); return file; } catch { /* next */ }
  }
  throw new Error('tools_missing');
}

// Detached group cancellation kills the owned installer and every curl/bash child, not shared tools.
async function run(bin: string, args: string[], env: Record<string, string>, cwd: string,
  signal: AbortSignal): Promise<{ code: number | null; output: string }> {
  signal.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(bin, args, { env, cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = (): void => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const abort = (): void => kill();
    signal.addEventListener('abort', abort, { once: true });
    let output = '';
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > 64 * 1024) { output = output.slice(0, 64 * 1024); kill(); }
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', (e) => { signal.removeEventListener('abort', abort); reject(e); });
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort);
      // Kill any surviving descendants before removing their private staging files.
      kill();
      if (signal.aborted) reject(signal.reason); else done({ code, output });
    });
    if (signal.aborted) kill();
  });
}

/** Calling this authorizes the official download/install only. A protected artifact needs separate qualification. */
export async function installMuse(o: InstallMuseOptions): Promise<MuseInstallResult> {
  const bad = (code: Extract<MuseInstallResult, { ok: false }>['code'], message: string): MuseInstallResult =>
    ({ ok: false, code, message, ...(installerSha256 ? { installerSha256 } : {}) });
  let installerSha256: string | undefined;
  if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'].includes(`${process.platform}-${process.arch}`)) {
    return bad('unsupported_platform', 'The official private installer is supported here only on Linux and macOS x64/arm64.');
  }
  const dir = o.installDir ?? join(o.home, '.local/bin');
  let stage: string | undefined;
  const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), AbortSignal.timeout(Math.min(300_000, Math.max(1, o.timeoutMs ?? 180_000)))]);
  try {
    safePath(o.home); safePath(dir);
    if (o.home === '/' || o.home === '/tmp' || o.home === homedir() || homedir().startsWith(o.home + sep)
      || !dir.startsWith(o.home + sep) || /^\/(?:usr|bin|sbin|etc|opt|var|root|dev|proc|sys|run|lib|lib64|System|Library|Applications)(?:\/|$)/.test(o.home)
      || !o.path.length || o.path.some((p) => !isAbsolute(p) || /[\0\r\n:]/.test(p))) throw new Error('unsafe_path');
    try {
      const stat = lstatSync(o.home);
      if (!stat.isDirectory() || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('unsafe_path');
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const bash = tool('bash', o.path); const curl = tool('curl', o.path);
    const path = [dir, ...o.path];
    const env = { HOME: o.home, XDG_CONFIG_HOME: join(o.home, '.config'), XDG_CACHE_HOME: join(o.home, '.cache'),
      XDG_STATE_HOME: join(o.home, '.local/state'), TMPDIR: join(o.home, '.tmp'), PATH: path.join(delimiter),
      LANG: 'C.UTF-8', MUSE_LOGIN: '0', MUSE_NO_AUTO_UPDATE: '1', MUSE_AUTH_PATH: join(o.home, '.config/muse/auth.json') };
    for (const p of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR, dirname(env.MUSE_AUTH_PATH)]) safePath(p);
    const receipt = (selected: { native: string; version: string }): MuseInstallResult => ({ ok: true, receipt: {
      bin: join(dir, 'muse'), ...selected, launcherSha256: hash(join(dir, 'muse')), nativeSha256: hash(selected.native),
      ...(installerSha256 ? { installerSha256 } : {}), source: MUSE_INSTALL_URL, path, env,
    } });
    signal.throwIfAborted();
    const existing = museNative(join(dir, 'muse'));
    if (existing) {
      for (const p of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) mkdirSync(p, { recursive: true, mode: 0o700 });
      return receipt(existing); // No updater and no risk to a working installation.
    }
    // Never replace an existing incomplete directory either: caller may inspect/recover it separately.
    try { lstatSync(dir); return bad('incomplete_install', 'The target exists without a complete Muse installation; choose a fresh private install directory.'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    mkdirSync(o.home, { recursive: true, mode: 0o700 });
    stage = mkdtempSync(join(o.home, '.muse-install-'));
    const privateHome = join(stage, 'home'); const temp = join(stage, 'tmp'); const tools = join(stage, 'tools');
    for (const p of [privateHome, temp, tools]) mkdirSync(p, { mode: 0o700 });
    // Official scripts remain byte-for-byte unchanged. This curl policy disables curlrc and bounds
    // their downloads as well as the initial installer (HTTPS, redirects, bytes, connect/total time).
    writeFileSync(join(tools, 'curl'), `#!/bin/sh\nexec ${quote(curl)} -q "$@" --proto '=https' --proto-redir '=https' --max-redirs 3 --connect-timeout 10 --max-time 60 --max-filesize 536870912\n`, { mode: 0o700 });
    const stagedDir = join(stage, 'bin');
    const installEnv = { HOME: privateHome, XDG_CONFIG_HOME: join(privateHome, '.config'), XDG_CACHE_HOME: join(privateHome, '.cache'),
      XDG_STATE_HOME: join(privateHome, '.local/state'), TMPDIR: temp, PATH: [tools, stagedDir, ...o.path].join(delimiter),
      LANG: 'C.UTF-8', MUSE_INSTALL_DIR: stagedDir, MUSE_NO_MODIFY_PATH: '1', MUSE_LOGIN: '0', MUSE_NO_AUTO_UPDATE: '1',
      MUSE_AUTH_PATH: join(privateHome, '.config/muse/auth.json') };
    const installer = join(stage, 'install.sh');
    const fetched = await run(join(tools, 'curl'), ['--fail', '--silent', '--show-error', '--location', '--output', installer, MUSE_INSTALL_URL], installEnv, stage, signal);
    if (fetched.code !== 0) return bad('download_failed', 'The official installer download failed.');
    if (!lstatSync(installer).isFile() || lstatSync(installer).size > 1024 * 1024) return bad('download_failed', 'The official installer exceeds the allowed script size.');
    installerSha256 = hash(installer);
    const installed = await run(bash, ['--noprofile', '--norc', installer], installEnv, stage, signal);
    if (installed.code !== 0) {
      const denial = /HTTP (401|403|404)/.exec(installed.output);
      return denial ? bad('protected_download', `The official Muse download is protected or unavailable (HTTP ${denial[1]}); no login was attempted.`)
        : bad('install_failed', 'The official Muse installer failed; the previous installation was not changed.');
    }
    const selected = museNative(join(stagedDir, 'muse'));
    if (!selected) return bad('incomplete_install', 'The official installer did not produce an executable selected native release.');
    signal.throwIfAborted();
    safePath(o.home); safePath(dir);
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    for (const p of [env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) {
      safePath(p); mkdirSync(p, { recursive: true, mode: 0o700 });
    }
    signal.throwIfAborted();
    renameSync(stagedDir, dir);
    return receipt({ version: selected.version, native: join(dir, `muse-bin-${selected.version}`) });
  } catch (e) {
    if (o.signal?.aborted) return bad('cancelled', 'Muse installation was cancelled; the previous installation was not changed.');
    if (signal.aborted) return bad('timeout', 'Muse installation exceeded its deadline; the previous installation was not changed.');
    if ((e as Error).message === 'unsafe_path') return bad('unsafe_path', 'Use absolute private app-managed paths without symlinks, inside the selected home.');
    if ((e as Error).message === 'tools_missing') return bad('tools_missing', 'Bash and curl are required on the explicit tool PATH.');
    return bad('install_failed', 'Muse installation failed; the previous installation was not changed.');
  } finally { if (stage) rmSync(stage, { recursive: true, force: true }); }
}
