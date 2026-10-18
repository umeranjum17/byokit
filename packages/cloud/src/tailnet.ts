import { MachineError } from './errors.ts';
import { words } from './words.ts';
import type { MachineRef, Provider, Tailnet, TailnetStep } from './types.ts';

// Boat keeps /etc across wakes, unlike /var. This identity is included in disk copies.
// $1 is a root prefix for tests (empty on a machine); the kit never passes one.
export const BOOTSTRAP = `set -eu
root=\${1:-}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
changed=0
if command -v tailscale >/dev/null && command -v tailscaled >/dev/null; then
  daemon=$(command -v tailscaled)
else
  case $(uname -m) in
    x86_64) arch=amd64; sha=108d1d96ecf410d305571e173516f27038f870919a9b89c914a167c6d33a4528 ;;
    aarch64|arm64) arch=arm64; sha=f60294374967f3dfd8cf57bbbd474d6cfce32d123e3a8ddeab82a87940daa806 ;;
    *) echo 'Unsupported Tailscale architecture' >&2; exit 1 ;;
  esac
  archive=tailscale_1.104.1_$arch
  curl -fsSL "https://pkgs.tailscale.com/stable/$archive.tgz" -o "$tmp/tailscale.tgz"
  printf '%s  %s\\n' "$sha" "$tmp/tailscale.tgz" | sha256sum -c -
  tar -xzf "$tmp/tailscale.tgz" -C "$tmp" "$archive/tailscale" "$archive/tailscaled"
  install -d "$root/usr/bin" "$root/usr/sbin" "$root/etc/systemd/system"
  install -m 0755 "$tmp/$archive/tailscale" "$root/usr/bin/tailscale"
  install -m 0755 "$tmp/$archive/tailscaled" "$root/usr/sbin/tailscaled"
  daemon="$root/usr/sbin/tailscaled"
  printf '[Unit]\\nDescription=Tailscale node agent\\nAfter=network.target\\n[Service]\\nExecStart=%s --state=%s/etc/tailscale/tailscaled.state\\nRuntimeDirectory=tailscale\\nRestart=on-failure\\n[Install]\\nWantedBy=multi-user.target\\n' "$daemon" "$root" > "$tmp/tailscaled.service"
  install -m 0644 "$tmp/tailscaled.service" "$root/etc/systemd/system/tailscaled.service"
  changed=1
fi
install -d -m 0700 "$root/etc/tailscale"
install -d "$root/etc/systemd/system/tailscaled.service.d"
flags=''
if ! test -c "$root/dev/net/tun"; then flags='--tun=userspace-networking'; fi
printf '[Service]\\nExecStart=\\nExecStart=%s --state=%s/etc/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock %s\\n' "$daemon" "$root" "$flags" > "$tmp/byokit.conf"
f="$root/etc/systemd/system/tailscaled.service.d/byokit.conf"
if ! cmp -s "$tmp/byokit.conf" "$f"; then
  install -m 0644 "$tmp/byokit.conf" "$f"
  changed=1
fi
if [ "$changed" = 1 ]; then
  systemctl daemon-reload
  systemctl restart tailscaled
fi
systemctl enable --now tailscaled`;

const dnsName = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const name = value.replace(/\.$/, '');
  return name.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/i.test(name) ? name : null;
};

export async function tailnet(provider: Provider, ref: MachineRef): Promise<Tailnet> {
  const daemon = await provider.exec(ref, ['systemctl', 'is-active', '--quiet', 'tailscaled'], { root: true, timeoutMs: 30_000 });
  if (daemon.timedOut) throw new MachineError('timeout', 'Checking your private network took too long.');
  if (daemon.code === 3 || daemon.code === 4) return { state: 'off', name: null };
  if (daemon.code !== 0) throw new MachineError('provider', `Checking your private network failed: ${daemon.stderr.slice(-200)}`);
  const r = await provider.exec(ref, ['tailscale', 'status', '--json'], { root: true, timeoutMs: 30_000 });
  if (r.code === 127 && !r.timedOut) return { state: 'off', name: null };
  if (r.timedOut) throw new MachineError('timeout', 'Checking your private network took too long.');
  let status;
  try { status = JSON.parse(r.stdout) as { BackendState?: string; Self?: { DNSName?: string } }; }
  catch { return { state: 'starting', name: null }; }
  const name = dnsName(status?.Self?.DNSName);
  switch (status?.BackendState) {
    case 'Running':
      if (r.code !== 0 || name === null) throw new MachineError('provider', 'Your private network did not return a cloud computer name.');
      return { state: 'joined', name };
    case 'NeedsLogin':
      return { state: 'needs-login', name };
    case 'NeedsMachineAuth':
      return { state: 'needs-approval', name };
    case 'Starting': case 'NoState':
      return { state: 'starting', name };
    case 'Stopped':
      return { state: 'off', name };
    default:
      throw new MachineError('provider', `Checking your private network failed: ${r.stderr.slice(-200)}`);
  }
}

export async function joinTailnet(provider: Provider, ref: MachineRef, o: { hostname: string; authKey?: string }, onStep?: (s: TailnetStep) => void): Promise<{ name: string }> {
  // REST exec input is file-backed. Never send a key into that transport, even an empty one.
  if (provider.id !== 'sandbox-api') throw new MachineError('unsupported', words('tailnet.unsupported'));
  if (o.authKey !== undefined) throw new MachineError('unsupported', words('tailnet.signInOnPhone'));
  if (typeof o.hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(o.hostname)) {
    throw new MachineError('bad-recipe', 'hostname: use one name of up to 63 letters, numbers or hyphens, with no hyphen at either end.');
  }
  const root = await provider.exec(ref, ['true'], { root: true, timeoutMs: 30_000 });
  if (root.timedOut) throw new MachineError('timeout', 'Checking admin rights took too long.');
  if (root.code !== 0) throw new MachineError('needs-root', `Connecting your cloud computer needs admin rights: ${root.stderr.slice(-200)}`);
  const installed = await provider.exec(ref, ['sh', '-c', BOOTSTRAP], { root: true, timeoutMs: 20 * 60_000 });
  if (installed.timedOut) throw new MachineError('timeout', 'Installing your private network took too long.');
  if (installed.code !== 0) throw new MachineError('provider', `Installing your private network failed: ${installed.stderr.slice(-200)}`);
  const startupUntil = Date.now() + 5 * 60_000;
  for (;;) {
    const { state } = await tailnet(provider, ref);
    if (state !== 'starting' && state !== 'off') break;
    if (Date.now() >= startupUntil) throw new MachineError('timeout', 'Starting your private network took too long.');
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  const up = await provider.exec(ref, ['tailscale', 'up', '--hostname', o.hostname, '--accept-dns=false', '--accept-routes=false', '--timeout=1s'], { root: true, timeoutMs: 30_000 });
  const link = /https:\/\/login\.tailscale\.com\/[^\s"<>]+/.exec(`${up.stdout}\n${up.stderr}`)?.[0];
  if (link) onStep?.({ step: 'open-page', url: link });
  // A short `up` deadline deliberately returns while the person signs in. Status is authoritative.
  const signInUntil = Date.now() + 5 * 60_000;
  let approvalShown = false;
  for (;;) {
    const current = await tailnet(provider, ref).catch((error: unknown) => {
      if (error instanceof MachineError && error.code === 'timeout') return null;
      throw error;
    });
    if (current?.state === 'joined' && current.name !== null) {
      onStep?.({ step: 'joined', name: current.name });
      return { name: current.name };
    }
    if (current?.state === 'needs-approval' && !approvalShown) {
      approvalShown = true;
      onStep?.({ step: 'approve', name: o.hostname });
    }
    if (up.timedOut || (up.code !== 0 && !link && current?.state === 'off')) {
      throw new MachineError('provider', `Connecting your private network failed: ${up.stderr.slice(-200)}`);
    }
    if (Date.now() >= signInUntil) {
      if (current?.state === 'needs-approval') throw new MachineError('timeout', words('tailnet.approvalNeeded'));
      if (link !== undefined && current?.state === 'needs-login') throw new MachineError('timeout', words('tailnet.loginExpired'));
      throw new MachineError('timeout', 'Starting your private network took too long.');
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}

/** A TCP port the app's host listens on, on loopback. */
export const checkPort = (port: number): void => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new MachineError('bad-recipe', 'port: use a whole number from 1 to 65535.');
};

// 9.1's private route: the tailnet forwards `port` to the host on loopback. Never Funnel, never a provider URL.
export async function servePort(provider: Provider, ref: MachineRef, port: number): Promise<void> {
  checkPort(port);
  const target = `127.0.0.1:${port}`;
  const served = await provider.exec(ref, ['tailscale', 'serve', '--bg', `--tcp=${port}`, `tcp://${target}`], { root: true, timeoutMs: 30_000 });
  if (served.timedOut) throw new MachineError('timeout', 'Opening the private route took too long.');
  if (served.code !== 0) throw new MachineError('provider', `Opening the private route failed: ${served.stderr.slice(-200)}`);
  const r = await provider.exec(ref, ['tailscale', 'serve', 'status', '--json'], { root: true, timeoutMs: 30_000 });
  if (r.timedOut) throw new MachineError('timeout', 'Checking the private route took too long.');
  let status;
  try { status = JSON.parse(r.stdout) as { TCP?: Record<string, { TCPForward?: string }> }; }
  catch { status = null; }
  if (r.code !== 0 || status?.TCP?.[String(port)]?.TCPForward !== target) {
    throw new MachineError('provider', `Your private network is not serving port ${port}: ${r.stderr.slice(-200)}`);
  }
}
