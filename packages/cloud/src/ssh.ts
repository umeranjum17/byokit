// SSH VM adapter (docs/cloud-kit.md section 7, './ssh' entry, Node only).
//
// One Linux machine the person already rents. The default transport for the portable
// core (ssh-vm.ts): the `ssh` binary the app passes by absolute path; every call carries
// a kit-owned config file, a fixed env built from nothing, and a pinned host key.
// An app's own transport (`transport` + `pins`) goes straight to the core.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { MachineError } from './errors.ts';
import {
  badOption, checkHost, checkPort, checkUser, sshCore, sshHostKey as transportHostKey, sshVm as transportVm,
  type SshForward, type SshTransport, type SshTransportHostKeyOptions, type SshTransportOptions,
} from './ssh-vm.ts';
import type { Price, Provider } from './types.ts';

export type { SshForward, SshPins, SshTarget, SshTransport, SshTransportHostKeyOptions, SshTransportOptions } from './ssh-vm.ts';
export { sshResolve } from './ssh-vm.ts';
export type { SshResolveOptions, SshResolver } from './ssh-vm.ts';

export type SshVmOptions = {
  ssh: string /* absolute */;
  host: string;
  port?: number;
  user: string;
  keyPath: string;
  stateDir: string;
  label: string;
  monthly?: Price;
};

export type SshHostKeyOptions = {
  ssh: string;
  host: string;
  port?: number;
  stateDir: string;
};

/** Per-stream output cap: the tail is kept (7.1). */
const STREAM_CAP = 8 * 1024 * 1024;
/** Local backstop past the remote timeout: SIGTERM, then SIGKILL 2 s later (7.1). */
const KILL_GRACE_MS = 15_000;
const KILL_WAIT_MS = 2_000;
/** `ssh-keyscan` timeout (7.2). */
const KEYSCAN_TIMEOUT_MS = 15_000;

const HOST_KEY_MISMATCH = ['REMOTE HOST IDENTIFICATION HAS CHANGED', 'Host key verification failed'];

const hasControlOrQuote = (p: string): boolean => /[%\"\x00-\x1f\x7f]/.test(p);

async function checkSshBin(ssh: string): Promise<void> {
  if (!isAbsolute(ssh)) throw badOption('bin', `ssh: must be an absolute path, got ${JSON.stringify(ssh)}`);
  try {
    await access(ssh, constants.X_OK);
  } catch {
    throw badOption('bin', `ssh: not executable, got ${JSON.stringify(ssh)}`);
  }
}

function checkFsPath(name: string, p: string): void {
  if (!isAbsolute(p) || hasControlOrQuote(p)) {
    throw badOption('path', `${name}: must be absolute and hold no %, " or control character, got ${JSON.stringify(p)}`);
  }
}

async function checkSshVmOptions(o: SshVmOptions): Promise<void> {
  await checkSshBin(o.ssh);
  checkFsPath('keyPath', o.keyPath);
  checkFsPath('stateDir', o.stateDir);
  checkHost(o.host);
  checkUser(o.user);
  checkPort(o.port);
}

async function checkSshHostKeyOptions(o: SshHostKeyOptions): Promise<void> {
  await checkSshBin(o.ssh);
  checkFsPath('stateDir', o.stateDir);
  checkHost(o.host);
  checkPort(o.port);
}

const sshConfigBytes = (keyPath: string, stateDir: string): string =>
  `# written by @byokit/cloud
IdentityFile "${keyPath}"
IdentitiesOnly yes
UserKnownHostsFile "${stateDir}/known_hosts"
StrictHostKeyChecking yes
UpdateHostKeys no
BatchMode yes
`;

/** Create `stateDir` at mode 0700 and write `ssh_config` at mode 0600 when its bytes differ. */
async function ensureState(o: { stateDir: string; keyPath: string }): Promise<string> {
  await mkdir(o.stateDir, { recursive: true, mode: 0o700 });
  const configPath = join(o.stateDir, 'ssh_config');
  const want = sshConfigBytes(o.keyPath, o.stateDir);
  let have: string | null = null;
  try {
    have = await readFile(configPath, 'utf8');
  } catch {
    have = null;
  }
  if (have !== want) {
    await writeFile(configPath, want, { mode: 0o600 });
    await chmod(configPath, 0o600);
  }
  return configPath;
}

const knownHostsPath = (stateDir: string): string => join(stateDir, 'known_hosts');

async function readKnownHosts(stateDir: string): Promise<string | null> {
  try {
    return await readFile(knownHostsPath(stateDir), 'utf8');
  } catch {
    return null;
  }
}

/** The `SHA256:` fingerprint of one base64 public key, as `ssh-keygen -l -E sha256` prints it. */
function fingerprintOfKey(base64Key: string): string {
  const raw = Buffer.from(base64Key, 'base64');
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}

const BASE64_KEY = /^[A-Za-z0-9+/]+={0,2}$/;

/** The fingerprint of the first parseable key line, or null when none is pinned. */
function pinnedFingerprint(knownHosts: string): string | null {
  for (const line of knownHosts.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(/\s+/);
    for (const field of fields.slice(1)) {
      if (field.length >= 16 && BASE64_KEY.test(field)) {
        try {
          return fingerprintOfKey(field);
        } catch {
          continue;
        }
      }
    }
  }
  return null;
}

/** Whether `known_hosts` holds exactly `base64Key` as a key field (7.2 `pinned`). */
function holdsKey(knownHosts: string, base64Key: string): boolean {
  for (const line of knownHosts.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (trimmed.split(/\s+/).slice(1).includes(base64Key)) return true;
  }
  return false;
}

function isHostKeyMismatch(stderr: string): boolean {
  return HOST_KEY_MISMATCH.some((marker) => stderr.includes(marker));
}

type SpawnResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const tail = (buf: Buffer): string =>
  (buf.length > STREAM_CAP ? buf.subarray(buf.length - STREAM_CAP) : buf).toString('utf8');

/**
 * Spawn `ssh` with an env built from nothing (`{ LANG: 'C.UTF-8' }` only). At
 * `timeoutMs` + 15 s the kit sends SIGTERM, then SIGKILL 2 s later, and resolves
 * `timedOut: true` (7.1).
 */
function runSsh(sshBin: string, args: readonly string[], o: { input?: Uint8Array; timeoutMs: number }): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(sshBin, args, { env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let termTimer: ReturnType<typeof setTimeout> | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let killed = false;
    const done = (code: number | null, timedOut: boolean): void => {
      if (termTimer !== null) clearTimeout(termTimer);
      if (killTimer !== null) clearTimeout(killTimer);
      resolve({
        code,
        stdout: tail(Buffer.concat(out)),
        stderr: tail(Buffer.concat(err)),
        timedOut,
      });
    };
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', () => done(null, false));
    child.on('close', (code) => done(code, killed));
    termTimer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; `close` reports it.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; `close` reports it.
        }
      }, KILL_WAIT_MS);
    }, o.timeoutMs + KILL_GRACE_MS);
    try {
      if (o.input !== undefined && o.input.length > 0) child.stdin.write(o.input);
      child.stdin.end();
    } catch {
      // A closed stdin carries no input; the command still runs.
    }
    child.stdin.on('error', () => undefined);
  });
}

/** `ssh-keyscan` from the same directory as `ssh`, env from nothing, 15 s timeout (7.2). */
function runKeyscan(keyscanBin: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return runSsh(keyscanBin, args, { timeoutMs: KEYSCAN_TIMEOUT_MS });
}

const sshArgv = (to: { host: string; port: number; user: string }, configPath: string, command: string): string[] => [
  '-F', configPath,
  '-p', String(to.port),
  '--', `${to.user}@${to.host}`,
  command,
];

/** Local backstop for a forward to come up, and how often it is probed meanwhile. */
const FORWARD_READY_MS = 30_000;
const FORWARD_PROBE_MS = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const accepts = (port: number): Promise<boolean> => new Promise((resolve) => {
  const probe = connect({ host: '127.0.0.1', port });
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
});

/** `ssh -N -L`: one local port to `remote` on the machine, ended by `close()` or when ssh exits (7.3). */
async function runForward(
  o: { ssh: string; keyPath: string; stateDir: string }, to: { host: string; port: number; user: string },
  remote: { host: '127.0.0.1'; port: number },
): Promise<SshForward> {
  await checkSshBin(o.ssh);
  checkFsPath('keyPath', o.keyPath);
  checkFsPath('stateDir', o.stateDir);
  checkHost(to.host);
  checkUser(to.user);
  checkPort(to.port);
  checkPort(remote.port);
  const configPath = await ensureState(o);
  const localPort = await freeLoopbackPort();
  const child = spawn(o.ssh, [
    '-F', configPath, '-N',
    '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${localPort}:${remote.host}:${remote.port}`,
    '-p', String(to.port), '--', `${to.user}@${to.host}`,
  ], { env: { LANG: 'C.UTF-8' }, stdio: ['ignore', 'ignore', 'pipe'] });
  const err: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
  let exit: number | null | undefined;
  const closed = new Promise<void>((resolve) => {
    child.on('error', () => { exit = null; resolve(); });
    child.on('close', (code) => { exit = code; resolve(); });
  });
  const close = async (): Promise<void> => {
    if (exit !== undefined) return;
    child.kill('SIGTERM');
    const killer = setTimeout(() => child.kill('SIGKILL'), KILL_WAIT_MS);
    await closed;
    clearTimeout(killer);
  };
  for (const end = Date.now() + FORWARD_READY_MS; ; await sleep(FORWARD_PROBE_MS)) {
    if (exit !== undefined) {
      const stderr = tail(Buffer.concat(err));
      if (isHostKeyMismatch(stderr)) throw new MachineError('host-key', 'the pinned host key no longer matches');
      throw new MachineError('unreachable', exit === null ? 'ssh did not start' : `ssh exited ${exit}: ${stderr.slice(-200)}`);
    }
    if (await accepts(localPort) && exit === undefined) break;
    if (Date.now() > end) {
      await close();
      throw new MachineError('timeout', 'ssh took too long to open the forward');
    }
  }
  return { localPort, close, closed };
}

/** The Node transport: the app's `ssh` binary, its kit-owned config and `known_hosts` (7.1). */
function binTransport(o: { ssh: string; keyPath: string; stateDir: string }): Omit<SshTransport, 'hostKey'> {
  return {
    forward: (to, remote) => runForward(o, to, remote),
    exec: async (to, command, x) => {
      const configPath = await ensureState(o);
      const r = await runSsh(o.ssh, sshArgv(to, configPath, command), x);
      if (r.timedOut) return { code: r.code ?? 124, stdout: r.stdout, stderr: r.stderr, timedOut: true };
      if (r.code === 255 && isHostKeyMismatch(r.stderr)) {
        throw new MachineError('host-key', 'the pinned host key no longer matches');
      }
      if (r.code === 255) throw new MachineError('unreachable', `ssh exited 255: ${r.stderr.slice(-200)}`);
      if (r.code === null) throw new MachineError('unreachable', 'ssh did not start');
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}

/** The `ssh` binary by default; `transport` + `pins` run the portable core with the app's own transport. */
export function sshVm(o: SshVmOptions | SshTransportOptions): Provider {
  if ('transport' in o) return transportVm(o);
  const pins = { load: async () => pinnedFingerprint((await readKnownHosts(o.stateDir)) ?? '') };
  return sshCore({ ...o, transport: binTransport(o), pins }, () => checkSshVmOptions(o));
}

const KEYSCAN_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'] as const;

/** Parse `ssh-keyscan` lines, preferring ed25519, then ecdsa, then rsa (7.2). */
function pickScannedKey(stdout: string): { type: string; key: string } | null {
  const found = new Map<string, { type: string; key: string }>();
  for (const line of stdout.split('\n')) {
    const fields = line.trim().split(/\s+/);
    for (let i = 0; i + 1 < fields.length; i++) {
      const type = (KEYSCAN_TYPES as readonly string[]).indexOf(fields[i]) >= 0 ? fields[i] : null;
      const key = fields[i + 1] ?? '';
      if (type !== null && key.length >= 16 && BASE64_KEY.test(key) && !found.has(type)) {
        found.set(type, { type, key });
      }
    }
  }
  for (const type of KEYSCAN_TYPES) {
    const hit = found.get(type);
    if (hit !== undefined) return hit;
  }
  return null;
}

/** The server's preferred host key, read with `ssh-keyscan` from the directory of `ssh` (7.2). */
async function scanHostKey(o: SshHostKeyOptions): Promise<{ type: string; key: string; fingerprint: string }> {
  await checkSshHostKeyOptions(o);
  const keyscanBin = join(dirname(o.ssh), 'ssh-keyscan');
  const args = ['-p', String(o.port ?? 22), '-t', 'ed25519,ecdsa,rsa', '--', o.host];
  let r: { code: number | null; stdout: string; stderr: string; timedOut: boolean };
  try {
    r = await runKeyscan(keyscanBin, args);
  } catch {
    throw new MachineError('unreachable', `ssh-keyscan did not start: ${JSON.stringify(keyscanBin)}`);
  }
  if (r.timedOut) throw new MachineError('timeout', 'ssh-keyscan took too long to answer');
  if (r.code !== 0) throw new MachineError('unreachable', `ssh-keyscan exited ${String(r.code)}: ${r.stderr.slice(-200)}`);
  const scanned = pickScannedKey(r.stdout);
  if (scanned === null) throw new MachineError('unreachable', 'ssh-keyscan returned no host key');
  return { ...scanned, fingerprint: fingerprintOfKey(scanned.key) };
}

/** The Node transport as one object: `exec` and `forward` over the `ssh` binary and the key at `keyPath`, `hostKey` over `ssh-keyscan`. */
export function sshTransport(o: { ssh: string; keyPath: string; stateDir: string }): SshTransport {
  return {
    ...binTransport(o),
    hostKey: async ({ host, port }) => ({ fingerprint: (await scanHostKey({ ssh: o.ssh, stateDir: o.stateDir, host, port })).fingerprint }),
  };
}

export function sshHostKey(o: SshHostKeyOptions | SshTransportHostKeyOptions):
  Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }> {
  if ('transport' in o) return transportHostKey(o);
  const run = async (): Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }> => {
    const scanned = await scanHostKey(o);
    await mkdir(o.stateDir, { recursive: true, mode: 0o700 });
    const { fingerprint } = scanned;
    const known = await readKnownHosts(o.stateDir);
    const pinned = known !== null && holdsKey(known, scanned.key);
    return {
      fingerprint,
      pinned,
      confirm: async () => {
        await mkdir(o.stateDir, { recursive: true, mode: 0o700 });
        const path = knownHostsPath(o.stateDir);
        await writeFile(path, `${o.host} ${scanned.type} ${scanned.key}\n`, { mode: 0o600 });
        await chmod(path, 0o600);
      },
    };
  };
  return run();
}
