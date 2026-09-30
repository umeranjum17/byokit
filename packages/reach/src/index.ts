// The addresses a phone can dial the home computer on, for @byokit/link's `offer({ urls })`. Node only.
import { hostname, networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { routeChoices } from '@byokit/ui-core/route';
import { FUNNEL_ERROR, inspectServe, serve, tailscaleState, tailscaleStatus, unserve, type ServeIngress, type ServeRoot, type TailscaleOptions, type TailscaleState } from './tailscale.ts';

export * from './tailscale.ts';
export { routeOf, probe } from './observe.ts';
export type { NativeAddress, NativeAddressesModule, NativeAddressesOptions, RouteKind, PriorEvidence, ProbeState, ProbeObservation, ProbeOptions, Observation, ObserveOptions } from './observe.ts';
import { nativeAddresses as readAddresses, observe as observeWith, type NativeAddressesOptions, type ObserveOptions } from './observe.ts';

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/** An overlay network address (NetBird, WireGuard, ZeroTier, …) other than Tailscale's own. */
export type PrivateRoute = { address: string; interface: string };

const privateIpv4 = (a: string) => /^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(a);
const cgnat = (a: string) => { const m = a.match(/^100\.(\d+)\./); return m !== null && +m[1]! >= 64 && +m[1]! <= 127; };
const overlayName = /^(?:wt|netbird|nb|wg|zt|utun|tun|tap)/i;
const virtualName = /^(?:docker|br-|veth|virbr|podman|lxc|vbox|vmnet|hyperv|wsl)/i;

/**
 * This computer's IPv4 routes: `lan` holds private-range addresses on physical interfaces (no Docker, VM or VPN
 * bridges); `private` holds other overlays; `tailscale` holds named Tailscale interfaces and the
 * addresses supplied in `tailnetIPs` (including macOS utun interfaces). No CLI is run.
 */
export function routes(interfaces: Interfaces = networkInterfaces(), tailnetIPs: readonly string[] = []): { lan: string[]; private: PrivateRoute[]; tailscale: string[] } {
  const out = { lan: [] as string[], private: [] as PrivateRoute[], tailscale: [] as string[] };
  for (const [name, list] of Object.entries(interfaces)) {
    for (const e of list ?? []) {
      if (e.family !== 'IPv4' || e.internal || virtualName.test(name)) continue;
      if (/^tailscale/i.test(name) || tailnetIPs.includes(e.address)) {
        if (!out.tailscale.includes(e.address)) out.tailscale.push(e.address);
        continue;
      }
      // ponytail: CGNAT implies an overlay; add route-table evidence if ISP CGNAT false positives show up.
      if (overlayName.test(name) || cgnat(e.address)) out.private.push({ address: e.address, interface: name });
      else if (privateIpv4(e.address)) out.lan.push(e.address);
    }
  }
  return out;
}

/** Direct listener scopes. LAN binds individual classified LAN addresses, never a wildcard. */
export type ListenScopes = { loopback?: boolean; tailnet?: boolean; lan?: boolean };
export type DirectRoutes = { hosts: string[]; urls: string[] };
export type DirectRoutesOptions = {
  port: number;
  listen?: ListenScopes;
  interfaces?: Interfaces;
  tailnetIPs?: readonly string[];
  /** Explicit listener override, including intentional wildcard binds. */
  hosts?: readonly string[];
  /** Dial URL path, e.g. '/link'. Defaults to '/'. */
  path?: string;
};

/** Multiple direct listeners and dial URLs, LAN first then tailnet; loopback URLs only when nothing else can dial. */
export function directRoutes(o: DirectRoutesOptions): DirectRoutes {
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('port must be 1-65535');
  const path = o.path ?? '/';
  if (!path.startsWith('/') || path.startsWith('//') || /[\s?#\\]/.test(path)) throw new Error('path must be an absolute URL path without query or fragment');
  const found = routes(o.interfaces, o.tailnetIPs);
  const listen = o.listen ?? { loopback: true, tailnet: true };
  const hosts = [...new Set((o.hosts ?? [
    ...(listen.loopback ? ['127.0.0.1'] : []),
    ...(listen.tailnet ? found.tailscale : []),
    ...(listen.lan ? found.lan : []),
  ]).map((host) => host.toLowerCase()))];
  for (const host of hosts) {
    // IPv4 or a DNS name only; a listener is not a URL or a port.
    if (!host || host !== host.trim() || !/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith('.') || host.endsWith('.') || host.includes('..')) throw new Error('hosts must be IPv4 addresses or DNS names');
    const parsed = new URL(`ws://${host}:${o.port}`);
    if (parsed.hostname !== host.toLowerCase()) throw new Error('hosts must use canonical addresses');
  }
  const addresses = [...new Set(hosts.includes('0.0.0.0') ? [...found.lan, ...found.tailscale, ...hosts.filter((h) => h !== '0.0.0.0')] : hosts)];
  const remote = addresses.filter((a) => a !== 'localhost' && !a.startsWith('127.'));
  const ordered = [...remote.filter((a) => !found.tailscale.includes(a)), ...remote.filter((a) => found.tailscale.includes(a))];
  const dial = ordered.length ? ordered : addresses.filter((a) => a === 'localhost' || a.startsWith('127.'));
  // With a wildcard and no classified addresses, loopback is still available.
  if (!dial.length && hosts.includes('0.0.0.0')) dial.push('127.0.0.1');
  return { hosts, urls: dial.map((a) => `ws://${a}:${o.port}${path === '/' ? '' : path}`) };
}

const nodeAddresses = { addresses: async () => Object.entries(networkInterfaces()).flatMap(([name, entries]) =>
  (entries ?? []).filter((e) => e.family === 'IPv4' && !e.internal && !virtualName.test(name)).map((e) => ({
    address: e.address, interface: name, ...(e.cidr ? { prefixLength: Number(e.cidr.split('/')[1]) } : {}),
  }))) };

/** Node interface snapshot; React Native uses the same type with a host-supplied nativeModule. */
export function nativeAddresses(o: NativeAddressesOptions = {}) { return readAddresses({ nativeModule: o.nativeModule === undefined ? nodeAddresses : o.nativeModule }); }
/** Observe using Node interfaces by default, or an injected native module/snapshot. */
export function observe(o: ObserveOptions) { return observeWith({ ...o, nativeModule: o.nativeModule === undefined ? nodeAddresses : o.nativeModule }); }

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
  /** Where the server must listen: loopback behind Serve, the selected tailnet IP for direct, wildcard for LAN/private. */
  bind: string;
  /** The Serve mapping made or verified against `previous`. Persist it; pass it back next time. */
  ingress?: ServeIngress;
  pendingCleanup?: ServeIngress;
};

/**
 * Work out the addresses for a server on `port`, setting up Tailscale Serve when that's the route. Pass the `ingress`
 * from the last run as `previous`: leaving Serve (or moving port) attempts to remove that mapping, but only if Serve
 * still points where it recorded. If cleanup fails, the result carries `pendingCleanup` for a later retry.
 */
export async function reach(o: { port: number; via?: Via; previous?: ServeIngress; tailscale?: TailscaleOptions; interfaces?: Interfaces; address?: string }): Promise<Reach> {
  const { port, via = 'auto', previous, tailscale: ts } = o;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be 1-65535');
  if (o.address !== undefined && via !== 'tailscale-direct') throw new Error('address is only available for direct Tailscale');
  let addresses: string[] | undefined;
  if (via === 'tailscale-direct') {
    const ips = (await tailscaleStatus(ts))?.ips.filter(cgnat) ?? [];
    const ip = o.address === undefined ? ips[0] : ips.find((ip) => ip === o.address);
    if (!ip) throw new Error('no Tailscale address; sign in to Tailscale or choose LAN');
    addresses = [ip];
  } else if (via === 'private' || via === 'lan') {
    const found = routes(o.interfaces, via === 'private' ? (await tailscaleStatus(ts).catch(() => undefined))?.ips : undefined);
    addresses = via === 'private' ? found.private.map((r) => r.address) : found.lan;
    if (addresses.length === 0) throw new Error(via === 'private' ? 'no private network address' : 'no LAN address; connect to a network or choose Tailscale');
  }
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
    if (previous?.port === port) pendingCleanup ??= previous;
  }
  addresses ??= routes(o.interfaces).lan;
  if (addresses.length === 0) throw new Error('no LAN address; connect to a network or choose Tailscale');
  return { urls: addresses.map((a) => `ws://${a}:${port}`), bind: via === 'tailscale-direct' ? addresses[0]! : '0.0.0.0', ...(pendingCleanup ? { pendingCleanup } : {}) };
}

/** A concrete route the phone can take. `auto` is not a route: it picks the recommended entry. */
export type RecommendVia = Exclude<Via, 'auto'>;

/** One onboarding route: its everyday words plus whether it is usable now. */
export type RecommendEntry = {
  via: RecommendVia;
  /** True for exactly one entry, the route to preselect; false everywhere when nothing is ready. */
  recommended: boolean;
  /** One everyday sentence saying what it gives; from ui-core's `routeChoices`, the one word table. */
  sentence: string;
  /** What has to be true first, in words. */
  needs: string;
  /** Why it cannot be used now; absent when it is selectable. */
  disabledReason?: string;
};

export type RecommendOptions = {
  /** Serve-root probe port; only used when `serve` is not passed. Defaults to 8792. */
  port?: number;
  /** Interface list for `routes()`; only used when `lan`/`private` are not both passed. */
  interfaces?: Interfaces;
  /** Where the tailscale CLI is; only used for probes that are not passed in. */
  tailscale?: TailscaleOptions;
  /** Local Tailscale state; defaults to `tailscaleState()`. Tests pass a fake. */
  state?: TailscaleState;
  /** Who holds the Serve root; defaults to `inspectServe()` when the MagicDNS name is known. */
  serve?: { status: ServeRoot; reason?: string };
  /** LAN addresses and overlay routes; default to `routes(interfaces, state.ips)`. */
  lan?: string[];
  private?: PrivateRoute[];
  /** The route in use now; when healthy and still available it stays recommended. */
  current?: { via: RecommendVia; healthy: boolean };
};

const SIGN_IN_NEXT = 'Sign in to Tailscale next; your phone also needs the Tailscale app, signed in to the same account.';

/**
 * Every route in everyday words, recommended first: the current healthy route, then Tailscale Serve (direct Tailscale
 * when the Serve root is taken, disabled, funnelled, or nameless), then a private overlay, then Same Wi-Fi. Tailscale
 * installed but signed out stays selectable with sign-in in `needs` while Same Wi-Fi is recommended. Nothing ready
 * means no entry is recommended. With no options it probes this computer; tests pass `state`, `serve`, `lan` and
 * `private` fakes so no CLI runs and no packet goes out.
 */
export async function recommend(o: RecommendOptions = {}): Promise<RecommendEntry[]> {
  const state = o.state ?? await tailscaleState(o.tailscale);
  const connected = state.installed && state.backendState === 'Running' && state.ips.some((ip) => ip.includes('.'));
  let root = o.serve;
  if (!root && state.dnsName) {
    const inspected = await inspectServe(o.port ?? 8792, state.dnsName, o.tailscale);
    root = { status: inspected.status, reason: inspected.reason };
  }
  root ??= { status: 'inconclusive' };
  const found = o.lan !== undefined && o.private !== undefined ? { lan: o.lan, private: o.private } : routes(o.interfaces, state.ips);
  const lan = o.lan ?? found.lan;
  const privateRoutes = o.private ?? found.private;
  const words = new Map(routeChoices().map((c) => [c.code, c] as const));
  const entry = (via: RecommendVia, disabledReason?: string, needs?: string): RecommendEntry => ({
    via,
    recommended: false,
    sentence: words.get(via)!.sentence,
    needs: needs ?? words.get(via)!.needs,
    ...(disabledReason ? { disabledReason } : {}),
  });
  const blocked = root.status === 'occupied' || root.status === 'disabled' || root.status === 'funnel';
  const tailscaleEntry = !state.installed ? entry('tailscale', 'Tailscale is not installed on this computer.')
    : !connected ? entry('tailscale', undefined, SIGN_IN_NEXT)
    : !state.dnsName ? entry('tailscale', 'Tailscale MagicDNS is off, so Serve has no address. Enable MagicDNS, then retry, or choose direct Tailscale.')
    : blocked ? entry('tailscale', root.reason ?? 'Tailscale Serve is already used by something else here; direct Tailscale still works.')
    : entry('tailscale');
  const directEntry = !state.installed ? entry('tailscale-direct', 'Tailscale is not installed on this computer.')
    : !connected ? entry('tailscale-direct', undefined, SIGN_IN_NEXT)
    : entry('tailscale-direct');
  const privateEntry = entry('private', privateRoutes.length === 0
    ? 'No private network found. Connect NetBird, WireGuard or ZeroTier on this computer and phone first.'
    : undefined);
  const lanEntry = entry('lan', lan.length === 0 ? 'No LAN address found. Connect this computer to Wi-Fi first.' : undefined);
  const byVia = { tailscale: tailscaleEntry, 'tailscale-direct': directEntry, private: privateEntry, lan: lanEntry };
  const usable = (e: RecommendEntry) => e.disabledReason === undefined;
  let pick: RecommendVia | undefined;
  if (o.current?.healthy && usable(byVia[o.current.via])) pick = o.current.via;
  if (pick === undefined && connected) pick = usable(tailscaleEntry) ? 'tailscale' : 'tailscale-direct';
  if (pick === undefined && usable(privateEntry)) pick = 'private';
  if (pick === undefined && usable(lanEntry)) pick = 'lan';
  const rest = (['tailscale', 'tailscale-direct', 'private', 'lan'] as RecommendVia[]).filter((v) => v !== pick);
  return [pick, ...rest].filter((v): v is RecommendVia => v !== undefined)
    .map((v) => (v === pick ? { ...byVia[v], recommended: true } : byVia[v]));
}

/** The part of bonjour-service `advertise` uses; tests pass a fake. */
export type Bonjour = {
  publish(config: { name: string; type: string; port: number; host?: string; txt?: Record<string, string> }): {
    stop(cb?: () => void): void;
    /** bonjour-service's record factory, called after its asynchronous name probe and again on teardown. */
    records?(): BonjourRecord[];
  };
  destroy(cb?: () => void): void;
};

export type BonjourRecord = { type: string; data: unknown };

/**
 * Advertise `_<type>._tcp` on the LAN over mDNS so a phone can find this computer without typing an address. Put the
 * dial URL in `txt`; the phone must still check the host key, which link's handshake does. Returns `stop`.
 */
export async function advertise(o: { type: string; port: number; name?: string; txt?: Record<string, string>; addresses?: readonly string[]; bonjour?: Bonjour }): Promise<{ stop(): Promise<void> }> {
  const addresses = new Set(o.addresses ?? routes().lan);
  // bonjour-service's typings give Service.stop as a bare CallableFunction; it takes a callback.
  const bonjour = o.bonjour ?? new (await import('bonjour-service')).default.Bonjour() as unknown as Bonjour;
  const service = bonjour.publish({
    name: o.name ?? `${o.type}-${hostname()}`,
    type: o.type,
    port: o.port,
    ...(o.txt ? { txt: o.txt } : {}),
  });
  // publish() probes asynchronously before it calls records(). Keep that default probe enabled so no unfiltered
  // records can be announced before this wrapper is installed. Teardown uses the same filtered factory.
  if (service.records) {
    const records = service.records.bind(service);
    service.records = () => records().filter((record) =>
      (record.type !== 'A' && record.type !== 'AAAA') || (typeof record.data === 'string' && addresses.has(record.data)));
  }
  return { stop: () => new Promise((resolve) => service.stop(() => bonjour.destroy(resolve))) };
}
