import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { protocolBounds } from './constants.ts';
import { socketTransport } from './socket.ts';
import type { HerdrKitOptions, HerdrState, HerdrTransport } from './types.ts';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The command line of a live process, for the stale-pidfile check below. Linux reads
 * /proc (no subprocess, NULs unfolded to spaces); every other Unix asks `ps -o command=`
 * by absolute path with an empty env (no /proc on macOS). Windows and unknown, invalid
 * or exited pids read as undefined, and only a command naming both `bin` and `server`
 * ever counts as ours — a pid reused by an unrelated process never matches.
 */
export function commandOf(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ');
    } catch {
      return undefined;
    }
  }
  if (platform === 'win32') return undefined;
  for (const ps of ['/bin/ps', '/usr/bin/ps']) {
    if (!existsSync(ps)) continue;
    try {
      const probed = spawnSync(ps, ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8', timeout: 5000, env: {},
      });
      if (probed.error !== undefined) continue; // binary unusable here, try the next path
      const out = (probed.stdout ?? '').trim();
      return out.length > 0 ? out : undefined; // empty: ps ran, the pid is unknown
    } catch {
      continue;
    }
  }
  return undefined;
}

export class Supervisor {
  private transport?: HerdrTransport;
  private child?: ChildProcess;
  private stopping = false;
  private retry?: NodeJS.Timeout;
  private liveness?: NodeJS.Timeout;
  private pinging = false;
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
    const base = { PATH: this.o.path?.join(':') || '/usr/bin:/bin', LANG: 'C.UTF-8', ...this.o.env };
    // An adopt kit that names no session socket passes none on: an empty HERDR_SOCKET_PATH would
    // override the child's own resolution (`--session` > HERDR_SOCKET_PATH > HERDR_SESSION > default).
    const socket: Record<string, string> = this.socketPath ? { HERDR_SOCKET_PATH: this.socketPath } : {};
    if (this.o.mode === 'adopt') {
      return { ...socket, ...base };
    }
    const home = join(this.root!, 'home');
    return {
      HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local/state'),
      XDG_CACHE_HOME: join(home, '.cache'), ...socket, ...base,
    };
  }
  private state(phase: HerdrState['phase'], why?: HerdrState['why']) { this.statePhase = phase; this.onState({ phase, ...(why ? { why } : {}) }); }
  async start(): Promise<HerdrTransport> {
    clearTimeout(this.liveness);
    this.liveness = undefined;
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
          const command = commandOf(pid);
          if (command !== undefined && command.includes(this.o.bin) && command.includes('server')) {
            process.kill(-pid, 'SIGTERM');
          }
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
        const ping = await transport.call('ping', {}, this.o.livenessTimeoutMs ?? 1000) as { protocol?: number };
        // K11: a server older than the declared range fails closed; a newer one connects
        // anyway with `needs-update` (the kit's bootstrap keeps that steady state), so a
        // Herdr protocol bump does not take the host down before the kit's pin moves.
        const { min, max } = protocolBounds(this.o.protocolRange);
        if (typeof ping.protocol !== 'number' || ping.protocol < min) {
          this.state('needs-update', 'version'); throw new Error('herdr: protocol mismatch');
        }
        if (ping.protocol > max) this.state('needs-update', 'version');
        this.failures = 0;
        this.watchLiveness(transport);
        return transport;
      } catch (error) {
        if ((error as Error).message === 'herdr: protocol mismatch') throw error;
        if ((error as { code?: string }).code === 'timeout') {
          this.state('stalled');
          // A connected but silent server may be busy; keep probing on the normal backoff.
          let retry = 0;
          while (!this.stopping) {
            await delay([250, 500, 1000, 2000][Math.min(retry++, 3)]);
            try {
              const ping = await transport.call('ping', {}, this.o.livenessTimeoutMs ?? 1000) as { protocol?: number };
              const { min, max } = protocolBounds(this.o.protocolRange);
              if (typeof ping.protocol !== 'number' || ping.protocol < min) {
                this.state('needs-update', 'version'); throw new Error('herdr: protocol mismatch');
              }
              if (ping.protocol > max) this.state('needs-update', 'version');
              this.failures = 0;
              this.watchLiveness(transport);
              return transport;
            } catch (retryError) {
              if (this.stopping) throw new Error('herdr: stopped');
              if ((retryError as Error).message === 'herdr: protocol mismatch') throw retryError;
              if ((retryError as { code?: string }).code !== 'timeout') {
                this.state('failed', 'socket');
                throw retryError;
              }
            }
          }
          throw new Error('herdr: stopped');
        }
      }
    }
    this.state('failed', 'socket');
    throw new Error('herdr: socket unavailable');
  }
  private watchLiveness(transport: HerdrTransport): void {
    clearTimeout(this.liveness);
    const timeout = this.o.livenessTimeoutMs ?? 1000;
    const interval = Math.max(1000, timeout);
    const ping = async () => {
      if (this.stopping || this.transport !== transport || this.pinging) return;
      this.pinging = true;
      try {
        await transport.call('ping', {}, timeout);
        if (!this.stopping && this.transport === transport && this.statePhase === 'stalled') this.state('ready');
      } catch (error) {
        if (this.stopping || this.transport !== transport) return;
        if ((error as { code?: string }).code === 'timeout') {
          if (this.statePhase !== 'stalled') this.state('stalled');
        } else this.state('failed', 'socket');
      } finally {
        this.pinging = false;
        if (!this.stopping && this.transport === transport) this.liveness = setTimeout(() => { void ping(); }, interval);
      }
    };
    this.liveness = setTimeout(() => { void ping(); }, interval);
  }
  private statePhase?: HerdrState['phase'];
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.liveness);
    this.liveness = undefined;
    this.pinging = false;
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
