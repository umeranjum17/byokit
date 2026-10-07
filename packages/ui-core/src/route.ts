// What kind of route a dial address is, in words for a pairing or settings screen
// ("Connected to Kitchen computer - same Wi-Fi."). Every value is plain words: no addresses, no protocol names.
export type Route = 'Tailscale' | 'Temporary public link' | 'Same Wi-Fi' | 'Private network' | 'Away from home' | 'Your own server';
export type RouteKind = 'tailscale' | 'private' | 'lan' | 'direct';

/** An onboarding route code. A superset of reach's `Via`: reach has no Cloudflare or own-server route. */
export type RouteCode = 'tailscale' | 'tailscale-direct' | 'private' | 'lan' | 'cloudflare' | 'external';

/** One onboarding route in everyday words: the list title, the sentence under it, and what it needs first. */
export type RouteChoice = {
  code: RouteCode;
  /** The list title, e.g. `Same Wi-Fi`. */
  title: string;
  /** One everyday sentence saying what it gives, e.g. where it works. */
  sentence: string;
  /** What has to be true first, in words, e.g. which app to install. */
  needs: string;
};

/**
 * Every onboarding route in everyday words, in recommendation order. The one word table: reach's `recommend()`
 * takes `sentence` and `needs` from here and only adds availability, so the order and the copy live in one place.
 */
export function routeChoices(): RouteChoice[] {
  return [
    {
      code: 'tailscale',
      title: 'Tailscale — works anywhere',
      sentence: 'Your phone reaches this computer from anywhere.',
      needs: 'The free Tailscale app on this computer and your phone, signed in to the same account.',
    },
    {
      code: 'tailscale-direct',
      title: 'Tailscale — direct (phone app only)',
      sentence: 'Same as above without Tailscale Serve. Pick this if Serve is already used on this computer for something else.',
      needs: 'The free Tailscale app on this computer and your phone, signed in to the same account. No Serve setup.',
    },
    {
      code: 'private',
      title: 'Private network you already use (NetBird, WireGuard, ZeroTier)',
      sentence: 'Pick this if this computer and phone are already on one.',
      needs: 'This computer and your phone on the same private network.',
    },
    {
      code: 'lan',
      title: 'Same Wi-Fi',
      sentence: 'Easiest. Works while your phone is on the same Wi-Fi as this computer. Nothing else to install.',
      needs: 'Your phone on the same Wi-Fi as this computer.',
    },
    {
      code: 'cloudflare',
      title: 'Temporary public link (Cloudflare)',
      sentence: 'Works anywhere without a VPN, but the link changes when it restarts.',
      needs: 'cloudflared installed on this computer.',
    },
    {
      code: 'external',
      title: 'Your own server',
      sentence: "For people who already run their own secure server. You'll paste its address next.",
      needs: 'A stable server address you manage.',
    },
  ];
}

const privateIp = (host: string) => /^(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|100\.(?:6[4-9]|[78]\d|9\d|1[01]\d|12[0-7])\.)/.test(host);
const ipv4 = (host: string) => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && host.split('.').every((part) => +part <= 255);

/** The scheme, host and path of a `scheme://authority…` address, without touching `URL`: the React Native polyfill has no
 *  `URL.canParse`, and leaves `hostname` empty for that scheme. */
function schemeHost(url: string): { scheme: string; hostname: string; path: string } | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^\/?#]*)([^?#]*)/.exec(url);
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
  return { scheme: m[1].toLowerCase(), hostname: host, path: m[3] ?? '' };
}

/** The route `url` takes, or undefined when it isn't a URL. Loopback is the page on the computer itself, so it reads
 *  as the same-network route; this kit's `/link/v1/…` away address reads as away from home, whatever its host. */
export function describeRoute(url: string | undefined, kind?: RouteKind): Route | undefined {
  if (url === undefined) return undefined;
  const parsed = schemeHost(url);
  if (!parsed) return undefined;
  const { scheme, hostname, path } = parsed;
  if (kind === 'tailscale' || kind === 'direct' || hostname.endsWith('.ts.net')) return 'Tailscale';
  if (kind === 'private') return 'Private network';
  if (kind === 'lan') return 'Same Wi-Fi';
  if (hostname.endsWith('.trycloudflare.com')) return 'Temporary public link';
  if ((scheme === 'ws' || scheme === 'wss') && path.startsWith('/link/v1/')) return 'Away from home';
  if ((scheme === 'ws' || scheme === 'wss') && ipv4(hostname) && privateIp(hostname)) {
    return hostname.startsWith('100.') ? 'Private network' : 'Same Wi-Fi';
  }
  if ((scheme === 'ws' || scheme === 'wss') && (hostname === 'localhost' || hostname === '::1')) return 'Same Wi-Fi';
  return 'Your own server';
}

/** The route as words inside a connected line (`same Wi-Fi`): lowercase, so a consumer renders one sentence
 *  (`Connected to Kitchen computer - ${routeShort(route)}.`). Tailscale keeps its capital: it is a name. */
export function routeShort(route: Route | undefined): string | undefined {
  return route === undefined ? undefined : {
    'Tailscale': 'Tailscale',
    'Temporary public link': 'a temporary public link',
    'Same Wi-Fi': 'same Wi-Fi',
    'Private network': 'a private network',
    'Away from home': 'away from home',
    'Your own server': 'your own server',
  }[route];
}

/** The connected line a consumer renders: the computer with the route just dialled
 *  (`Connected to Kitchen computer - same Wi-Fi.`), or plain (`Connected to Kitchen computer.`) with no route. */
export function connectedWords(hostName: string, url: string | undefined, kind?: RouteKind): string {
  const short = routeShort(describeRoute(url, kind));
  return short ? `Connected to ${hostName} - ${short}.` : `Connected to ${hostName}.`;
}
