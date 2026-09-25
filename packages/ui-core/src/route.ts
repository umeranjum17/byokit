// What kind of route a dial address is, in words for a pairing or settings screen ("Connected over Tailscale").
export type Route = 'Tailscale' | 'Cloudflare tunnel' | 'Local or private network' | 'Hosted VPS / custom relay';

const tailscale = (host: string) => host.endsWith('.ts.net') || /^100\.(6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\./.test(host);
const local = (host: string) => /^(?:localhost$|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host);

/** The route `url` takes, or undefined when it isn't a URL. */
export function describeRoute(url: string | undefined): Route | undefined {
  if (url === undefined || !URL.canParse(url)) return undefined;
  const { hostname, protocol } = new URL(url);
  if (tailscale(hostname)) return 'Tailscale';
  if (hostname.endsWith('.trycloudflare.com')) return 'Cloudflare tunnel';
  if ((protocol === 'ws:' || protocol === 'wss:') && local(hostname)) return 'Local or private network';
  return 'Hosted VPS / custom relay';
}
