// SSH VM adapter core (docs/cloud-kit.md section 7, K-PHONE-SSH), portable: no `node:*` import.
//
// The app supplies the SSH transport: a React Native app its own SSH module, while './ssh'
// keeps the Node default over the `ssh` binary. The kit owns everything above the wire: option
// rules, quoting, `sudo -n` and `timeout` wrapping, the pinned host key gate and the error codes.
import { MachineError } from './errors.ts';
import type { ExecResult, MachineRef, Price, Provider } from './types.ts';

/** Where one call goes: the transport must refuse a server whose host key is not `fingerprint`. */
export type SshTarget = { host: string; port: number; user: string; fingerprint: string };

/** One local port that carries connections to a port on the machine's loopback, until `close()` or the connection drops. */
export type SshForward = { localPort: number; close(): Promise<void>; closed: Promise<void> };

/**
 * The SSH connection the app supplies (7.3). A transport throws `MachineError('host-key')` when the server's
 * key differs from `to.fingerprint`, before it authenticates; any other throw reads as `unreachable` with its
 * message. It gives up at `timeoutMs` + 15 s and resolves `timedOut: true`.
 */
export type SshTransport = {
  /** Run one remote command line (already quoted by the kit) as `to.user`, with `input` on its stdin. */
  exec(to: SshTarget, command: string, o: { input?: Uint8Array; timeoutMs: number }): Promise<{ code: number; stdout: string; stderr: string; timedOut?: boolean }>;
  /** The server's host key as `SHA256:<base64, no padding>` (what `ssh-keygen -l` prints), read before any login. */
  hostKey(to: { host: string; port: number }): Promise<{ fingerprint: string }>;
  /** Optional, e.g. over SFTP: replace `path` with `bytes` at `mode` atomically. Absent: the kit's 7.1 shell over `exec`. */
  write?(to: SshTarget, path: string, bytes: Uint8Array, mode: number): Promise<void>;
  /**
   * Optional: listen on `127.0.0.1:<localPort>` on this device and carry each connection to `remote` on the machine
   * (an SSH local forward, so the app port stays on the machine's loopback). The same host-key rule as `exec`.
   * `closed` settles when the forward ends, however it ends.
   */
  forward?(to: SshTarget, remote: { host: '127.0.0.1'; port: number }): Promise<SshForward>;
};

/** Where the app keeps the one confirmed host key fingerprint (its own secure store on a phone). */
export type SshPins = { load(): Promise<string | null>; save(fingerprint: string): Promise<void> };

export type SshTransportOptions = {
  transport: SshTransport; pins: SshPins;
  host: string; port?: number; user: string; label: string; monthly?: Price;
};
export type SshTransportHostKeyOptions = { transport: SshTransport; pins: SshPins; host: string; port?: number };

/** Per-stream output cap: the tail is kept (7.1). */
const STREAM_CAP = 8 * 1024 * 1024;
/** Default remote timeout for calls that take none (status, write). */
const DEFAULT_TIMEOUT_MS = 30_000;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
export const WRITE_SCRIPT = 'umask 077 && t=$(mktemp "$(dirname "$1")/.byokit-XXXXXX") && cat > "$t" && chmod "$2" "$t" && mv -f "$t" "$1"';

export const badOption = (why: string, message: string): MachineError =>
  new MachineError('unreachable', message, { why });

export function checkHost(host: string): void {
  if (typeof host !== 'string' || host.length === 0 || host.startsWith('-') || /\s/.test(host)) {
    throw badOption('host', `host: must not start with - or hold whitespace, got ${JSON.stringify(host)}`);
  }
}

export function checkPort(port: number | undefined): void {
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw badOption('port', `port: must be an integer 1-65535, got ${JSON.stringify(port)}`);
  }
}

export function checkUser(user: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
    throw badOption('user', `user: must match ^[a-z_][a-z0-9_-]{0,31}$, got ${JSON.stringify(user)}`);
  }
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

/** The remote command: `timeout -k 10 <s> <argv>`, after `sudo -n` when root applies (7.1). */
function remoteCommand(user: string, argv: readonly string[], o: { timeoutMs: number; root?: boolean }): string {
  const inner = `timeout -k 10 ${Math.ceil(o.timeoutMs / 1000)} ${quoteArgv(argv)}`;
  // No `sudo -n` prefix when the machine login already is root.
  return o.root === true && user !== 'root' ? `sudo -n ${inner}` : inner;
}

/** A transport's own failure keeps its real cause; only a `MachineError` keeps its code. */
async function via<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof MachineError) throw e;
    throw new MachineError('unreachable', `the SSH connection failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
  }
}

const NO_PIN = 'no host key is pinned yet; confirm it with sshHostKey() first';

/** The core './ssh' and '.' share: `check` runs each entry's option rules first (7.1). */
export function sshCore(
  o: Omit<SshTransportOptions, 'transport' | 'pins'> & { transport: Omit<SshTransport, 'hostKey'>; pins: Pick<SshPins, 'load'> },
  check: () => void | Promise<void>,
): Provider {
  const port = o.port ?? 22;
  const account = async (): Promise<string> => {
    await check();
    return `${o.user}@${o.host}:${port}`;
  };
  const pinned = async (): Promise<string> => {
    await check();
    const fingerprint = await o.pins.load();
    if (fingerprint === null) throw new MachineError('host-key', NO_PIN);
    return fingerprint;
  };
  const exec = async (argv: readonly string[], x: { timeoutMs: number; root?: boolean; input?: Uint8Array }): Promise<ExecResult> => {
    // Quote (and NUL-check) argv before the gate, so a caller bug fails even unpinned.
    const command = remoteCommand(o.user, argv, x);
    const to: SshTarget = { host: o.host, port, user: o.user, fingerprint: await pinned() };
    const r = await via(() => o.transport.exec(to, command, { input: x.input, timeoutMs: x.timeoutMs }));
    const out = { stdout: r.stdout.slice(-STREAM_CAP), stderr: r.stderr.slice(-STREAM_CAP) };
    return { code: r.code, ...out, timedOut: r.timedOut === true || r.code === 124 || r.code === 137 };
  };
  const adopt = pinned;
  return {
    id: 'ssh-vm',
    label: o.label,
    account,
    sizes: () => [],
    prices: () => (o.monthly ? [o.monthly] : []),
    status: async (_m: MachineRef) => {
      await check();
      const fingerprint = await o.pins.load();
      if (fingerprint === null) return 'unknown';
      try {
        const command = remoteCommand(o.user, ['true'], { timeoutMs: DEFAULT_TIMEOUT_MS });
        const r = await o.transport.exec({ host: o.host, port, user: o.user, fingerprint }, command, { timeoutMs: DEFAULT_TIMEOUT_MS });
        return r.timedOut !== true && r.code === 0 ? 'on' : 'unknown';
      } catch (e) {
        return e instanceof MachineError && e.code === 'host-key' ? 'host-key-changed' : 'unknown';
      }
    },
    exec: (_m: MachineRef, argv: readonly string[], x: { timeoutMs: number; root?: boolean; input?: Uint8Array }) => exec(argv, x),
    write: async (_m: MachineRef, path: string, bytes: Uint8Array, mode: number) => {
      const { write } = o.transport;
      if (write !== undefined) {
        const to: SshTarget = { host: o.host, port, user: o.user, fingerprint: await pinned() };
        return via(() => write(to, path, bytes, mode));
      }
      const r = await exec(['sh', '-c', WRITE_SCRIPT, 'sh', path, mode.toString(8)], { timeoutMs: DEFAULT_TIMEOUT_MS, input: bytes });
      if (r.code !== 0) throw new MachineError('provider', `write failed with exit ${r.code}: ${r.stderr.slice(-200)}`);
    },
    adopt,
    // The one computer the app was pointed at, so setup()'s existing-computer path runs its 5.2a checks here too.
    list: async () => [{ provider: 'ssh-vm', account: await account(), id: await adopt(), name: 'computer', keepCopies: false }],
  };
}

/** One Linux machine reached over the app's own SSH transport (React Native, or any runtime without Node). */
export function sshVm(o: SshTransportOptions): Provider {
  return sshCore(o, () => {
    if (typeof o.transport?.exec !== 'function') throw badOption('transport', 'transport: pass the app SSH transport; on Node, import @byokit/cloud/ssh for the ssh binary');
    checkHost(o.host);
    checkUser(o.user);
    checkPort(o.port);
  });
}

/** First connect (7.2) over the app's transport: the fingerprint to compare, whether it is pinned, and `confirm()`. */
export async function sshHostKey(o: SshTransportHostKeyOptions): Promise<{ fingerprint: string; pinned: boolean; confirm(): Promise<void> }> {
  if (typeof o.transport?.hostKey !== 'function') throw badOption('transport', 'transport: pass the app SSH transport; on Node, import @byokit/cloud/ssh for the ssh binary');
  checkHost(o.host);
  checkPort(o.port);
  const { fingerprint } = await via(() => o.transport.hostKey({ host: o.host, port: o.port ?? 22 }));
  if (typeof fingerprint !== 'string' || !FINGERPRINT.test(fingerprint)) {
    throw new MachineError('unreachable', 'the SSH transport returned no SHA256 host key fingerprint');
  }
  return { fingerprint, pinned: (await o.pins.load()) === fingerprint, confirm: () => o.pins.save(fingerprint) };
}

export type SshResolveOptions = {
  transport: Pick<SshTransport, 'forward'>; pins: Pick<SshPins, 'load'>;
  /** The machine's SSH login, and the app port that listens on its loopback. */
  target: { host: string; port?: number; user: string }; port: number;
};
/** A `Dial.resolve` for `@byokit/pair`; `close()` ends the forward it holds. */
export type SshResolver = ((url: string) => Promise<string>) & { close(): Promise<void> };

const LOOPBACK_URL = /^(wss?:\/\/)(?:127\.0\.0\.1|localhost):(\d+)(?=[/?#]|$)/;

/**
 * A `Dial.resolve` that reaches the app on the machine's loopback through one SSH forward (7.3): it opens the
 * forward before the first dial, reuses it while it is up, opens a new one after it drops, and rewrites
 * `ws://127.0.0.1:<port>…` to the forward's local port. Any other address passes through untouched.
 */
export function sshResolve(o: SshResolveOptions): SshResolver {
  if (typeof o.transport?.forward !== 'function') throw badOption('transport', 'transport: pass an SSH transport that implements forward');
  checkHost(o.target.host);
  checkUser(o.target.user);
  checkPort(o.target.port);
  checkPort(o.port);
  const { forward } = o.transport;
  let open: Promise<SshForward> | null = null;
  const opened = (): Promise<SshForward> => {
    if (open !== null) return open;
    const next = (async () => {
      const fingerprint = await o.pins.load();
      if (fingerprint === null) throw new MachineError('host-key', NO_PIN);
      const to: SshTarget = { host: o.target.host, port: o.target.port ?? 22, user: o.target.user, fingerprint };
      const f = await via(() => forward(to, { host: '127.0.0.1', port: o.port }));
      void f.closed.then(() => { if (open === next) open = null; });
      return f;
    })();
    open = next;
    next.catch(() => { if (open === next) open = null; });
    return next;
  };
  const resolve = async (url: string): Promise<string> => {
    const m = LOOPBACK_URL.exec(url);
    if (m === null || Number(m[2]) !== o.port) return url;
    const { localPort } = await opened();
    return `${m[1]}127.0.0.1:${localPort}${url.slice(m[0].length)}`;
  };
  return Object.assign(resolve, {
    close: async () => {
      const current = open;
      open = null;
      if (current !== null) await (await current.catch(() => null))?.close();
    },
  });
}
