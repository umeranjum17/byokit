import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, generateKeyPairSync, randomUUID } from 'node:crypto';
import { accessSync, constants, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync, rmSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { basename, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { cliAccounts, remoteCliHost } from '@byokit/accounts/cli';
import { AuthStore, AuthStoreUnreadableError, AuthStoreSealSizeError } from './auth-store.ts';
import { EngineAlreadyRunningError, pidAlive, StartedProcesses } from './engine-status.ts';
import { EnginePatchError, atomic, prepareEngineSet, processStartTime, readPatchSet, sha256, verifyEngineSet, type PatchSet } from './engine-patches.ts';
import { ENGINE_VERSION } from './constants.ts';
import { appendUsageBoot } from './usage-boots.ts';
import { reconcileConfig, appRecoveryPrefixes } from './config.ts';
import { writePlugin, resolveBridge } from './bridge.ts';
import { sweepOrphans } from './accounts.ts';
import { NATIVE_ENV_VAR, nativeEnvPath } from './native-env.ts';
import { installedPlugins } from './plugins.ts';
import type { KitOptions } from './kit.ts';
import type { CliLoginCause, KitState, ToolSpec } from './types.ts';

/** The app's stateDir as an absolute path with no symlinked ancestor (macOS /tmp and /var are symlinks):
 * the native Claude login's accounts store refuses any other, so a relative or symlinked stateDir failed it. */
export function canonicalStateDir(dir: string): string {
  const path = resolve(dir);
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonicalStateDir(parent), basename(path));
  }
}
export type EngineOptions = Pick<KitOptions, 'stateDir' | 'engineDir' | 'npmPath' | 'enginePath' | 'config' | 'offered' | 'appOwnedSessions' | 'installPolicy' | 'log' | 'bridge' | 'authSeal' | 'channels'> & {
  pluginId: string; tools: ToolSpec[]; gateBuiltins?: boolean; spawnEngine: boolean;
  browserConfig?: () => { profiles: Record<string, { cdpUrl: string; attachOnly: true }>; tools: string[] };
  onState(s: KitState): void; onExit(code: number | null): void;
};
const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));
const putOnce = (path: string, data: string) => { if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); };
const putChanged = (path: string, data: string) => {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== data) writeFileSync(path, data, { mode: 0o600 });
};
// The person's own homes for every engine process: the gateway, doctor and agent CLIs use the installed, signed-in logins as is.
const personal = () => {
  const env: Record<string, string> = { HOME: homedir() };
  for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) { const value = process.env[name]; if (value) env[name] = value; }
  return env;
};
const onPath = (path: string, name: string) => path.split(':').map(dir => join(dir, name)).find(file => { try { accessSync(file, constants.X_OK); return true; } catch { return false; } });

type LockedPackage = { version: string; optional?: boolean; os?: string[]; cpu?: string[]; libc?: string[] };
const supports = (list: string[] | undefined, value: string) => !list ||
  (!list.includes(`!${value}`) && (list.includes('any') || list.every(item => item.startsWith('!')) || list.includes(value)));

type InstallDrift = { setDir: string; check: 'root-manifest' | 'package-version' | 'read'; path: string; expected?: string; actual?: string; readError?: string };
// First failed check of the most recent installMatches call; retained with the npm facts in
// <stateDir>/logs/engine-install-drift.json before the failed temp is deleted.
let installDrift: InstallDrift | undefined;
function installMatches(dir: string): boolean {
  installDrift = undefined;
  const manifests = ['package.json', 'package-lock.json'].map(file => ({
    path: join(dir, file), shipped: readFileSync(join(kitDir, 'engine', file)),
  }));
  const lock = JSON.parse(manifests[1]!.shipped.toString('utf8')) as { packages: Record<string, LockedPackage> };
  // npm omits optional binaries for other platforms (including the other Linux libc).
  const report = process.platform === 'linux' ? process.report.getReport() as { header: { glibcVersionRuntime?: string } } : undefined;
  const libc = report?.header.glibcVersionRuntime ? 'glibc' : process.platform === 'linux' ? 'musl' : '';
  let reading = 'package.json';
  try {
    for (const { path, shipped } of manifests) {
      const installed = readFileSync(path);
      if (!installed.equals(shipped)) {
        installDrift = { setDir: dir, check: 'root-manifest', path: basename(path), expected: sha256(shipped), actual: sha256(installed) };
        return false;
      }
    }
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path) continue; // The root manifest is checked byte for byte above.
      if (pkg.optional && (!supports(pkg.os, process.platform) || !supports(pkg.cpu, process.arch) || !supports(pkg.libc, libc))) continue;
      reading = `${path}/package.json`;
      const version = JSON.parse(readFileSync(join(dir, path, 'package.json'), 'utf8')).version;
      if (version !== pkg.version) {
        installDrift = { setDir: dir, check: 'package-version', path, expected: pkg.version, actual: String(version) };
        return false;
      }
    }
    return true;
  } catch (error) {
    // Missing or unreadable manifests and malformed installed package metadata need repair too.
    installDrift = { setDir: dir, check: 'read', path: reading, readError: String((error as Error).message).slice(0, 300) };
    return false;
  }
}

export const refusedOnly = (error: unknown) => { if (error instanceof AuthStoreSealSizeError) return error; throw error; };
export class Engine {
  readonly root: string;
  readonly bridgeSock: string;
  private readonly dir: string;
  private setDir?: string;
  private wantedSet?: PatchSet;
  private child?: ChildProcess;
  private readonly started = new StartedProcesses();
  private starting?: Promise<{ port: number; token: string; identityPath: string } | undefined>;
  readonly authStore: AuthStore;
  private stopping = false;
  // Aborted by stop(): a sign-in drive that has not reached its commit point then declines at once, the key paste
  // included (it has no native host signal of its own). start() replaces it, so an earlier shutdown cannot decline
  // a later drive.
  private stopOwner = new AbortController();
  private claudeLogin?: ReturnType<typeof remoteCliHost>; private claudeAccounts?: ReturnType<typeof cliAccounts>; private claudeReset?: Promise<void>; private bound?: ReturnType<Engine['nativeBound']>;
  private credentialsLocked = false;
  // True when the last start found no installed Claude Code login: the engine then uses its own fallback folder.
  private claudeFallback = false;
  private repaired = false;
  private prepared?: Promise<void>;
  patchSet?: string | null;
  private port = 0;
  private token = '';
  private readonly o: EngineOptions;
  private readonly paramPrefix: string;
  private readonly appOwnedSessionPrefixes: string[];
  constructor(o: EngineOptions) {
    this.appOwnedSessionPrefixes = appRecoveryPrefixes(o.appOwnedSessions);
    o = { ...o, stateDir: canonicalStateDir(o.stateDir) };
    this.o = o;
    const bridge = resolveBridge(o.bridge);
    this.root = join(o.stateDir, 'openclaw');
    this.dir = o.engineDir ?? join(this.root, 'engine');
    this.bridgeSock = join(this.root, bridge.socketName);
    this.paramPrefix = bridge.paramPrefix;
    this.authStore = new AuthStore({ root: this.root, stateDir: o.stateDir, engineDir: this.dir, seal: o.authSeal, log: o.log });
  }
  private state(phase: KitState['phase'], why?: KitState['why'], retryAt?: number, sealSize?: KitState['sealSize']) { this.o.onState({ phase, ...(why ? { why } : {}), ...(retryAt ? { retryAt } : {}), ...(sealSize ? { sealSize } : {}), ...(this.patchSet !== undefined ? { patchSet: this.patchSet } : {}) }); }
  // Retained at <stateDir>/logs/engine-install-drift.json (overwritten per failure) after the failed
  // temporary set is deleted: the first failed check, the npm identity and the npm stderr tail.
  // Bounded fields, no environment values or secrets; diagnostics never mask the failure they describe.
  private retainInstallDiagnostics(error: EnginePatchError, npmPath: string, npmStderrTail: string): void {
    try {
      const npm = spawnSync(npmPath, ['--version'], { encoding: 'utf8', timeout: 5000 });
      const drift = installDrift;
      writeFileSync(join(this.o.stateDir, 'logs', 'engine-install-drift.json'), JSON.stringify({
        at: new Date().toISOString(),
        failedDir: error.file ?? null,
        firstFailedCheck: drift && drift.setDir === error.file
          ? { check: drift.check, path: drift.path, expected: drift.expected ?? null, actual: drift.actual ?? null, readError: drift.readError ?? null }
          : null,
        npm: { path: npmPath, version: npm.status === 0 && npm.stdout ? npm.stdout.trim().slice(0, 100) : null },
        npmStderrTail: npmStderrTail.slice(0, 500),
      }), { mode: 0o600 });
    } catch { /* diagnostics must never mask the failure being diagnosed */ }
  }
  private exitedState(refused?: unknown): void {
    if (refused instanceof AuthStoreSealSizeError) this.state('failed', 'auth-store-seal-size', undefined, { size: refused.size, cap: refused.cap });
    else this.state('failed', 'exited');
  }
  private get entry() {
    if (this.o.spawnEngine && !this.setDir) throw new EnginePatchError('spec', 'engine-set');
    return join(this.setDir ?? this.dir, 'node_modules', 'openclaw', 'openclaw.mjs');
  }
  private async freePort(): Promise<number> {
    const server = createServer();
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const a = server.address();
        const port = a && typeof a !== 'string' ? a.port : 0;
        server.close(() => resolve(port));
      });
    });
  }
  prepare(): Promise<void> {
    if (this.prepared) return this.prepared;
    const pending = this.prepareOnce().catch(error => {
      if (error instanceof EnginePatchError) { this.patchSet = null; this.state('failed', 'engine-patch'); }
      if (error instanceof AuthStoreUnreadableError) this.state('failed', 'auth-store-unreadable');
      if (error instanceof AuthStoreSealSizeError) this.exitedState(error);
      throw error;
    });
    this.prepared = pending;
    void pending.finally(() => { if (this.prepared === pending) this.prepared = undefined; }).catch(() => {});
    return pending;
  }
  private async prepareOnce(): Promise<void> {
    if (!this.o.authSeal && existsSync(join(this.root, 'auth-store.sealed'))) throw new Error('authSeal required for sealed credential store');
    await this.recoverOrphan();
    for (const d of [this.root, ...(!this.o.authSeal ? [join(this.root, 'home'), join(this.root, 'state')] : []), join(this.root, 'tmp'), join(this.root, 'usage'), join(this.root, 'install-home'), join(this.root, 'npm-cache'), join(this.o.stateDir, 'logs')]) mkdirSync(d, { recursive: true, mode: 0o700 });
    putOnce(join(this.root, 'npmrc'), ''); // engine npm runs read this empty config, never the person's ~/.npmrc
    this.sweepAccountOrphans();
    if (this.o.spawnEngine) this.claudeFallback = (await this.installedClaudeSignedOut()) ?? false;
    try { await this.authStore.prepare(); this.credentialsLocked = false; }
    catch (error) { if (this.locked(error)) return; throw error; }
    if (this.o.spawnEngine) {
      const lock = JSON.parse(readFileSync(join(kitDir, 'engine/package-lock.json'), 'utf8')) as { packages: Record<string, { integrity: string }> };
      const patches = readPatchSet(join(kitDir, 'engine/patches.json'), ENGINE_VERSION, lock.packages['node_modules/openclaw']!.integrity);
      const npmPath = this.o.npmPath ?? 'npm';
      let npmStderrTail = '';
      const install = async (dir: string) => {
        this.state('installing');
        for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(kitDir, 'engine', f), join(dir, f));
        await new Promise<void>((resolve, reject) => {
          const child = spawn(npmPath, ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', dir], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(this.root, 'install-home'), npm_config_cache: join(this.root, 'npm-cache'), OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: '1' },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '', expired = false;
          this.started.add(child);
          child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
          const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 300_000);
          child.once('error', error => { clearTimeout(timer); this.started.forget(child); npmStderrTail = stderr; reject(error); });
          child.once('exit', code => {
            clearTimeout(timer); this.started.forget(child); npmStderrTail = stderr;
            if (code === 0 && !expired) resolve();
            else { this.state('failed', 'install'); reject(new Error(`engine install: ${expired ? 'timeout' : stderr}`)); }
          });
        });
        // Newer pins ship a pending package-lifecycle marker that the gateway completes on first boot by
        // running its own scripts, which needs a writable tree. Complete it here, while the set is still
        // writable, with bundled plugin installs disabled: on a fresh install the prune is a no-op and
        // upstream's own script removes the marker. Pins without the script (pre-8.33) skip this.
        const lifecycle = join(dir, 'node_modules/openclaw/scripts/postinstall-bundled-plugins.mjs');
        if (!existsSync(lifecycle)) return;
        await new Promise<void>((resolve, reject) => {
          const child = spawn(process.execPath, [lifecycle], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(this.root, 'install-home'), npm_config_cache: join(this.root, 'npm-cache'), OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: '1' },
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '', expired = false;
          this.started.add(child);
          child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-500); });
          const timer = setTimeout(() => { expired = true; child.kill('SIGKILL'); }, 120_000);
          child.once('error', error => { clearTimeout(timer); this.started.forget(child); reject(error); });
          child.once('exit', code => {
            clearTimeout(timer); this.started.forget(child);
            if (code === 0 && !expired) resolve();
            else { this.state('failed', 'install'); reject(new Error(`engine lifecycle: ${expired ? 'timeout' : stderr}`)); }
          });
        });
      };
      try {
        this.setDir = await prepareEngineSet(this.dir, patches, install, installMatches);
      } catch (error) {
        // The failed temp is already deleted; keep its diagnosis for the next natural failure.
        if (error instanceof EnginePatchError && (error.cause === 'drift-after-build' || error.cause === 'write'))
          this.retainInstallDiagnostics(error, npmPath, npmStderrTail);
        throw error;
      }
      this.wantedSet = patches;
      atomic(join(this.root, 'engine-set'), this.setDir);
      this.patchSet = patches.id;
    }
    const tokenFile = join(this.root, 'token');
    putOnce(tokenFile, randomBytes(32).toString('hex'));
    this.token = readFileSync(tokenFile, 'utf8').trim();
    const portFile = join(this.root, 'port');
    putOnce(portFile, String(await this.freePort()));
    this.port = Number(readFileSync(portFile, 'utf8'));
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65535 || this.port === 18789) {
      this.state('failed', 'port'); throw new Error('invalid engine port');
    }
    const pluginDir = join(this.root, 'plugin');
    mkdirSync(pluginDir, { recursive: true, mode: 0o700 });
    // The shipped plugin follows the kit on every prepare too: a state dir from an older kit must not keep its gate.
    for (const f of ['package.json', 'index.js', 'keys.js', 'usage.js', 'accounts.js', 'catalog.js', 'codex.js']) {
      const source = join(kitDir, 'plugin', f);
      putChanged(join(pluginDir, f), readFileSync(source, 'utf8'));
    }
    // The bridge manifest and tool table follow the app's tools on every prepare (O5).
    writePlugin(pluginDir, { id: this.o.pluginId, tools: this.o.tools, paramPrefix: this.paramPrefix,
      gateBuiltins: this.o.gateBuiltins !== false, browser: !!this.o.browserConfig,
      channels: this.o.channels?.telegram ? ['telegram'] : [] });
    const path = join(this.root, 'openclaw.json');
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const config = reconcileConfig(saved, { root: this.root, stateDir: this.o.stateDir, port: this.port, pluginId: this.o.pluginId,
      pluginDir, policyPath: join(kitDir, 'policy', 'policy.mjs'), app: this.o.config, offered: this.o.offered,
      installPolicy: this.o.installPolicy, browser: this.o.browserConfig?.(), plugins: installedPlugins(this.root),
      channels: this.o.channels });
    putChanged(path, JSON.stringify(config, null, 2) + '\n');
  }
  /** B7: the engine's own installer for one pinned external plugin, in the isolated engine env with the kit's npm
   * first on PATH (the installer runs `npm`). The explicit kit call is the consent; the install policy holds the pin and
   * its integrity. Resolves the installer's exit code and output tail; the kit then restarts the gateway to load it. */
  installPlugin(spec: string): Promise<{ code: number | null; output: string }> {
    const { entry, env } = this.doctorContext();
    const npm = this.o.npmPath && this.o.npmPath.includes('/') ? [dirname(this.o.npmPath)] : (process.env.PATH ?? '').split(':');
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, 'plugins', 'install', spec, '--force', '--accept-capabilities'], {
        cwd: env.OPENCLAW_HOME, env: { ...env, PATH: [...npm, env.PATH].join(':'), npm_config_cache: join(this.root, 'npm-cache') },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      this.started.add(child);
      const keep = (chunk: Buffer) => { output = (output + chunk).slice(-2000); };
      child.stdout.on('data', keep); child.stderr.on('data', keep);
      const timer = setTimeout(() => child.kill('SIGKILL'), 300_000);
      child.once('error', error => { clearTimeout(timer); this.started.forget(child); reject(error); });
      child.once('close', code => { clearTimeout(timer); this.started.forget(child); resolve({ code, output }); });
    });
  }
  private get path() { return ['/usr/bin', '/bin', ...this.o.enginePath ?? []].join(':'); }
  private async runOwned(binary: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, input?: string): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { cwd: this.root, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '', timedOut = false;
      this.started.add(child);
      const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-65_536); };
      child.stdout.on('data', keep); child.stderr.on('data', keep);
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.once('error', error => { clearTimeout(timer); this.started.forget(child); reject(error); });
      child.once('close', code => { clearTimeout(timer); this.started.forget(child); resolve({ code: timedOut ? null : code, output }); });
      child.stdin.end(input);
    });
  }
  private composioMcpLogin?: { url: Promise<string>; done: Promise<{ code: number | null; output: string }>; child: ChildProcess };
  private composioMcpContext() {
    const { entry, env: inherited } = this.doctorContext();
    const home = join(this.root, 'home');
    return { entry, env: { ...inherited, HOME: home, XDG_CONFIG_HOME: join(home, '.config'),
      XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state') } };
  }
  beginComposioMcpLogin(): Promise<{ url: string }> {
    if (this.composioMcpLogin) throw new Error('Composio MCP sign-in is already pending.');
    const { entry, env } = this.composioMcpContext();
    const child = spawn(process.execPath, [entry, 'mcp', 'login', 'composio'], {
      cwd: join(this.root, 'home'), env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.started.add(child);
    let output = '', urlFound = false;
    let resolveUrl!: (value: string) => void, rejectUrl!: (error: Error) => void;
    let resolveDone!: (value: { code: number | null; output: string }) => void;
    const url = new Promise<string>((resolve, reject) => { resolveUrl = resolve; rejectUrl = reject; });
    const done = new Promise<{ code: number | null; output: string }>(resolve => { resolveDone = resolve; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); rejectUrl(new Error('OpenClaw MCP login did not return an authorization URL.')); }, 30_000);
    const capture = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-65_536);
      const raw = output.match(/https:\/\/[^\s"'<>]+/)?.[0];
      if (!raw || urlFound) return;
      try {
        const parsed = new URL(raw);
        if (parsed.protocol !== 'https:' || !['connect.composio.dev', 'login.composio.dev'].includes(parsed.hostname)
          || parsed.username || parsed.password) throw new Error('OpenClaw returned an unsafe Composio OAuth URL.');
        urlFound = true; clearTimeout(timer); resolveUrl(parsed.href);
      } catch (error) { clearTimeout(timer); rejectUrl(error as Error); child.kill('SIGKILL'); }
    };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => {
      clearTimeout(timer); rejectUrl(error); this.started.forget(child);
      if (this.composioMcpLogin?.done === done && !urlFound) this.composioMcpLogin = undefined;
      resolveDone({ code: null, output });
    });
    child.once('close', code => {
      clearTimeout(timer); this.started.forget(child);
      if (!urlFound) {
        rejectUrl(new Error(`OpenClaw MCP login exited before authorization URL (exit ${code}).`));
        if (this.composioMcpLogin?.done === done) this.composioMcpLogin = undefined;
      }
      resolveDone({ code, output });
    });
    this.composioMcpLogin = { url, done, child };
    return url.then(value => ({ url: value }));
  }
  async completeComposioMcpLogin(): Promise<void> {
    const pending = this.composioMcpLogin;
    if (!pending) throw new Error('No Composio MCP sign-in is pending.');
    try {
      await pending.url;
      let timer!: NodeJS.Timeout;
      const timedOut = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 10 * 60_000); timer.unref(); });
      const result = await Promise.race([pending.done, timedOut]);
      clearTimeout(timer);
      if (!result) {
        pending.child.kill('SIGKILL'); await pending.done;
        throw new Error('Composio MCP sign-in timed out.');
      }
      if (result.code !== 0) throw new Error(`Composio MCP sign-in did not complete (OpenClaw exit ${result.code}).`);
    } finally {
      if (this.composioMcpLogin?.done === pending.done) this.composioMcpLogin = undefined;
    }
  }
  async signOutComposio(): Promise<void> {
    if (this.composioMcpLogin) throw new Error('Cannot sign out while Composio MCP sign-in is pending.');
    const { entry, env } = this.composioMcpContext();
    const result = await this.runOwned(process.execPath, [entry, 'mcp', 'logout', 'composio'], env, 30_000);
    if (result.code !== 0) throw new Error(`Composio MCP sign-out failed (OpenClaw exit ${result.code}).`);
  }
  // The engine's own Claude folder: the fallback login writes it and, only with claudeFallback, the gateway reads it.
  private get claudeFolder() { return join(this.root, 'home', '.claude'); }
  doctorContext(): { entry: string; env: Record<string, string> } {
    const home = join(this.root, 'home');
    return { entry: this.entry, env: {
      PATH: this.path, LANG: 'C.UTF-8', ...personal(), OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: join(this.root, 'state'), OPENCLAW_CONFIG_PATH: join(this.root, 'openclaw.json'),
      // Upstream eagerly imports/refreshes Codex OAuth. Only the CLI may see the person's login.
      CODEX_HOME: join(home, '.codex'),
      XDG_CACHE_HOME: join(home, '.cache'),
      ...this.claudeFallback ? { CLAUDE_CONFIG_DIR: this.claudeFolder } : {},
      TMPDIR: join(this.root, 'tmp'), npm_config_cache: join(this.root, 'npm-cache'), npm_config_userconfig: join(this.root, 'npmrc'),
      OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', OPENCLAW_LOAD_SHELL_ENV: '0', OPENCLAW_GATEWAY_TOKEN: this.token,
      BYOKIT_BRIDGE_SOCK: this.bridgeSock,
      // K2: the non-secret table of bound accounts' own native folders, read by the engine patch at every CLI run.
      [NATIVE_ENV_VAR]: nativeEnvPath(this.root),
      BYOKIT_APP_OWNED_SESSION_PREFIXES: JSON.stringify(this.appOwnedSessionPrefixes),
    } };
  }
  /** The engine's own shutdown signal; aborted by stop() and replaced by the next start(). */
  get stopSignal(): AbortSignal { return this.stopOwner.signal; }
  async installedCodexSignedIn(): Promise<boolean> {
    if (!this.o.spawnEngine) return false;
    const env = { PATH: this.path, LANG: 'C.UTF-8', ...personal() };
    delete (env as Record<string, string>).CODEX_HOME;
    const bin = onPath(env.PATH, 'codex');
    if (!bin) return false;
    return new Promise(resolve => execFile(bin, ['login', 'status'], { env, timeout: 15_000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
      resolve(!error && /^Logged in using ChatGPT\b/m.test(stdout + stderr));
    }));
  }
  private installedClaudeSignedOut(): Promise<boolean | undefined> {
    const env = { PATH: this.path, LANG: 'C.UTF-8', TMPDIR: join(this.root, 'tmp'), ...personal() };
    const bin = onPath(env.PATH, 'claude');
    if (!bin) return Promise.resolve(true);
    return new Promise(resolve => execFile(bin, ['auth', 'status', '--json'], { env, timeout: 15_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      let loggedIn: unknown;
      try { loggedIn = JSON.parse(stdout).loggedIn; } catch { /* no parsed answer */ }
      if (loggedIn === true) return resolve(false);
      if (loggedIn === false) {
        this.o.log?.('claude: no installed sign-in, the engine uses its own sign-in folder');
        return resolve(true);
      }
      this.o.log?.(`claude: sign-in status unknown, using the person's own login location (${String(error?.message ?? 'unparseable output').slice(0, 200)})`);
      resolve(undefined);
    }));
  }
  /** Re-select the installed login on setup detection; only a confirmed login switches away from fallback. */
  async refreshInstalledClaudeLogin(): Promise<boolean> {
    if (!this.o.spawnEngine || !this.claudeFallback) return false;
    const signedOut = await this.installedClaudeSignedOut();
    if (signedOut !== false) return false;
    this.claudeFallback = false;
    return true;
  }
  /** The fallback Claude sign-in for a machine whose installed Claude Code is signed out: it signs into the engine's folder. */
  nativeClaudeLogin(): ReturnType<typeof remoteCliHost> {
    if (this.claudeLogin) return this.claudeLogin;
    const login = this.claudeCli(this.root, { claude: this.claudeFolder });
    this.claudeAccounts = login.cli; this.claudeLogin = login.host;
    return this.claudeLogin;
  }
  /** The Claude Code sign-ins bound to account entries (K1): each row owns a folder under `<root>/native`, apart from
   * the fallback login's one folder. The binding is the row id; nothing here is a credential or a copy of one. */
  nativeBound(): { cli: ReturnType<typeof cliAccounts>; host: ReturnType<typeof remoteCliHost> } {
    return this.bound ??= this.claudeCli(join(this.root, 'native'));
  }
  private claudeCli(stateDir: string, managedFolders?: { claude: string }) {
    const { env } = this.doctorContext(), home = join(this.root, 'home');
    const bin = onPath(env.PATH, 'claude');
    const bins = bin ? { claude: bin } : {};
    // The login runs in its own HOME: CLAUDE_CONFIG_DIR points it at the engine's folder, which accounts refuses as a HOME's default login.
    for (const dir of ['home', 'login-home', ...stateDir === this.root ? [] : ['native']]) mkdirSync(join(this.root, dir), { recursive: true, mode: 0o700 });
    const cli = cliAccounts({ stateDir, bins, env: { PATH: env.PATH, HOME: join(this.root, 'login-home'), LANG: env.LANG, TMPDIR: env.TMPDIR, XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state') }, ...managedFolders ? { managedFolders } : {} });
    return { cli, host: remoteCliHost({ cli, bins }) };
  }
  /** Where a Claude Code login must be for this engine's gateway to read it. `signIn: false` when a fallback sign-in
   * would write a folder the gateway does not read: it started on the person's login location (installed sign-in, or
   * a probe with no answer), and an in-process restart keeps that env. */
  claudeLoginCause(): CliLoginCause {
    if (this.o.spawnEngine && !this.claudeFallback) {
      const { HOME, CLAUDE_CONFIG_DIR } = personal();
      return { code: 'needs_cli_login', cli: 'claude', home: HOME, ...CLAUDE_CONFIG_DIR ? { configDir: CLAUDE_CONFIG_DIR } : {}, signIn: false };
    }
    return { code: 'needs_cli_login', cli: 'claude', home: join(this.root, 'home'), configDir: this.claudeFolder, signIn: true };
  }
  resetNativeClaudeLogin(): Promise<void> {
    if (this.claudeReset) return this.claudeReset;
    const cli = this.claudeAccounts, host = this.claudeLogin;
    if (!cli || !host || host.signal.aborted) return Promise.resolve();
    this.claudeReset = (async () => { for (const row of await cli.list()) { if (host.signal.aborted) return; if (row.provider === 'claude' && row.state === 'ready' && cli.folderOf(row.id) === this.claudeFolder) await cli.remove(row.id); } })().finally(() => { this.claudeReset = undefined; });
    return this.claudeReset;
  }
  doctor(timeoutMs: number): { status: number | null } {
    const { entry, env } = this.doctorContext();
    if (this.o.spawnEngine) verifyEngineSet(this.setDir!, this.wantedSet!, installMatches);
    const result = spawnSync(process.execPath, [entry, 'doctor', '--fix', '--yes', '--non-interactive'], { cwd: env.OPENCLAW_HOME, env, timeout: timeoutMs, stdio: 'pipe' });
    if (this.o.spawnEngine) verifyEngineSet(this.setDir!, this.wantedSet!, installMatches);
    return { status: result.status };
  }
  private verifiedOrphan(pid: number): boolean {
    if (process.platform !== 'linux' || !process.getuid) return false;
    try {
      const proc = `/proc/${pid}`;
      const identity = JSON.parse(readFileSync(join(this.root, 'gateway.identity'), 'utf8')) as { pid?: unknown; startTime?: unknown };
      const env = readFileSync(`${proc}/environ`, 'utf8').split('\0');
      const home = join(this.root, 'home');
      const owner = join(this.root, 'auth-store.lock', 'pid');
      return statSync(proc).uid === process.getuid()
        && Number(readFileSync(join(this.root, 'gateway.pid'), 'utf8')) === pid
        && identity.pid === pid && identity.startTime === processStartTime(pid)
        && realpathSync(`${proc}/exe`) === realpathSync(process.execPath)
        && realpathSync(`${proc}/cwd`) === realpathSync(home)
        && env.includes(`OPENCLAW_HOME=${home}`)
        && env.includes(`OPENCLAW_STATE_DIR=${join(this.root, 'state')}`)
        && env.includes(`OPENCLAW_CONFIG_PATH=${join(this.root, 'openclaw.json')}`)
        && existsSync(owner) && !pidAlive(Number(readFileSync(owner, 'utf8')));
    } catch { return false; }
  }
  private async recoverOrphan(): Promise<void> {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return;
    const path = join(this.root, 'gateway.pid');
    if (!existsSync(path)) return;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!pidAlive(pid)) return; // AuthStore removes stale guards only under its lock.
    const occupied = () => { this.state('failed', 'engine-already-running'); return new EngineAlreadyRunningError(); };
    if (!this.verifiedOrphan(pid)) throw occupied();
    // Verify a stable process identity again immediately before signalling this pid, never its group.
    try {
      const before = processStartTime(pid);
      if (!this.verifiedOrphan(pid) || before !== processStartTime(pid)) throw occupied();
    } catch {
      if (!pidAlive(pid)) return;
      throw occupied();
    }
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw occupied(); }
    for (let i = 0; i < 15 && pidAlive(pid); i++) await delay(200);
    if (pidAlive(pid)) throw occupied();
    // The new store owner now seals crash leftovers under its lock before restoring them.
  }
  // The account orphan sweep (5.15): a late engine write after a removal cannot be ruled out by a bounded check, so
  // prepare and the sealed restore remove each `<root>/state/agents/<member>--<hex6>` directory a removal recorded as
  // gone and no index names, and drop member-store auth profiles a removal recorded as `dropped`. No roster here: the
  // gateway is down, and no add is in flight while preparing (an entry is written before its agent is created, so an
  // account being added is named).
  private sweepAccountOrphans(): void {
    try { sweepOrphans(this.root, this.o.log); }
    catch (error) { this.o.log?.(`prepare: orphans are not swept: ${String((error as Error).message).slice(0, 200)}`); }
  }
  start(): Promise<{ port: number; token: string; identityPath: string } | undefined> {
    if (this.starting) return this.starting;
    this.stopping = false;
    this.stopOwner = new AbortController();
    const pending = this.startOnce();
    this.starting = pending;
    void pending.finally(() => { if (this.starting === pending) this.starting = undefined; }).catch(() => {});
    return pending;
  }
  private locked(error: unknown): boolean {
    if (!(error instanceof Error) || error.name !== 'KeystoreError' || !('code' in error) || error.code !== 'keyring-locked') return false;
    this.credentialsLocked = true;
    this.state('locked');
    return true;
  }
  private async startOnce(): Promise<{ port: number; token: string; identityPath: string } | undefined> {
    await this.prepare();
      if (this.credentialsLocked) return undefined;
      try { await this.authStore.start(); }
      catch (error) {
        if (this.locked(error)) return undefined;
        if (error instanceof AuthStoreUnreadableError) this.state('failed', 'auth-store-unreadable');
        throw error;
      }
      this.sweepAccountOrphans();
      try { return this.launch(); }
      catch (error) {
        // A launch failure after spawn still has a writer; the caller's stop must await its exit.
        if (!this.child) await this.authStore.stop();
        throw error;
      }
  }
  private launch(): { port: number; token: string; identityPath: string } {
    const identityPath = join(this.root, 'device.json');
    if (!existsSync(identityPath)) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      putOnce(identityPath, JSON.stringify({ privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }));
    }
    if (!this.o.spawnEngine) return { port: this.port, token: this.token, identityPath };
    if (this.child && this.child.exitCode === null) return { port: this.port, token: this.token, identityPath };
    try { verifyEngineSet(this.setDir!, this.wantedSet!, installMatches); }
    catch (error) { this.patchSet = null; this.state('failed', 'engine-patch'); throw error; }
    this.state('starting');
    const { entry, env } = this.doctorContext();
    // A turned-on channel (5.18) starts in the gateway alone; doctor and installs keep channels off and never see the token.
    if (this.o.channels?.telegram) { delete env.OPENCLAW_SKIP_CHANNELS; env.TELEGRAM_BOT_TOKEN = this.o.channels.telegram.token; }
    const fd = openSync(join(this.o.stateDir, 'logs', 'openclaw.log'), 'a', 0o600);
    const usageDir = join(this.root, 'usage'), bootId = randomUUID();
    try {
      // The bundle hash in the Workshop file name changes per release; the stable prefix names the seam.
      const accounted = this.wantedSet!.files.some(file => file.path.startsWith('dist/experience-review-') && /\.m?js$/.test(file.path));
      if (accounted) {
        appendUsageBoot(usageDir, { bootId, startedAt: Date.now() });
        env.BYOKIT_ENGINE_USAGE_LEDGER = usageDir; env.BYOKIT_ENGINE_BOOT = bootId;
      }
      // Detached keeps the engine out of the host's session; stop() still signals its pid alone, never its group.
      try { this.child = spawn(process.execPath, [entry, 'gateway', '--port', String(this.port)], { cwd: env.OPENCLAW_HOME, env, detached: true, stdio: ['ignore', fd, fd] }); }
      catch (error) { if (env.BYOKIT_ENGINE_BOOT) appendUsageBoot(usageDir, { bootId, failedAt: Date.now(), spawned: false }); throw error; }
    } finally { closeSync(fd); }
    const child = this.child;
    this.started.add(child);
    child.on('error', () => {
      this.started.forget(child);
      // Only absence of a pid proves no engine could have attempted a ledger write.
      if (!child.pid && env.BYOKIT_ENGINE_BOOT) { try { appendUsageBoot(usageDir, { bootId, failedAt: Date.now(), spawned: false }); } catch { /* unclosed boot remains incomplete */ } }
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      void this.authStore.stop().then(() => undefined, refusedOnly).then((refused) => { this.exitedState(refused); this.o.onExit(null); }, () => { this.state('failed', 'exited'); this.o.onExit(null); });
    });
    if (!child.pid) { this.state('failed', 'exited'); throw new Error('engine spawn failed'); }
    if (process.platform === 'linux') {
      writeFileSync(join(this.root, 'gateway.identity'), JSON.stringify({ pid: child.pid, startTime: processStartTime(child.pid), ...(env.BYOKIT_ENGINE_BOOT ? { bootId } : {}) }), { mode: 0o600 });
    }
    writeFileSync(join(this.root, 'gateway.pid'), String(child.pid), { mode: 0o600 });
    child.once('exit', (code) => {
      this.started.forget(child);
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      this.removeOwnedPid(child.pid);
      void (async () => {
        let refused = await this.authStore.stop().then(() => undefined, refusedOnly);
        if (this.stopping) return;
        if (!refused && code === 78 && !this.repaired) {
          this.repaired = true;
          this.state('repairing');
          try {
            const result = await this.withAuthStore(async () => this.doctor(60_000));
            if (result.status === 0 && !this.stopping) { await this.start(); return; }
          } catch (error) { refused = refusedOnly(error); }
        }
        this.exitedState(refused);
        this.o.onExit(code);
      })().catch(() => { this.state('failed', 'exited'); this.o.onExit(code); });
    });
    return { port: this.port, token: this.token, identityPath };
  }
  private removeOwnedPid(pid: number | undefined): void {
    const path = join(this.root, 'gateway.pid');
    if (pid && existsSync(path) && readFileSync(path, 'utf8') === String(pid)) {
      rmSync(path, { force: true });
      rmSync(join(this.root, 'gateway.identity'), { force: true });
    }
  }
  withAuthStore<T>(task: () => Promise<T>): Promise<T> { return this.authStore.offline(task); }
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopOwner.abort();
    await this.claudeLogin?.close(); await this.bound?.host.close(); await this.claudeReset?.catch(() => {});
    this.claudeLogin = undefined; this.claudeAccounts = undefined; this.bound = undefined;
    await this.starting?.catch(() => {});
    const child = this.child;
    await this.started.terminate(delay);
    this.composioMcpLogin = undefined;
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('engine did not stop; credential store still in use');
    this.child = undefined;
    this.removeOwnedPid(child?.pid);
    if (!this.credentialsLocked) await this.authStore.stop();
    this.state('stopped');
  }
}
