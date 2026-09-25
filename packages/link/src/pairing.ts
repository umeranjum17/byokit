// What pairing puts in front of a person: the QR's text (or a link that carries it), and the typed code.
import { b64url, hash, random, unb64url } from './channel.ts';

/** What a scanned QR (or opened pairing link) holds. The ticket is single-use and short-lived. */
export type PairOffer = { v: 1; host: string; name: string; urls: string[]; ticket: string; expires: number };

const TAG = 'byokit-link:1:';
const UNSAFE = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu; // control and direction-flipping characters

/** A device or host name as a person should see it: no hidden characters, at most 60 of them. */
export const cleanName = (name: unknown, fallback: string): string =>
  (typeof name === 'string' ? name.replace(UNSAFE, '').trim().slice(0, 60) : '') || fallback;

/** The QR's text. Give a web address (`https://…/pair`) to get a link a browser can open instead: the offer rides in
 *  the part after `#`, which browsers never send to a server. */
export function offerText(offer: PairOffer, base?: string): string {
  const body = TAG + b64url(new TextEncoder().encode(JSON.stringify(offer)));
  return base ? `${base}#${body}` : body;
}

/** Scan (or pasted link) in, offer out; throws a plain sentence for anything that is not a live byokit pairing code. */
export function parseOffer(scanned: string, now = Date.now()): PairOffer {
  const at = scanned.indexOf(TAG);
  let o: any;
  try {
    if (at < 0 || scanned.length > 8192) throw new Error();
    o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(unb64url(scanned.slice(at + TAG.length).trim())));
    if (typeof o?.host !== 'string' || unb64url(o.host).length !== 32 ||
        typeof o.ticket !== 'string' || unb64url(o.ticket).length !== 16) throw new Error();
  } catch {
    throw new Error("That isn't a pairing code.");
  }
  const ok = o?.v === 1 && Number.isFinite(o.expires)
    && Array.isArray(o.urls) && o.urls.length > 0 && o.urls.length <= 8 && o.urls.every(wsUrl);
  if (!ok) throw new Error("That isn't a pairing code.");
  if (o.expires < now) throw new Error('That pairing code has run out. Show a new one.');
  return { v: 1, host: o.host, name: cleanName(o.name, 'your computer'), urls: o.urls, ticket: o.ticket, expires: o.expires };
}

function wsUrl(u: unknown): boolean {
  if (typeof u !== 'string' || u.length > 512) return false;
  try {
    const p = new URL(u);
    return (p.protocol === 'ws:' || p.protocol === 'wss:') && !p.username && !p.password;
  } catch {
    return false;
  }
}

/** Typed codes use letters and numbers nobody mixes up (no 0/O, 1/I/L). Twelve of them are about 59 bits: too many
 *  to guess, even offline, in the few minutes a code lives. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;

export function newCode(): string {
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const b of random(32)) if (b < 248 && code.length < CODE_LENGTH) code += CODE_ALPHABET[b % 31]; // 248 = 8 × 31, so no bias
  }
  return code.match(/.{4}/g)!.join('-');
}

/** What a person typed, as the code it names, or null. Case, spaces and dashes don't matter. */
export function normalizeCode(typed: string): string | null {
  const c = typed.toUpperCase().replace(/[\s-]/g, '');
  return c.length === CODE_LENGTH && [...c].every((ch) => CODE_ALPHABET.includes(ch)) ? c : null;
}

/** The Noise pre-shared key a typed code stands for. */
export const codeKey = (code: string): Uint8Array => hash(32, 'byokit-link-code-v1', normalizeCode(code) ?? '');
