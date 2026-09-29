// SSH VM adapter (docs/machine-kit.md section 7, './ssh' entry, Node only).
//
// One Linux machine the person already rents. `exec`, `write` and `adopt` only,
// through the `ssh` binary the app passes by absolute path; every call carries a
// kit-owned config file, a fixed env built from nothing, and a pinned host key.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { MachineError } from './errors.ts';
import type { ExecResult, MachineRef, Price, Provider } from './types.ts';

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
/** Default remote timeout for calls that take none (status, write). */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Local backstop past the remote timeout: SIGTERM, then SIGKILL 2 s later (7.1). */
const KILL_GRACE_MS = 15_000;
const KILL_WAIT_MS = 2_000;
/** `ssh-keyscan` timeout (7.2). */
const KEYSCAN_TIMEOUT_MS = 15_000;

const HOST_KEY_MISMATCH = ['REMOTE HOST IDENTIFICATION HAS CHANGED', 'Host key verification failed'];

const badOption = (why: string, message: string): MachineError =>
  new MachineError('unreachable', message, { why });

const hasControlOrQuote = (p: string): boolean => /[%\"\x00-\x1f\x7f]/.test(p);

async function checkSshBin(ssh: string): Promise<void> {
  if (!isAbsolute(ssh)) throw badOption('bin', `ssh: must be an absolute path, got ${JSON.stringify(ssh)}`);
  try {
    await access(ssh, constants.X_OK);
  } catch {
    throw badOption('bin', `ssh: not executable, got ${JSON.stringify(ssh)}`);
  }
}

function checkHost(host: string): void {
  if (host.length === 0 || host.startsWith('-') || /\s/.test(host)) {
    throw badOption('host', `host: must not start with - or hold whitespace, got ${JSON.stringify(host)}`);
  }
}

function checkPort(port: number | undefined): void {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw badOption('port', `port: must be an integer 1-65535, got ${JSON.stringify(port)}`);
  }
}

function checkFsPath(name: string, p: string): void {
  if (!isAbsolute(p) || hasControlOrQuote(p)) {
    throw badOption('path', `${name}: must be absolute and hold no %, " or control character, got ${JSON.stringify(p)}`);
  }
}

function checkUser(user: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
    throw badOption('user', `user: must match ^[a-z_][a-z0-9_-]{0,31}$, got ${JSON.stringify(user)}`);
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

/** POSIX single-quote quoting (6.4): `'` becomes `'\''`. NUL rejects `bad-recipe`. */
function quoteArgv(argv: readonly string[]): string {
  for (const arg of argv) {
    if (arg.includes('\0')) {
      throw new MachineError('bad-recipe', `argv: NUL byte in ${JSON.stringify(arg.slice(0, 32))}`);
    }
  }
  return argv.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`).join(' ');
}

const sshConfigBytes = (keyPath: string, stateDir: string): string =>
  `# written by @byokit/machine
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

/** The remote command: `timeout -k 10 <s> <argv>`, after `sudo -n` when root applies (7.1). */
function remoteCommand(o: { user: string }, argv: readonly string[], execOpts: { timeoutMs: number; root?: boolean }): string {
  const secs = Math.ceil(execOpts.timeoutMs / 1000);
  const inner = `timeout -k 10 ${secs} ${quoteArgv(argv)}`;
  // No `sudo -n` prefix when the machine login already is root.
  return execOpts.root === true && o.user !== 'root' ? `sudo -n ${inner}` : inner;
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

const sshArgv = (o: SshVmOptions, configPath: string, command: string): string[] => [
  '-F', configPath,
  '-p', String(o.port ?? 22),
  '--', `${o.user}@${o.host}`,
  command,
];

export function sshVm(o: SshVmOptions): Provider {
  const target = (): string => `${o.user}@${o.host}:${o.port ?? 22}`;

  /** Every call first: options, then the host-key gate, then the kit-owned config. */
  const gate = async (): Promise<string> => {
    await checkSshVmOptions(o);
    const known = await readKnownHosts(o.stateDir);
    if (pinnedFingerprint(known ?? '') === null) {
      throw new MachineError('host-key', 'no host key is pinned yet; confirm it with sshHostKey() first');
    }
    return ensureState(o);
  };

  const runRemote = async (
    argv: readonly string[],
    execOpts: { timeoutMs: number; root?: boolean; input?: Uint8Array },
  ): Promise<ExecResult> => {
    // Quote (and NUL-check) argv before the gate, so a caller bug fails even unpinned.
    const command = remoteCommand(o, argv, execOpts);
    const configPath = await gate();
    const r = await runSsh(o.ssh, sshArgv(o, configPath, command), { input: execOpts.input, timeoutMs: execOpts.timeoutMs });
    if (r.timedOut) return { code: r.code ?? 124, stdout: r.stdout, stderr: r.stderr, timedOut: true };
    if (r.code === 255 && isHostKeyMismatch(r.stderr)) {
      throw new MachineError('host-key', 'the pinned host key no longer matches');
    }
    if (r.code === 255) throw new MachineError('unreachable', `ssh exited 255: ${r.stderr.slice(-200)}`);
    if (r.code === null) throw new MachineError('unreachable', 'ssh did not start');
    return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.code === 124 || r.code === 137 };
  };

  const provider: Provider = {
    id: 'ssh-vm',
    label: o.label,
    account: async () => {
      await checkSshVmOptions(o);
      return target();
    },
    sizes: () => [],
    prices: () => (o.monthly ? [o.monthly] : []),
    status: async (_m: MachineRef) => {
      await checkSshVmOptions(o);
      const known = await readKnownHosts(o.stateDir);
      if (pinnedFingerprint(known ?? '') === null) return 'unknown';
      const configPath = await ensureState(o);
      const command = `timeout -k 10 ${Math.ceil(DEFAULT_TIMEOUT_MS / 1000)} true`;
      const r = await runSsh(o.ssh, sshArgv(o, configPath, command), { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (r.timedOut) return 'unknown';
      if (r.code === 0) return 'on';
      if (r.code === 255 && isHostKeyMismatch(r.stderr)) return 'host-key-changed';
      return 'unknown';
    },
    exec: (_m: MachineRef, argv: readonly string[], execOpts: { timeoutMs: number; root?: boolean; input?: Uint8Array }) =>
      runRemote(argv, execOpts),
    write: async (m: MachineRef, path: string, bytes: Uint8Array, mode: number) => {
      void m;
      const script = 'umask 077 && t=$(mktemp "$(dirname "$1")/.byokit-XXXXXX") && cat > "$t" && chmod "$2" "$t" && mv -f "$t" "$1"';
      const r = await runRemote(['sh', '-c', script, 'sh', path, mode.toString(8)], { timeoutMs: DEFAULT_TIMEOUT_MS, input: bytes });
      if (r.code !== 0) {
        throw new MachineError('provider', `write failed with exit ${r.code}: ${r.stderr.slice(-200)}`);
      }
    },
    adopt: async () => {
      await checkSshVmOptions(o);
      const known = await readKnownHosts(o.stateDir);
      const fingerprint = known !== null ? pinnedFingerprint(known) : null;
      if (fingerprint === null) {
        throw new MachineError('host-key', 'no host key is pinned yet; confirm it with sshHostKey() first');
      }
      return fingerprint;
    },
  };
  return provider;
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

export function sshHostKey(o: SshHostKeyOptions):
  Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }> {
  const run = async (): Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }> => {
    await checkSshHostKeyOptions(o);
    await mkdir(o.stateDir, { recursive: true, mode: 0o700 });
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
    const fingerprint = fingerprintOfKey(scanned.key);
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
