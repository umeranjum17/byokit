import { MachineError } from './errors.ts';
import { words } from './words.ts';
import type { MachineRef, Provider, Tailnet, TailnetStep } from './types.ts';

// Boat keeps /etc across wakes, unlike /var. This identity is included in disk copies.
// $1 is a root prefix for tests (empty on a machine); the kit never passes one.
export const BOOTSTRAP = `set -eu
root=\${1:-}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh -o "$tmp/install.sh"
  sh "$tmp/install.sh"
fi
install -d -m 0700 "$root/etc/tailscale"
install -d "$root/etc/systemd/system/tailscaled.service.d"
flags=''
if ! test -c "$root/dev/net/tun"; then flags='--tun=userspace-networking'; fi
printf '[Service]\\nExecStart=\\nExecStart=%s --state=%s/etc/tailscale/tailscaled.state --socket=/var/run/tailscale/tailscaled.sock %s\\n' "$(command -v tailscaled)" "$root" "$flags" > "$tmp/byokit.conf"
f="$root/etc/systemd/system/tailscaled.service.d/byokit.conf"
if ! cmp -s "$tmp/byokit.conf" "$f"; then
  install -m 0644 "$tmp/byokit.conf" "$f"
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
    case 'NeedsLogin': case 'NeedsMachineAuth':
      return { state: 'needs-login', name };
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
  if (provider.id !== 'sandbox-api' || o.authKey !== undefined) {
    throw new MachineError('unsupported', 'This cloud computer needs sign-in on your phone instead of a join key.');
  }
  if (typeof o.hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(o.hostname)) {
    throw new MachineError('bad-recipe', 'hostname: use one name of up to 63 letters, numbers or hyphens, with no hyphen at either end.');
  }
  const root = await provider.exec(ref, ['true'], { root: true, timeoutMs: 30_000 });
  if (root.timedOut) throw new MachineError('timeout', 'Checking admin rights took too long.');
  if (root.code !== 0) throw new MachineError('needs-root', `Connecting your cloud computer needs admin rights: ${root.stderr.slice(-200)}`);
  const installed = await provider.exec(ref, ['sh', '-c', BOOTSTRAP], { root: true, timeoutMs: 20 * 60_000 });
  if (installed.timedOut) throw new MachineError('timeout', 'Installing your private network took too long.');
  if (installed.code !== 0) throw new MachineError('provider', `Installing your private network failed: ${installed.stderr.slice(-200)}`);
  const until = Date.now() + 5 * 60_000;
  while ((await tailnet(provider, ref)).state === 'starting') {
    if (Date.now() >= until) throw new MachineError('timeout', 'Starting your private network took too long.');
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  const up = await provider.exec(ref, ['tailscale', 'up', '--hostname', o.hostname, '--accept-dns=false', '--accept-routes=false', '--timeout=1s'], { root: true, timeoutMs: 30_000 });
  const link = /https:\/\/login\.tailscale\.com\/[^\s"<>]+/.exec(`${up.stdout}\n${up.stderr}`)?.[0];
  if (link) onStep?.({ step: 'open-page', url: link });
  // A short `up` deadline deliberately returns while the person signs in. Status is authoritative.
  for (;;) {
    const current = await tailnet(provider, ref);
    if (current.state === 'joined' && current.name !== null) {
      onStep?.({ step: 'joined', name: current.name });
      return { name: current.name };
    }
    if (up.timedOut || (up.code !== 0 && !link && current.state !== 'needs-login')) {
      throw new MachineError('provider', `Connecting your private network failed: ${up.stderr.slice(-200)}`);
    }
    if (Date.now() >= until) throw new MachineError('timeout', words('tailnet.loginExpired'));
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
}
