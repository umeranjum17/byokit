// What kind of route a dial address is, in words for a pairing or settings screen ("Connected over Tailscale").
export type Route = 'Tailscale' | 'Cloudflare tunnel' | 'Local or private network' | 'Private network' | 'Hosted VPS / custom relay';
export type RouteKind = 'tailscale' | 'private' | 'lan' | 'direct';

const privateIp = (host: string) => /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.)/.test(host);
const ipv4 = (host: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every((part) => +part <= 255);

/** The scheme and host of a `scheme://authority…` address, without touching `URL`: the React Native polyfill has no
 *  `URL.canParse`, and leaves `hostname` empty for `ws://`. */
function schemeHost(url: string): { scheme: string; hostname: string } | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\/?#]*)/.exec(url);
  if (!m) return undefined;
  let host = m[2];
  if (!host) return undefined;
  const at = host.lastIndexOf('@');
  if (at >= 0) host = host.slice(at + 1);
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return undefined;
    host = host.slice(1, end);
  } else {
    const colon = host.indexOf(':');
    if (colon >= 0) host = host.slice(0, colon);
  }
  host = host.toLowerCase();
  if (!host) return undefined;
  return { scheme: m[1].toLowerCase(), hostname: host };
}

/** The route `url` takes, or undefined when it isn't a URL. */
export function describeRoute(url: string | undefined, kind?: RouteKind): Route | undefined {
  if (url === undefined) return undefined;
  const parsed = schemeHost(url);
  if (!parsed) return undefined;
  const { scheme, hostname } = parsed;
  if (kind === 'tailscale' || kind === 'direct' || hostname.endsWith('.ts.net')) return 'Tailscale';
  if (kind === 'private') return 'Private network';
  if (kind === 'lan') return 'Local or private network';
  if (hostname.endsWith('.trycloudflare.com')) return 'Cloudflare tunnel';
  if ((scheme === 'ws' || scheme === 'wss') && ipv4(hostname) && privateIp(hostname)) {
    return hostname.startsWith('100.') ? 'Private network' : 'Local or private network';
  }
  if ((scheme === 'ws' || scheme === 'wss') && hostname === 'localhost') return 'Local or private network';
  return 'Hosted VPS / custom relay';
}
