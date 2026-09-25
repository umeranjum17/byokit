// The addresses a phone can dial the home computer on, for @byokit/link's `offer({ urls })`. Node only.
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { FUNNEL_ERROR, serve, tailscaleStatus, unserve, type ServeIngress, type TailscaleOptions } from './tailscale.ts';

export * from './tailscale.ts';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** An overlay network address (NetBird, WireGuard, ZeroTier, …) other than Tailscale's own. */
export type PrivateRoute = { address: string; interface: string };

const privateIpv4 = (a: string) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(a);
const cgnat = (a: string) => { const m = a.match(/^100\.(\d+)\./); return m !== null && +m[1]! >= 64 && +m[1]! <= 127; };
const overlayName = /^(?:wt|netbird|nb|wg|zt|utun|tun|tap)/i;
const virtualName = /^(?:docker|br-|veth|virbr|podman|lxc|vbox|vmnet|hyperv|wsl)/i;

/**
 * This computer's IPv4 routes: `lan` holds private-range addresses on physical interfaces (no Docker, VM or VPN
 * bridges); `private` holds overlay networks other than Tailscale. `ignore` drops tailnet addresses.
 */
export function routes(interfaces: Interfaces = networkInterfaces(), ignore: readonly string[] = []): { lan: string[]; private: PrivateRoute[] } {
  const out = { lan: [] as string[], private: [] as PrivateRoute[] };
  for (const [name, list] of Object.entries(interfaces)) {
    for (const e of list ?? []) {
      if (e.family !== 'IPv4' || e.internal || ignore.includes(e.address) || /^tailscale/i.test(name) || virtualName.test(name)) continue;
      // ponytail: CGNAT implies an overlay; add route-table evidence if ISP CGNAT false positives show up.
      if (overlayName.test(name) || cgnat(e.address)) out.private.push({ address: e.address, interface: name });
      else if (privateIpv4(e.address)) out.lan.push(e.address);
    }
  }
  return out;
}

/**
 * How the phone gets in:
 *   auto              Tailscale Serve when Tailscale is installed, otherwise LAN. A broken Tailscale is an error, not LAN.
 *   tailscale         Tailscale Serve: `wss://<MagicDNS name>`, server bound to loopback.
 *   tailscale-direct  `ws://<tailnet IP>:<port>`: the fallback when Serve is off or taken, and its rollback.
 *   private           an overlay network other than Tailscale.   lan   this computer's LAN addresses.
 */
export type Via = 'auto' | 'tailscale' | 'tailscale-direct' | 'private' | 'lan';

export type Reach = {
  /** The dial addresses, best first: pass to link's `offer({ urls })`. */
  urls: string[];
  /** Where the server must listen: loopback behind Serve, every interface otherwise. */
  bind: '127.0.0.1' | '0.0.0.0';
  /** The Serve mapping made or verified against `previous`. Persist it; pass it back next time. */
  ingress?: ServeIngress;
  pendingCleanup?: ServeIngress;
};

/**
 * Work out the addresses for a server on `port`, setting up Tailscale Serve when that's the route. Pass the `ingress`
 * from the last run as `previous`: leaving Serve (or moving port) attempts to remove that mapping, but only if Serve
 * still points where it recorded. If cleanup fails, the result carries `pendingCleanup` for a later retry.
 */
export async function reach(o: { port: number; via?: Via; previous?: ServeIngress; tailscale?: TailscaleOptions; interfaces?: Interfaces }): Promise<Reach> {
  const { port, via = 'auto', previous, tailscale: ts } = o;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1-65535');
  let pendingCleanup: ServeIngress | undefined;
  if (previous && (via === 'tailscale-direct' || via === 'private' || via === 'lan' || previous.port !== port)) {
    try { await unserve(previous, ts); }
    catch (error) {
      if (error instanceof Error && error.message === FUNNEL_ERROR) throw error;
      pendingCleanup = previous;
    }
  }
  if (via === 'auto' || via === 'tailscale') {
    const served = await serve(port, ts, previous);
    if (served) {
      const pending = pendingCleanup ?? served.pendingCleanup;
      return { urls: [served.url], bind: '127.0.0.1', ingress: served.ingress, ...(pending ? { pendingCleanup: pending } : {}) };
    }
    if (via === 'tailscale') throw new Error('Tailscale is not installed');
  }
  if (via === 'tailscale-direct') {
    const ip = (await tailscaleStatus(ts))?.ips.find(cgnat);
    if (!ip) throw new Error('no Tailscale address; sign in to Tailscale or choose LAN');
    return { urls: [`ws://${ip}:${port}`], bind: '0.0.0.0', ...(pendingCleanup ? { pendingCleanup } : {}) };
  }
  const found = routes(o.interfaces, via === 'private' ? (await tailscaleStatus(ts).catch(() => undefined))?.ips : undefined);
  const addresses = via === 'private' ? found.private.map((r) => r.address) : found.lan;
  if (addresses.length === 0) throw new Error(via === 'private' ? 'no private network address' : 'no LAN address; connect to a network or choose Tailscale');
  return { urls: addresses.map((a) => `ws://${a}:${port}`), bind: '0.0.0.0', ...(pendingCleanup ? { pendingCleanup } : {}) };
}

/** The part of bonjour-service `advertise` uses; tests pass a fake. */
export type Bonjour = {
  publish(config: { name: string; type: string; port: number; host?: string; txt?: Record<string, string> }): { stop(cb?: () => void): void };
  destroy(cb?: () => void): void;
};

/**
 * Advertise `_<type>._tcp` on the LAN over mDNS so a phone can find this computer without typing an address. Put the
 * dial URL in `txt`; the phone must still check the host key, which link's handshake does. Returns `stop`.
 */
export async function advertise(o: { type: string; port: number; name?: string; txt?: Record<string, string>; bonjour?: Bonjour }): Promise<{ stop(): Promise<void> }> {
  // bonjour-service's typings give Service.stop as a bare CallableFunction; it takes a callback.
  const bonjour = o.bonjour ?? new (await import('bonjour-service')).default.Bonjour() as unknown as Bonjour;
  const service = bonjour.publish({
    name: o.name ?? `${o.type}-${hostname()}`,
    type: o.type,
    port: o.port,
    ...(o.txt ? { txt: o.txt } : {}),
  });
  return { stop: () => new Promise((resolve) => service.stop(() => bonjour.destroy(resolve))) };
}
