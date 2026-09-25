// What a pairing and a link put in front of a person, framework-free: the QR to show, the consent before pairing, the
// two words to compare, the link's status and the route it takes, each in plain words. Pairs with @byokit/link.
import { encode } from 'uqr';

/** The QR for a pairing offer's text (`offer().text` from @byokit/link) as rows of dark (true) and light modules, with
 *  the quiet border scanners need. Draw each true as a filled square in any UI: View grid, canvas, SVG or terminal. */
export const qrMatrix = (text: string): boolean[][] => encode(text, { ecc: 'M', border: 2 }).data;

/** What a pairing grants: `control` changes things on the computer, `view` only sees them. */
export type Role = 'control' | 'view';

/** The question before pairing: which computer, what this device may do, and for how long. */
export function consentWords(o: { hostName: string; role: Role }): string {
  const may = o.role === 'control' ? 'see and change things on it' : 'see it, but not change anything';
  return `Pair with ${o.hostName}? This device will be able to ${may}, until you remove it there.`;
}

/** The pairing sheet's phases: `scan` the QR (or type the code), `compare` the two words with the computer, `waiting`
 *  for a yes there, `paired`, or `failed` with the link's own sentence. */
export type PairPhase = 'scan' | 'compare' | 'waiting' | 'paired' | 'failed';

export function pairingView(o: { phase: PairPhase; hostName?: string; words?: string; error?: string }): { phase: PairPhase; title: string; words?: string } {
  const name = o.hostName || 'your computer';
  switch (o.phase) {
    case 'scan': return { phase: o.phase, title: `Scan the code on ${name}, or type the code it shows.` };
    case 'compare': return { phase: o.phase, title: `Check ${name} shows these two words, then say yes there.`, words: o.words };
    case 'waiting': return { phase: o.phase, title: `Waiting for you to say yes on ${name}.`, words: o.words };
    case 'paired': return { phase: o.phase, title: `This device is paired with ${name}.` };
    case 'failed': return { phase: o.phase, title: o.error || "Pairing didn't finish. Try again." };
  }
}

/** The link's status (`LinkStatus` from @byokit/link) as one sentence. */
export type LinkStatus = 'connecting' | 'online' | 'offline' | 'refused' | 'removed';
export function linkWords(status: LinkStatus, hostName = 'your computer'): string {
  return {
    connecting: `Connecting to ${hostName}…`,
    online: `Connected to ${hostName}.`,
    offline: `Can't reach ${hostName} right now. This device keeps trying by itself.`,
    refused: `${hostName} didn't let this device in. Pair it again there.`,
    removed: `This device was removed on ${hostName}.`,
  }[status];
}

/** How a link's address reaches the computer, in words: a person's own network, Tailscale, a relay, or the internet. */
export function describeRoute(url: string): string {
  let host = '';
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ''); } catch { return 'An address this device can’t read.'; }
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'On this computer.';
  if (host.endsWith('.ts.net') || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return 'Over your Tailscale network. Both devices need Tailscale on.';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith('.local')) return 'On your home network. Both devices need to be on it.';
  if (/(^|\.)relay\./.test(host)) return `Through the relay at ${host}, sealed end to end.`;
  return `Over the internet, through ${host}, sealed end to end.`;
}
