/** IPv4 interface evidence. Missing prefixes stay unknown; the kit never assumes /24. */
export type NativeAddress = { address: string; prefixLength?: number; interface?: string };
/** Host-supplied native reader (e.g. an Expo or React Native module). No global registration is needed. */
export type NativeAddressesModule = { addresses(): Promise<readonly NativeAddress[]> };
export type NativeAddressesOptions = { nativeModule?: NativeAddressesModule | null };
export type RouteKind = 'home' | 'tailscale' | 'relay' | 'loopback' | 'unknown';
export type PriorEvidence = { anywhere?: string; peer?: boolean; reached?: { tailscale?: number } };
export type ProbeState = 'answers' | 'refused' | 'timeout' | 'unknown';
export type ProbeObservation = { state: ProbeState; url: string; elapsedMs: number };
export type ProbeOptions = { timeout?: number; fetch?: typeof fetch };
export type Observation = PriorEvidence & {
  /** Undefined when native interface evidence is unavailable. */
  home?: boolean;
  tailnet: boolean;
  vpn?: boolean;
  target?: string;
  knock?: ProbeObservation;
};
export type ObserveOptions = NativeAddressesOptions & {
  urls: readonly string[];
  priorEvidence?: PriorEvidence;
  /** A snapshot avoids a native call and supports the same API on Node. */
  addresses?: readonly NativeAddress[];
  probe?: ProbeOptions;
};

function ipv4(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^(0|[1-9]\d{0,2})$/.test(p) || +p > 255)) return undefined;
  return parts.reduce((n, p) => n * 256 + +p, 0);
}
const tailnet = (address: string) => { const n = ipv4(address); return n !== undefined && n >= 0x64400000 && n <= 0x647fffff; };
const privateIp = (address: string) => { const n = ipv4(address); return n !== undefined &&
  (Math.floor(n / 0x1000000) === 10 || Math.floor(n / 0x100000) === 0xac1 || Math.floor(n / 0x10000) === 0xc0a8); };

// React Native's URL implementation leaves ws/wss hosts empty and has no protocol setter.
// Parse the small, canonical dial-URL subset directly so observations do not depend on a URL polyfill.
function dialUrl(url: string): { hostname: string; pathname: string; httpUrl: string } | undefined {
  if (/[\s\\]/.test(url)) return undefined;
  const match = /^(ws|wss|http|https):\/\/(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?([/?#].*)?$/i.exec(url);
  if (!match) return undefined;
  const [, scheme, rawHost, port, suffix = ''] = match;
  const hostname = rawHost!.toLowerCase();
  if (port !== undefined && (+port < 1 || +port > 65535)) return undefined;
  if (!hostname.startsWith('[')) {
    if (/^[\d.]+$/.test(hostname) && ipv4(hostname) === undefined) return undefined;
    if (hostname.length > 253 || hostname.split('.').some((label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) return undefined;
  }
  const protocol = scheme!.toLowerCase().replace(/^ws/, 'http');
  return { hostname, pathname: suffix.split(/[?#]/)[0] || '/', httpUrl: `${protocol}://${rawHost}${port === undefined ? '' : `:${port}`}${suffix}` };
}

/** Classify a dial URL. This is an address hint, never peer membership or authentication evidence. */
export function routeOf(url: string): RouteKind {
  const parsed = dialUrl(url);
  if (!parsed) return 'unknown';
  if (/^\/link\/v1\//.test(parsed.pathname)) return 'relay';
  const host = parsed.hostname;
  if (host === 'localhost' || host === '[::1]' || (ipv4(host) !== undefined && host.startsWith('127.'))) return 'loopback';
  if (tailnet(host) || host.endsWith('.ts.net')) return 'tailscale';
  if (privateIp(host) || host.endsWith('.local')) return 'home';
  return 'unknown';
}

/** Read and validate host-supplied IPv4 evidence; unavailable/failed modules yield no evidence. */
export async function nativeAddresses(o: NativeAddressesOptions = {}): Promise<NativeAddress[]> {
  try {
    const raw = await o.nativeModule?.addresses();
    if (!Array.isArray(raw)) return [];
    const out: NativeAddress[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object' || typeof entry.address !== 'string' || ipv4(entry.address) === undefined) continue;
      const value: NativeAddress = { address: entry.address };
      if (Number.isInteger(entry.prefixLength) && entry.prefixLength! >= 0 && entry.prefixLength! <= 32) value.prefixLength = entry.prefixLength;
      if (typeof entry.interface === 'string') value.interface = entry.interface;
      if (!out.some((e) => e.address === value.address && e.prefixLength === value.prefixLength && e.interface === value.interface)) out.push(value);
    }
    return out;
  } catch { return []; }
}

/** Bounded HTTP knock on a dial URL. Any HTTP response means answers; generic native fetch errors are unknown. */
export async function probe(url: string, o: ProbeOptions = {}): Promise<ProbeObservation> {
  const timeout = o.timeout ?? 4000;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2147483647) throw new Error('timeout must be a positive timer duration');
  const started = Date.now();
  const result = (state: ProbeState): ProbeObservation => ({ state, url, elapsedMs: Math.max(0, Date.now() - started) });
  const target = dialUrl(url);
  if (!target) return result('unknown');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ProbeObservation>((resolve) => {
    timer = setTimeout(() => { resolve(result('timeout')); controller.abort(); }, timeout);
  });
  const request = Promise.resolve().then(() => (o.fetch ?? fetch)(target.httpUrl, { signal: controller.signal, redirect: 'manual' }))
    .then((response) => { void response.body?.cancel().catch(() => {}); return result('answers'); }, (error: unknown) => {
      const code = (error as { code?: string; cause?: { code?: string } } | null)?.cause?.code ?? (error as { code?: string } | null)?.code;
      return result(controller.signal.aborted || code === 'ETIMEDOUT' ? 'timeout' : code === 'ECONNREFUSED' ? 'refused' : 'unknown');
    });
  try { return await Promise.race([request, expired]); }
  finally { clearTimeout(timer); }
}

/** Observe matching home prefixes and a tailnet candidate, retaining last authenticated host evidence. */
export async function observe(o: ObserveOptions): Promise<Observation> {
  const addresses = o.addresses === undefined ? await nativeAddresses(o) : await nativeAddresses({ nativeModule: { addresses: async () => o.addresses! } });
  const homeUrls = o.urls.filter((url) => routeOf(url) === 'home');
  const home = homeUrls.find((url) => {
    const host = ipv4(dialUrl(url)!.hostname);
    return host !== undefined && addresses.some((a) => {
      const local = ipv4(a.address);
      if (local === undefined || !privateIp(a.address) || a.prefixLength === undefined || a.prefixLength === 0) return false;
      const size = 2 ** (32 - a.prefixLength);
      return Math.floor(local / size) === Math.floor(host / size);
    });
  });
  const away = o.urls.find((url) => routeOf(url) === 'tailscale');
  const vpn = addresses.length ? addresses.some((a) => tailnet(a.address)) : undefined;
  const target = home ?? (vpn ? away : undefined);
  // A missing prefix cannot prove that this phone is away from home.
  const homeKnown = home !== undefined || (addresses.length > 0 && addresses.filter((a) => privateIp(a.address)).every((a) => a.prefixLength !== undefined && a.prefixLength > 0));
  return { ...o.priorEvidence, home: homeKnown ? !!home : undefined, tailnet: !!away, vpn,
    ...(target ? { target, knock: await probe(target, o.probe) } : {}) };
}
