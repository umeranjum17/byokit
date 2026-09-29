import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { protocolBounds } from './constants.ts';
import { socketTransport } from './socket.ts';
import type { HerdrKitOptions, HerdrState, HerdrTransport } from './types.ts';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Supervisor {
  private transport?: HerdrTransport;
  private child?: ChildProcess;
  private stopping = false;
  private retry?: NodeJS.Timeout;
  private failures = 0;
  private readonly root?: string;
  private readonly socketPath: string;
  private readonly o: HerdrKitOptions;
  private readonly onState: (s: HerdrState) => void;
  constructor(o: HerdrKitOptions, onState: (s: HerdrState) => void) {
    this.o = o;
    this.onState = onState;
    this.root = o.mode === 'own' ? join(o.stateDir, 'herdr') : undefined;
    this.socketPath = o.mode === 'own' ? join(o.stateDir, 'herdr', 'herdr.sock') : o.socketPath;
  }
  env(): Record<string, string> {
    if (this.o.mode === 'adopt') {
      return { HERDR_SOCKET_PATH: this.socketPath, PATH: this.o.path?.join(':') || '/usr/bin:/bin', LANG: 'C.UTF-8', ...this.o.env };
    }
    const home = join(this.root!, 'home');
    return {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CACHE_HOME: join(home, '.cache'), HERDR_SOCKET_PATH: this.socketPath,
      PATH: this.o.path?.join(':') || '/usr/bin:/bin', LANG: 'C.UTF-8', ...this.o.env,
    };
  }
  private state(phase: HerdrState['phase'], why?: HerdrState['why']) { this.onState({ phase, ...(why ? { why } : {}) }); }
  async start(): Promise<HerdrTransport> {
    this.stopping = false;
    this.state('connecting');
    if (this.o.mode === 'own') {
      if (!isAbsolute(this.o.bin) || !existsSync(this.o.bin)) {
        this.state('missing', 'binary'); throw new Error('herdr: executable binary required');
      }
      try { if (!statSync(this.o.bin).isFile()) throw new Error(); accessSync(this.o.bin, constants.X_OK); } catch {
        this.state('missing', 'binary'); throw new Error('herdr: binary not executable');
      }
      mkdirSync(join(this.root!, 'home'), { recursive: true });
      const pidfile = join(this.root!, 'server.pid');
      if (existsSync(pidfile)) {
        const pid = Number(readFileSync(pidfile, 'utf8'));
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
          if (cmdline.includes(this.o.bin) && cmdline.includes('server')) process.kill(-pid, 'SIGTERM');
        } catch { /* no matching owned process */ }
        unlinkSync(pidfile);
      }
      const log = openSync(join(this.root!, 'server.log'), 'a', 0o600);
      this.child = spawn(this.o.bin, ['server'], { env: this.env(), detached: true, stdio: ['ignore', log, log] });
      const child = this.child;
      child.on('error', () => { if (!this.stopping) this.state('failed', 'server-exited'); });
      child.on('exit', () => {
        if (this.stopping || this.child !== child) return;
        this.state('reconnecting', 'server-exited');
        this.retry = setTimeout(() => { void this.start().catch(() => {}); }, Math.min(30_000, 1000 * 2 ** this.failures++));
      });
      if (child.pid) writeFileSync(pidfile, String(child.pid), { mode: 0o600 });
      closeSync(log);
    }
    const transport = this.transport ?? this.o.transport ?? socketTransport(this.socketPath);
    this.transport = transport;
    for (const ms of [0, 250, 500, 1000, 2000]) {
      if (ms) await delay(ms);
      if (this.stopping) throw new Error('herdr: stopped');
      try {
        const ping = await transport.call('ping', {}, 1000) as { protocol?: number };
        // K11: a server older than the declared range fails closed; a newer one connects
        // anyway with `needs-update` (the kit's bootstrap keeps that steady state), so a
        // Herdr protocol bump does not take the host down before the kit's pin moves.
        const { min, max } = protocolBounds(this.o.protocolRange);
        if (typeof ping.protocol !== 'number' || ping.protocol < min) {
          this.state('needs-update', 'version'); throw new Error('herdr: protocol mismatch');
        }
        if (ping.protocol > max) this.state('needs-update', 'version');
        this.failures = 0;
        return transport;
      } catch (error) {
        if ((error as Error).message === 'herdr: protocol mismatch') throw error;
      }
    }
    this.state('failed', 'socket');
    throw new Error('herdr: socket unavailable');
  }
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retry);
    if (this.o.mode === 'own' && this.child?.pid) {
      try { await this.transport?.call('server.stop', {}, 1000); } catch { /* process may have exited */ }
      const child = this.child;
      const exited = new Promise<void>((resolve) => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (child.exitCode !== null) break;
        if (signal === 'SIGTERM') await Promise.race([exited, delay(3000)]);
        if (child.exitCode !== null) break;
        try { process.kill(-child.pid!, signal); } catch { /* already gone */ }
      }
      await Promise.race([exited, delay(3000)]);
      try { unlinkSync(join(this.root!, 'server.pid')); } catch { /* absent */ }
    }
    this.transport?.close();
    // A closed transport never answers again: drop it so the next `start()` (a retry
    // after `failed`, or a restart after `stop()`) dials with a fresh transport.
    this.transport = undefined;
    this.state('stopped');
  }
}
