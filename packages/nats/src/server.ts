// One local nats-server with JetStream as a supervised child: loopback only, behind a token, one saved port and one
// store. Two servers on one store silently lose acknowledged messages, so the port is saved once and never re-picked: a
// server an earlier process left running is adopted (it answers on the saved port with our token), a second is never
// started while the first answers, and a port taken by something else is refused in words, never moved.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { connect } from '@nats-io/transport-node';
import { fetchNats, type NatsAsset } from './binary.ts';
import { NatsError } from './error.ts';

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type EnsureNatsOptions = {
  /** Absolute app-owned folder; the server keeps everything under `<stateDir>/nats` (folders 0700, files 0600). */
  stateDir: string;
  /** Absolute path of a nats-server to run. Default: the pinned release, downloaded and hash-checked into `<stateDir>/nats/bin`. */
  bin?: string;
  /** How long to wait for a started server to answer. Default 10 s. */
  startMs?: number;
  /** Tests: serve the archive from a loopback fixture. The sha256 is still checked. */
  source?: NatsAsset;
  platform?: string;
  fetch?: typeof fetch;
  /** Developer diagnostics; never a secret. */
  log?: (line: string) => void;
};
export type NatsServer = {
  /** `nats://127.0.0.1:<port>`, loopback only. */
  url: string;
  /** The shared secret every client sends. Only the app holds it. */
  token: string;
  /** Where JetStream keeps its files. */
  storeDir: string;
  /** True when this call started the server; false when it adopted one an earlier process left running. */
  started: boolean;
  /** True while the server answers on its port with our token. */
  health(): Promise<boolean>;
  /** Stop the server. Only a pid whose command line still names our binary is signalled. Safe to call twice. */
  stop(): Promise<void>;
};

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer().once('error', reject).listen(0, '127.0.0.1', () => { const { port } = s.address() as { port: number }; s.close(() => resolve(port)); });
});

/** Connect once and close again: whether something answers with this token. */
async function answers(port: number, token: string, timeout: number): Promise<boolean> {
  try { const nc = await connect({ servers: `127.0.0.1:${port}`, token, maxReconnectAttempts: 0, timeout }); await nc.close(); return true; } catch { return false; }
}

/** A running loopback server with JetStream, started or adopted. */
export async function ensureNats(o: EnsureNatsOptions): Promise<NatsServer> {
  if (!isAbsolute(o.stateDir) || /["\\\n]/.test(o.stateDir)) throw new TypeError('nats: stateDir must be an absolute path without quotes, backslashes or newlines');
  const dir = join(o.stateDir, 'nats'), storeDir = join(dir, 'store'), portFile = join(dir, 'port'), tokenFile = join(dir, 'token'), pidFile = join(dir, 'pid'), confFile = join(dir, 'nats.conf'), logFile = join(dir, 'server.log');
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const bin = o.bin ?? await fetchNats({ dir: join(dir, 'bin'), ...(o.platform ? { platform: o.platform } : {}), ...(o.source ? { source: o.source } : {}), ...(o.fetch ? { fetch: o.fetch } : {}) });
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8') : randomBytes(24).toString('hex');
  if (!existsSync(tokenFile)) writeFileSync(tokenFile, token, { mode: 0o600 });
  const port = existsSync(portFile) ? Number(readFileSync(portFile, 'utf8')) : await freePort();
  if (!existsSync(portFile)) writeFileSync(portFile, String(port), { mode: 0o600 });
  let started = false;
  if (!await answers(port, token, 1500)) {
    started = true;
    writeFileSync(confFile, `host: 127.0.0.1\nport: ${port}\nserver_name: byokit\nauthorization { token: "${token}" }\njetstream { store_dir: "${storeDir}"\n sync_interval: always }\n`, { mode: 0o600 });
    chmodSync(confFile, 0o600);
    // The server logs to a file, not a pipe: the app may die and the server must outlive it, and a closed pipe would kill it.
    const fd = openSync(logFile, 'w', 0o600);
    const child = spawn(bin, ['-c', confFile], { stdio: ['ignore', fd, fd], env: {}, detached: true });
    closeSync(fd);
    let gone: number | undefined;
    child.once('exit', (code) => { gone = code ?? -1; });
    child.once('error', () => { gone = -1; });
    if (child.pid) writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
    child.unref();
    o.log?.(`nats: started pid ${child.pid} on 127.0.0.1:${port}`);
    let up = false;
    for (const end = Date.now() + (o.startMs ?? 10_000); !up && Date.now() < end;) {
      if (gone !== undefined) {
        const last = (readFileSync(logFile, 'utf8').trim().split('\n').pop() ?? '').slice(0, 300);
        if (/address already in use|bind/i.test(last)) throw new NatsError('port-taken', `nats: port ${port} is taken by another program, so the bus cannot start; remove ${portFile} to pick a new one (only if no NATS server is using ${storeDir})`, { detail: { port } });
        throw new NatsError('start-failed', `nats: the NATS server stopped at start (exit ${gone}): ${last}`, { detail: { exit: gone } });
      }
      up = await answers(port, token, 500) || (await wait(25), false);
    }
    if (!up) { child.kill(); throw new NatsError('start-failed', 'nats: the NATS server did not answer in time'); }
  }
  let stopped = false;
  return {
    url: `nats://127.0.0.1:${port}`, token, storeDir, started,
    health: () => answers(port, token, 1500),
    async stop() {
      if (stopped) return;
      stopped = true;
      const pid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : 0);
      if (!pid || !spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes(bin)) return;
      try { process.kill(pid, 'SIGTERM'); } catch { return; }
      for (let i = 0; i < 250; i++) { try { process.kill(pid, 0); } catch { return; } await wait(20); }
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    },
  };
}
