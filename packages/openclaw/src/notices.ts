// Sealed approval notices for the relay push (7.3). Portable: only @byokit/seal and types. Built in O9.
import type { Approval } from './types.ts';

export function sealNotice(a: Approval, boxPublicKey: Uint8Array): { v: 1; sealed: string } {
  throw new Error('not built: O9');
}

export function openNotice(data: Record<string, unknown>, seed: Uint8Array): Approval | null {
  throw new Error('not built: O9');
}
