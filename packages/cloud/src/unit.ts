// Unit file rendering (docs/cloud-kit.md 8.4), pure, plus the install-time unit writers
// (8.3 steps 8-9). The per-user writer is exported for reuse: a later service kit writes
// and enables per-user units the same way. The rendered bytes are the golden
// files in test/golden/.
import { MachineError } from './errors.ts';
import type { ExecResult, HostRecipe } from './types.ts';

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/** Double-quote one ExecStart/ExecStartPre argument (8.4: \ → \\, " → \", % → %%, $ → $$). */
export function quoteArg(arg: string): string {
  return `"${arg.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/** Double-quote one Environment value (8.4: like quoteArg but $ stays). */
export function quoteEnv(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
}

/**
 * Render `byokit-<name>.service`. `runUser` is the recipe's user or the machine user;
 * `nodePath` is the resolved node binary (8.3 step 4); `selfId` adds the copy-detection
 * boot probe (8.7, present once M6 records its argv).
 */
export function renderUnit(
  r: Pick<HostRecipe, 'name' | 'workDir' | 'run'>,
  o: { kind: 'system' | 'user'; runUser: string; nodePath: string; selfId: boolean },
): string {
  const binDir = o.nodePath.slice(0, o.nodePath.lastIndexOf('/'));
  const lines = [
    '[Unit]',
    `Description=byokit ${r.name}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
  ];
  if (o.kind === 'system') lines.push(`User=${o.runUser}`);
  lines.push(`WorkingDirectory=${r.workDir}`);
  const env = Object.entries(r.run.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!Object.hasOwn(r.run.env, 'PATH')) lines.push(`Environment="PATH=${binDir}:${SYSTEM_PATH}"`);
  for (const [name, value] of env) lines.push(`Environment=${quoteEnv(`${name}=${value}`)}`);
  if (o.selfId) lines.push(`ExecStartPre=-${quoteArg(o.nodePath)} ${quoteArg(`${r.workDir}/.byokit/boot.mjs`)}`);
  const [first, ...rest] = r.run.argv;
  const start = first === 'node' ? o.nodePath : first;
  lines.push(`ExecStart=${quoteArg(start)}${rest.map((a) => ` ${quoteArg(a)}`).join('')}`);
  lines.push('Restart=always', 'RestartSec=5', '', '[Install]', `WantedBy=${o.kind === 'system' ? 'multi-user.target' : 'default.target'}`, '');
  return lines.join('\n');
}

/** The 8.3 step 2 probe: Linux, arch, systemd, machine user and home, one per line. */
export const PROBE_SHELL = 'uname -s; uname -m; systemctl --version | head -n 1; id -un; getent passwd "$(id -un)" | cut -d: -f6';

/** Argv run in a work directory with a node bin dir first on PATH (8.2). */
export const WORKDIR_SHELL = 'cd "$1" && PATH="$2:$PATH" && shift 2 && exec "$@"';

/** The 7.1 write shell: stdin bytes land at `$1` with octal mode `$2`, atomically. */
export const WRITE_SHELL = 'umask 077 && t=$(mktemp "$(dirname "$1")/.byokit-XXXXXX") && cat > "$t" && chmod "$2" "$t" && mv -f "$t" "$1"';

/** A delivered inbox or outbox file name (5.8). */
export const FILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The 5.8 deliver shell: stdin bytes land at `$1/$2` at mode 0600. */
export const DELIVER_SHELL = 'umask 077 && mkdir -p "$1" && t=$(mktemp "$1/.in-XXXXXX") && cat > "$t" && mv -f "$t" "$1/$2"';

/** The newest outbox file whose name starts with `$2` in directory `$1`: its name on the first line, then its bytes; nothing while none. */
export const NEWEST_SHELL = 'cd "$1" 2>/dev/null || exit 0; f=$(ls -tp -- "$2"* 2>/dev/null | grep -v / | head -n 1); [ -n "$f" ] || exit 0; printf "%s\\n" "$f"; cat -- "$f"'

/** Removes the outbox files (not directories) in `$1` whose name starts with `$2`; nothing while there is no outbox. */
export const CLEAR_SHELL = 'cd "$1" 2>/dev/null || exit 0; for f in "$2"*; do if [ -f "$f" ]; then rm -f -- "$f" || exit 1; fi; done'

/** Exit 0 when something listens on the machine's loopback at port `$1`, read from /proc so no `ss` is needed (9.1). */
export const LISTEN_SHELL = 'p=$(printf "%04X" "$1") && grep -Eqs "^ *[0-9]+: (0100007F|00000000|00000000000000000000000001000000|0000000000000000FFFF00000100007F|00000000000000000000000000000000):$p [0-9A-F]+:[0-9A-F]{4} 0A " /proc/net/tcp /proc/net/tcp6';

/** The drop-in 0.2.x to 0.4.0 wrote when they joined the machine to the person's tailnet (9.3). */
export const TAILSCALE_DROP_IN = '/etc/systemd/system/tailscaled.service.d/byokit.conf';

/**
 * 9.3's one-time cleanup, as root, only while `TAILSCALE_DROP_IN` exists: sign the machine out, stop tailscaled, and
 * remove the drop-in, the unit the kit wrote (only when its bytes are the kit's) and the node identity in /etc/tailscale.
 * A Tailscale the person installed themselves has no kit drop-in and is never touched.
 */
export const TAILSCALE_CLEANUP_SHELL = `d=/etc/systemd/system/tailscaled.service.d
test -e "$d/byokit.conf" || exit 0
timeout 30 tailscale logout || echo 'Signing this cloud computer out of Tailscale failed: remove it on your Tailscale admin page.' >&2
systemctl disable --now tailscaled 2>/dev/null
if systemctl is-active --quiet tailscaled; then echo 'tailscaled is still running' >&2; exit 1; fi
u=/etc/systemd/system/tailscaled.service
if printf '[Unit]\\nDescription=Tailscale node agent\\nAfter=network.target\\n[Service]\\nExecStart=/usr/sbin/tailscaled --state=/etc/tailscale/tailscaled.state\\nRuntimeDirectory=tailscale\\nRestart=on-failure\\n[Install]\\nWantedBy=multi-user.target\\n' | cmp -s - "$u"; then rm -f "$u" || exit 1; fi
rm -f "$d/byokit.conf" && { rmdir "$d" 2>/dev/null || true; } && rm -rf /etc/tailscale && systemctl daemon-reload`;

/** A system unit's path for an app name. */
export const systemUnitPath = (name: string): string => `/etc/systemd/system/byokit-${name}.service`;

/** A user unit's directory under a machine home. */
export const userUnitDir = (home: string): string => `${home}/.config/systemd/user`;

/** A user unit's path under a machine home. */
export const userUnitPath = (home: string, name: string): string => `${userUnitDir(home)}/byokit-${name}.service`;

export type UnitExec = (
  argv: readonly string[],
  o: { timeoutMs: number; root?: boolean; input?: Uint8Array },
) => Promise<ExecResult>;

/** Write one unit file at mode 0644 through `exec` with `input` (8.3 step 8). */
export async function writeUnitFile(
  exec: UnitExec,
  path: string,
  bytes: string,
  o: { timeoutMs: number; root?: boolean },
): Promise<void> {
  const opts: { timeoutMs: number; root?: boolean; input?: Uint8Array } = { timeoutMs: o.timeoutMs };
  if (o.root === true) opts.root = true;
  opts.input = new TextEncoder().encode(bytes);
  const r = await exec(['sh', '-c', WRITE_SHELL, 'sh', path, '644'], opts);
  if (r.code !== 0) {
    throw new MachineError('provider', `write ${path} failed with exit ${r.code}: ${r.stderr.slice(-200)}`);
  }
}

/**
 * Write and enable one per-user systemd unit (8.3 steps 8-9, user half): the unit
 * directory, the 0644 unit file as the machine user, `loginctl enable-linger`,
 * then `daemon-reload` and `enable --now`. A linger refusal rejects `linger` with
 * `extra.command` holding the line to run; the kit never escalates.
 */
export async function writeUserUnit(o: {
  exec: UnitExec; home: string; name: string; bytes: string; machineUser: string; timeoutMs: number;
}): Promise<void> {
  const unit = `byokit-${o.name}.service`;
  const dir = userUnitDir(o.home);
  const made = await o.exec(['mkdir', '-p', dir], { timeoutMs: o.timeoutMs });
  if (made.code !== 0) {
    throw new MachineError('provider', `mkdir ${dir} failed with exit ${made.code}: ${made.stderr.slice(-200)}`);
  }
  await writeUnitFile(o.exec, `${dir}/${unit}`, o.bytes, { timeoutMs: o.timeoutMs });
  const linger = await o.exec(['loginctl', 'enable-linger', o.machineUser], { timeoutMs: o.timeoutMs });
  if (linger.code !== 0) {
    throw new MachineError(
      'linger',
      `loginctl enable-linger ${o.machineUser} was refused`,
      { command: `sudo loginctl enable-linger ${o.machineUser}` },
    );
  }
  const enables: readonly (readonly string[])[] = [
    ['systemctl', '--user', 'daemon-reload'],
    ['systemctl', '--user', 'enable', '--now', unit],
  ];
  for (const argv of enables) {
    const r = await o.exec(argv, { timeoutMs: o.timeoutMs });
    if (r.code !== 0) {
      throw new MachineError('provider', `${argv.join(' ')} failed with exit ${r.code}: ${r.stderr.slice(-200)}`);
    }
  }
}
