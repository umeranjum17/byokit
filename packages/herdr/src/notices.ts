// Sealed blocked-approval notices: the relay reads only a generic title, the phone opens the sealed body with its
// own key (docs/runtime-kits.md 7.3). Portable: no Node import anywhere in it — `./device` re-exports `openNotice`.
import { boxKeyPairFromSeed, openBoxFromSeed, sealBox } from '@byokit/seal';
import type { BlockedAgent } from './types.ts';

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding, hand-rolled so this file stays portable (no Buffer, no atob). */
export function encodeB64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ABC[a >> 2] + ABC[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += ABC[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += ABC[c & 63];
  }
  return out;
}

/** The inverse; null when the text is not base64url. */
export function decodeB64Url(s: string): Uint8Array | null {
  if (typeof s !== 'string' || s.length === 0 || /[^A-Za-z0-9\-_]/.test(s)) return null;
  const vals = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    const n = ABC.indexOf(s[i]);
    if (n < 0) return null;
    vals[i] = n;
  }
  const out = new Uint8Array(Math.floor((s.length * 6) / 8));
  let at = 0;
  let hold = 0;
  let bits = 0;
  for (const n of vals) {
    hold = (hold << 6) | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (hold >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

const isBlockedAgent = (v: unknown): v is BlockedAgent => {
  const b = v as Record<string, unknown>;
  return typeof b === 'object' && b !== null &&
    typeof b.paneId === 'string' && typeof b.workspaceId === 'string' && typeof b.tabId === 'string' &&
    typeof b.revision === 'number' && Number.isSafeInteger(b.revision) &&
    typeof b.prompt === 'string' && typeof b.since === 'number' &&
    (b.kind === undefined || typeof b.kind === 'string');
};

/** Seal a blocked agent for one device's box key; the relay carries only the returned envelope. */
export function sealNotice(b: BlockedAgent, boxPublicKey: Uint8Array): { v: 1; sealed: string } {
  if (!(boxPublicKey instanceof Uint8Array) || boxPublicKey.length !== 32) {
    throw new Error('herdr: box public key must be 32 bytes');
  }
  if (!isBlockedAgent(b)) throw new Error('herdr: cannot seal that notice');
  return { v: 1, sealed: encodeB64Url(sealBox(new TextEncoder().encode(JSON.stringify(b)), boxPublicKey)) };
}

/** Open a notice envelope with the device's 32-byte seed; null when it is not ours or not a notice. */
export function openNotice(data: Record<string, unknown>, seed: Uint8Array): BlockedAgent | null {
  if (typeof data !== 'object' || data === null || data.v !== 1 || typeof data.sealed !== 'string') return null;
  if (!(seed instanceof Uint8Array) || seed.length !== 32) return null;
  const bundle = decodeB64Url(data.sealed);
  if (bundle === null) return null;
  const bytes = openBoxFromSeed(bundle, seed);
  if (bytes === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  return isBlockedAgent(parsed) ? parsed : null;
}

/** The box public key a device registers for a seed (the host seals to this). */
export function boxPublicKeyB64(seed: Uint8Array): string {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('herdr: notices seed must be 32 bytes');
  return encodeB64Url(boxKeyPairFromSeed(seed).publicKey);
}
