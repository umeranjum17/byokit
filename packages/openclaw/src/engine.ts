import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { ENGINE_VERSION } from './constants.ts';
import { reconcileConfig } from './config.ts';
import type { KitOptions } from './kit.ts';
import type { KitState, ToolSpec } from './types.ts';

export type EngineOptions = Pick<KitOptions, 'stateDir' | 'engineDir' | 'npmPath' | 'enginePath' | 'config' | 'installPolicy' | 'log'> & {
  pluginId: string; tools: ToolSpec[]; spawnEngine: boolean;
  onState(s: KitState): void; onExit(code: number | null): void;
};
const kitDir = dirname(dirname(fileURLToPath(import.meta.url)));
const putOnce = (path: string, data: string) => { if (!existsSync(path)) writeFileSync(path, data, { mode: 0o600, flag: 'wx' }); };
const putChanged = (path: string, data: string) => {
  if (!existsSync(path) || readFileSync(path, 'utf8') !== data) writeFileSync(path, data, { mode: 0o600 });
};

export class Engine {
  readonly root: string;
  readonly bridgeSock: string;
  private readonly dir: string;
  private child?: ChildProcess;
  private stopping = false;
  private repaired = false;
  private prepared?: Promise<void>;
  private port = 0;
  private token = '';
  private readonly o: EngineOptions;
  constructor(o: EngineOptions) {
    this.o = o;
    this.root = join(o.stateDir, 'openclaw');
    this.dir = o.engineDir ?? join(this.root, 'engine');
    this.bridgeSock = join(this.root, o.pluginId === 'crewhouse' ? 'crewd.sock' : 'bridge.sock');
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
    for (const d of [this.root, join(this.root, 'home'), join(this.root, 'state'), join(this.root, 'tmp'), join(this.root, 'install-home'), join(this.root, 'npm-cache'), join(this.o.stateDir, 'logs'), this.dir]) mkdirSync(d, { recursive: true, mode: 0o700 });
    if (this.o.spawnEngine) {
      const versionPath = join(this.dir, 'node_modules', 'openclaw', 'package.json');
      const version = existsSync(versionPath) ? JSON.parse(readFileSync(versionPath, 'utf8')).version : undefined;
      if (!existsSync(this.entry) || version !== ENGINE_VERSION) {
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
    // O5 replaces the placeholder with the bridge implementation.
    for (const f of ['package.json', 'index.js']) {
      const source = join(kitDir, 'plugin', f);
      putOnce(join(pluginDir, f), readFileSync(source, 'utf8'));
    }
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
  async start(): Promise<{ port: number; token: string; identityPath: string }> {
    await this.prepare();
    const identityPath = join(this.root, 'device.json');
    if (!existsSync(identityPath)) {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      putOnce(identityPath, JSON.stringify({ privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), publicKey: publicKey.export({ format: 'pem', type: 'spki' }) }));
    }
    if (!this.o.spawnEngine) return { port: this.port, token: this.token, identityPath };
    if (this.child && this.child.exitCode === null) return { port: this.port, token: this.token, identityPath };
    this.stopping = false;
    this.stalePid();
    this.state('starting');
    const { entry, env } = this.doctorContext();
    const fd = openSync(join(this.o.stateDir, 'logs', 'openclaw.log'), 'a', 0o600);
    try { this.child = spawn(process.execPath, [entry, 'gateway', '--port', String(this.port)], { cwd: env.HOME, env, detached: true, stdio: ['ignore', fd, fd] }); }
    finally { closeSync(fd); }
    const child = this.child;
    if (!child.pid) { this.state('failed', 'exited'); throw new Error('engine spawn failed'); }
    writeFileSync(join(this.root, 'gateway.pid'), String(child.pid), { mode: 0o600 });
    child.once('exit', (code) => {
      if (this.child !== child || this.stopping) return;
      this.child = undefined;
      this.o.onExit(code);
      if (code === 78 && !this.repaired) {
        this.repaired = true;
        this.state('repairing');
        const result = this.doctor(60_000);
        if (result.status === 0) { void this.start().catch(() => this.state('failed', 'exited')); return; }
      }
      this.state('failed', 'exited');
    });
    return { port: this.port, token: this.token, identityPath };
  }
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (child?.pid && child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
      for (let i = 0; i < 15 && child.exitCode === null; i++) await delay(200);
      if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }
      for (let i = 0; i < 15 && child.exitCode === null; i++) await delay(200);
    }
    rmSync(join(this.root, 'gateway.pid'), { force: true });
    rmSync(this.bridgeSock, { force: true });
    this.state('stopped');
  }
}
