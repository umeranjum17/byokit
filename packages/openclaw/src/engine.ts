import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthStore } from './auth-store.ts';
import { ENGINE_VERSION } from './constants.ts';
import { reconcileConfig } from './config.ts';
import { writePlugin, resolveBridge } from './bridge.ts';
import type { KitOptions } from './kit.ts';
import type { KitState, ToolSpec } from './types.ts';

export type EngineOptions = Pick<KitOptions, 'stateDir' | 'engineDir' | 'npmPath' | 'enginePath' | 'config' | 'installPolicy' | 'log' | 'bridge' | 'authSeal'> & {
  pluginId: string; tools: ToolSpec[]; gateBuiltins?: boolean; spawnEngine: boolean;
  onState(s: KitState): void; onExit(code: number | null): void;
};
const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));
const putOnce = (path: string, data: string) => { if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); };
const putChanged = (path: string, data: string) => {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== data) writeFileSync(path, data, { mode: 0o600 });
};

type LockedPackage = { version: string; optional?: boolean; os?: string[]; cpu?: string[]; libc?: string[] };
const supports = (list: string[] | undefined, value: string) => !list ||
  (!list.includes(`!${value}`) && (list.includes('any') || list.every(item => item.startsWith('!')) || list.includes(value)));

function installMatches(dir: string): boolean {
  const manifests = ['package.json', 'package-lock.json'].map(file => ({
    path: join(dir, file), shipped: readFileSync(join(kitDir, 'engine', file)),
  }));
  const lock = JSON.parse(manifests[1]!.shipped.toString('utf8')) as { packages: Record<string, LockedPackage> };
  // npm omits optional binaries for other platforms (including the other Linux libc).
  const report = process.platform === 'linux' ? process.report.getReport() as { header: { glibcVersionRuntime?: string } } : undefined;
  const libc = report?.header.glibcVersionRuntime ? 'glibc' : process.platform === 'linux' ? 'musl' : '';
  try {
    if (manifests.some(({ path, shipped }) => !readFileSync(path).equals(shipped))) return false;
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path) continue; // The root manifest is checked byte for byte above.
      if (pkg.optional && (!supports(pkg.os, process.platform) || !supports(pkg.cpu, process.arch) || !supports(pkg.libc, libc))) continue;
      if (JSON.parse(readFileSync(join(dir, path, 'package.json'), 'utf8')).version !== pkg.version) return false;
    }
    return true;
  } catch {
    // Missing or unreadable manifests and malformed installed package metadata need repair too.
    return false;
  }
}

export class Engine {
  readonly root: string;
  readonly bridgeSock: string;
  private readonly dir: string;
  private child?: ChildProcess;
  private starting?: Promise<{ port: number; token: string; identityPath: string }>;
  private readonly authStore: AuthStore;
  private stopping = false;
  private repaired = false;
  private prepared?: Promise<void>;
  private port = 0;
  private token = '';
  private readonly o: EngineOptions;
  private readonly paramPrefix: string;
  constructor(o: EngineOptions) {
    this.o = o;
    const bridge = resolveBridge(o.bridge);
    this.root = join(o.stateDir, 'openclaw');
    this.dir = o.engineDir ?? join(this.root, 'engine');
    this.bridgeSock = join(this.root, bridge.socketName);
    this.paramPrefix = bridge.paramPrefix;
    this.authStore = new AuthStore({ root: this.root, stateDir: o.stateDir, engineDir: this.dir, seal: o.authSeal, log: o.log });
  }
  private state(phase: KitState['phase'], why?: KitState['why'], retryAt?: number) { this.o.onState({ phase, ...(why ? { why } : {}), ...(retryAt ? { retryAt } : {}) }); }
  private get entry() { return join(this.dir, 'node_modules', 'openclaw', 'openclaw.mjs'); }
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
    const pending = this.prepareOnce();
    this.prepared = pending;
    void pending.finally(() => { if (this.prepared === pending) this.prepared = undefined; }).catch(() => {});
    return pending;
  }
  private async prepareOnce(): Promise<void> {
    if (!this.o.authSeal && existsSync(join(this.root, 'auth-store.sealed'))) throw new Error('authSeal required for sealed credential store');
    for (const d of [this.root, ...(!this.o.authSeal ? [join(this.root, 'home'), join(this.root, 'state')] : []), join(this.root, 'tmp'), join(this.root, 'install-home'), join(this.root, 'npm-cache'), join(this.o.stateDir, 'logs'), this.dir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    await this.authStore.prepare();
    if (this.o.spawnEngine) {
      const versionPath = join(this.dir, 'node_modules', 'openclaw', 'package.json');
      if (!existsSync(this.entry) || !installMatches(this.dir)) {
        this.state('installing');
        rmSync(join(this.dir, 'node_modules'), { recursive: true, force: true });
        for (const f of ['package.json', 'package-lock.json']) copyFileSync(join(kitDir, 'engine', f), join(this.dir, f));
        const result = spawnSync(this.o.npmPath ?? 'npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', this.dir], {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: join(this.root, 'install-home'), npm_config_cache: join(this.root, 'npm-cache'), OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL: '1' },
          timeout: 300_000, stdio: 'pipe', encoding: 'utf8', maxBuffer: 1024 * 1024,
        });
        if (result.status !== 0) { this.state('failed', 'install'); throw new Error(`engine install: ${result.error ?? result.stderr?.slice(-500)}`); }
      }
      if (!existsSync(this.entry) || JSON.parse(readFileSync(versionPath, 'utf8')).version !== ENGINE_VERSION) {
        this.state('needs-update', 'version'); throw new Error('engine version mismatch');
      }
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
    for (const f of ['package.json', 'index.js']) {
      const source = join(kitDir, 'plugin', f);
      putChanged(join(pluginDir, f), readFileSync(source, 'utf8'));
    }
    // The bridge manifest and tool table follow the app's tools on every prepare (O5).
    writePlugin(pluginDir, { id: this.o.pluginId, tools: this.o.tools, paramPrefix: this.paramPrefix,
      gateBuiltins: this.o.gateBuiltins !== false });
    const path = join(this.root, 'openclaw.json');
    const saved = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    const config = reconcileConfig(saved, { root: this.root, stateDir: this.o.stateDir, port: this.port, pluginId: this.o.pluginId,
      pluginDir, policyPath: join(kitDir, 'policy', 'policy.mjs'), app: this.o.config, installPolicy: this.o.installPolicy });
    putChanged(path, JSON.stringify(config, null, 2) + '\n');
  }
  doctorContext(): { entry: string; env: Record<string, string> } {
    const home = join(this.root, 'home');
    return { entry: this.entry, env: {
      PATH: ['/usr/bin', '/bin', ...this.o.enginePath ?? []].join(':'), LANG: 'C.UTF-8', HOME: home, OPENCLAW_HOME: home,
      OPENCLAW_STATE_DIR: join(this.root, 'state'), OPENCLAW_CONFIG_PATH: join(this.root, 'openclaw.json'),
      XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'), XDG_DATA_HOME: join(home, '.local/share'),
      XDG_STATE_HOME: join(home, '.local/state'), CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: join(home, '.claude'),
      TMPDIR: join(this.root, 'tmp'), OPENCLAW_NO_RESPAWN: '1', OPENCLAW_SKIP_CHANNELS: '1', OPENCLAW_DISABLE_BONJOUR: '1',
      OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', OPENCLAW_LOAD_SHELL_ENV: '0', OPENCLAW_GATEWAY_TOKEN: this.token,
      BYOKIT_BRIDGE_SOCK: this.bridgeSock,
    } };
  }
  doctor(timeoutMs: number): { status: number | null } {
    const { entry, env } = this.doctorContext();
    const result = spawnSync(process.execPath, [entry, 'doctor', '--fix', '--yes', '--non-interactive'], { cwd: env.HOME, env, timeout: timeoutMs, stdio: 'pipe' });
    return { status: result.status };
  }
  private stalePid() {
    const path = join(this.root, 'gateway.pid');
    if (!existsSync(path)) return;
    const pid = Number(readFileSync(path, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (cmd.includes(this.entry) && cmd.includes('gateway')) process.kill(-pid, 'SIGTERM');
    } catch { /* pid is gone or not ours */ }
  }
  start(): Promise<{ port: number; token: string; identityPath: string }> {
    if (this.starting) return this.starting;
    this.stopping = false;
    const pending = this.startOnce();
    this.starting = pending;
    void pending.finally(() => { if (this.starting === pending) this.starting = undefined; }).catch(() => {});
    return pending;
  }
  private async startOnce(): Promise<{ port: number; token: string; identityPath: string }> {
    await this.prepare();
    await this.authStore.start();
    try { return this.launch(); }
    catch (error) { await this.authStore.stop(); throw error; }
  }
  private launch(): { port: number; token: string; identityPath: string } {
    const identityPath = join(this.root, 'device.json');
    if (!existsSync(identityPath)) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      putOnce(identityPath, JSON.stringify({ privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }));
    }
    if (!this.o.spawnEngine) return { port: this.port, token: this.token, identityPath };
    if (this.child && this.child.exitCode === null) return { port: this.port, token: this.token, identityPath };
    this.stalePid();
    this.state('starting');
    const { entry, env } = this.doctorContext();
    const fd = openSync(join(this.o.stateDir, 'logs', 'openclaw.log'), 'a', 0o600);
    try { this.child = spawn(process.execPath, [entry, 'gateway', '--port', String(this.port)], { cwd: env.HOME, env, detached: true, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    const child = this.child;
    child.on('error', () => {
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      void this.authStore.stop().then(() => { this.state('failed', 'exited'); this.o.onExit(null); }, () => this.state('failed', 'exited'));
    });
    if (!child.pid) { this.state('failed', 'exited'); throw new Error('engine spawn failed'); }
    writeFileSync(join(this.root, 'gateway.pid'), String(child.pid), { mode: 0o600 });
    child.once('exit', (code) => {
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      rmSync(join(this.root, 'gateway.pid'), { force: true });
      void (async () => {
        await this.authStore.stop();
        if (this.stopping) return;
        if (code === 78 && !this.repaired) {
          this.repaired = true;
          this.state('repairing');
          const result = await this.withAuthStore(async () => this.doctor(60_000));
          if (result.status === 0 && !this.stopping) { await this.start(); return; }
        }
        this.state('failed', 'exited');
        this.o.onExit(code);
      })().catch(() => this.state('failed', 'exited'));
    });
    return { port: this.port, token: this.token, identityPath };
  }
  withAuthStore<T>(task: () => Promise<T>): Promise<T> { return this.authStore.offline(task); }
  async stop(): Promise<void> {
    this.stopping = true;
    await this.starting?.catch(() => {});
    const child = this.child;
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 15 && child.exitCode === null && child.signalCode === null; i++) await delay(200);
      if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
      for (let i = 0; i < 15 && child.exitCode === null && child.signalCode === null; i++) await delay(200);
    }
    if (child && child.exitCode === null && child.signalCode === null) throw new Error('engine did not stop; credential store still in use');
    this.child = undefined;
    rmSync(join(this.root, 'gateway.pid'), { force: true });
    await this.authStore.stop();
    rmSync(this.bridgeSock, { force: true });
    this.state('stopped');
  }
}
