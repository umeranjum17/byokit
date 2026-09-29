// Sealed approval notices for the relay push (7.3). Portable: only @byokit/seal and types —
// no node:* or Node-only imports may reach here (test/portable.test.ts guards the device entry
// that re-exports openNotice). The relay reads only the generic title; the approval itself
// travels sealed to the device's box key.
import { openBox, sealBox } from '@byokit/seal';
import type { Approval } from './types.ts';

const SOURCES = new Set(['gate', 'exec', 'plugin', 'question']);

/** Portable base64url. btoa/atob are globals in Node, browsers and React Native. */
export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array | null {
  try {
    const padded = text.replaceAll('-', '+').replaceAll('_', '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isBoxKey = (value: unknown): value is Uint8Array =>
  ArrayBuffer.isView(value) && value instanceof Uint8Array && value.length === 32;

/** Shape-check a decrypted notice: anything else is a wrong key or a foreign payload, never an approval. */
function isApproval(value: unknown): value is Approval {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id === '') return false;
  if (typeof value.source !== 'string' || !SOURCES.has(value.source)) return false;
  if (typeof value.member !== 'string') return false;
  if (typeof value.summary !== 'string') return false;
  if (typeof value.at !== 'number' || typeof value.expires !== 'number') return false;
  if (value.sessionKey !== undefined && typeof value.sessionKey !== 'string') return false;
  if (value.tool !== undefined && typeof value.tool !== 'string') return false;
  return true;
}

export function sealNotice(a: Approval, boxPublicKey: Uint8Array): { v: 1; sealed: string } {
  if (!isBoxKey(boxPublicKey)) throw new RangeError('sealNotice needs a 32-byte box public key');
  const bytes = new TextEncoder().encode(JSON.stringify(a));
  try {
    return { v: 1, sealed: b64urlEncode(sealBox(bytes, boxPublicKey)) };
  } finally {
    bytes.fill(0);
  }
}

export function openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null {
  if (!isRecord(data) || data.v !== 1 || typeof data.sealed !== 'string') return null;
  if (!isBoxKey(seed)) return null;
  const bundle = b64urlDecode(data.sealed);
  if (!bundle) return null;
  const bytes = openBox(bundle, seed);
  if (!bytes) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return isApproval(value) ? value : null;
  } catch {
    return null;
  }
}
