// What kind of route a dial address is, in words for a pairing or settings screen ("Connected over Tailscale").
export type Route = 'Tailscale' | 'Cloudflare tunnel' | 'Local or private network' | 'Private network' | 'Hosted VPS / custom relay';
export type RouteKind = 'tailscale' | 'private' | 'lan' | 'direct';

const privateIp = (host: string) => /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.)/.test(host);
const ipv4 = (host: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every((part) => +part <= 255);

/** The route `url` takes, or undefined when it isn't a URL. */
export function describeRoute(url: string | undefined, kind?: RouteKind): Route | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { hostname, protocol } = new URL(url);
  if (kind === 'tailscale' || kind === 'direct' || hostname.endsWith('.ts.net')) return 'Tailscale';
  if (kind === 'private') return 'Private network';
  if (kind === 'lan') return 'Local or private network';
  if (hostname.endsWith('.trycloudflare.com')) return 'Cloudflare tunnel';
  if ((protocol === 'ws:' || protocol === 'wss:') && ipv4(hostname) && privateIp(hostname)) {
    return hostname.startsWith('100.') ? 'Private network' : 'Local or private network';
  }
  if ((protocol === 'ws:' || protocol === 'wss:') && hostname === 'localhost') return 'Local or private network';
  return 'Hosted VPS / custom relay';
}
