// What a pairing and a link put in front of a person, framework-free: the QR to show, the consent before pairing, the
// two words to compare and the link's status, each in plain words. Pairs with @byokit/link.
import { encode } from 'uqr';

/** The QR for a pairing offer's text (`offer().text` from @byokit/link) as rows of dark (true) and light modules, with
 *  the quiet border scanners need. Draw each true as a filled square in any UI: View grid, canvas, SVG or terminal.
 *  `border` is that quiet border in modules, 2 unless given. */
export const qrMatrix = (text: string, opts?: { border?: number }): boolean[][] =>
  encode(text, { ecc: 'M', border: opts?.border ?? 2 }).data;

/** The same QR as text rows for a terminal: each line draws two module rows as half blocks (`█` both dark, `▀` top
 *  only, `▄` bottom only), so `console.log(qrText(offer.text))` in setup scripts shows a code a phone can scan. */
export function qrText(text: string, opts?: { border?: number }): string {
  const m = qrMatrix(text, opts);
  const rows: string[] = [];
  for (let y = 0; y < m.length; y += 2) {
    const top = m[y], bottom = m[y + 1] ?? [];
    rows.push(top.map((dark, x) => {
      const below = bottom[x] ?? false;
      return dark ? (below ? '█' : '▀') : (below ? '▄' : ' ');
    }).join('').replace(/\s+$/, ''));
  }
  return rows.join('\n');
}

/** What a pairing grants: `control` changes things on the computer, `view` only sees them. */
export type Role = 'control' | 'view';

/** Which device is pairing: a phone holding the app, or a browser that opened the pairing link. */
export type DeviceKind = 'phone' | 'browser';

const deviceWords = (device?: DeviceKind): string =>
  device === 'phone' ? 'This phone' : device === 'browser' ? 'This browser' : 'This device';

/** The question before pairing: which computer, what this device may do, and for how long. `device` names the
 *  pairing side when it isn't the app ("This browser …"), `detail` adds one app sentence after ("It can also …"). */
export function consentWords(o: { hostName: string; role: Role; device?: DeviceKind; detail?: string }): string {
  const may = o.role === 'control' ? 'see and change things on it' : 'see it, but not change anything';
  const base = `Pair with ${o.hostName}? ${deviceWords(o.device)} will be able to ${may}, until you remove it there.`;
  return o.detail ? `${base} ${o.detail}` : base;
}

/** The pairing sheet's phases: `scan` the QR (or type the code), `compare` the two words with the computer, `waiting`
 *  for a yes there, `paired`, or `failed` with the link's own sentence. */
export type PairPhase = 'scan' | 'compare' | 'waiting' | 'paired' | 'failed';

export function pairingView(o: { phase: PairPhase; hostName?: string; words?: string; error?: string; device?: DeviceKind; detail?: string }): { phase: PairPhase; title: string; words?: string } {
  const name = o.hostName || 'your computer';
  const title = (s: string): string => (o.detail ? `${s} ${o.detail}` : s);
  switch (o.phase) {
    case 'scan': return { phase: o.phase, title: title(o.device === 'browser'
      ? `Open the pairing link on ${name}, or type the code it shows.`
      : `Scan the code on ${name}, or type the code it shows.`) };
    case 'compare': return { phase: o.phase, title: title(`Check ${name} shows these two words, then say yes there.`), words: o.words };
    case 'waiting': return { phase: o.phase, title: title(`Waiting for you to say yes on ${name}.`), words: o.words };
    case 'paired': return { phase: o.phase, title: title(`${deviceWords(o.device)} is paired with ${name}.`) };
    case 'failed': return { phase: o.phase, title: title(o.error || "Pairing didn't finish. Try again.") };
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
