// Phone-key enrol (docs/cloud-kit.md 5.12): the setup device hands exactly the one
// authenticated phone's public key to the machine through provider delivery, and the
// machine's host process binds it with Host.enrol. No new pairing crypto; the key
// travels only as delivery bytes, never in run.env, run.argv, logs or error text.
import { MachineError } from './errors.ts';
import type { HostRecipe, Machine, MachineRef } from './types.ts';

/** The one inbox file holding the owner's phone public key (5.8 delivery). */
export const PHONE_KEY_FILE = 'phone.bin';

/** A phone public key is 32 raw bytes, nothing else. */
const PHONE_KEY_BYTES = 32;

const checkKey = (key: Uint8Array): void => {
  if (!(key instanceof Uint8Array) || key.length !== PHONE_KEY_BYTES) {
    throw new MachineError('bad-recipe', `key: must be a ${PHONE_KEY_BYTES}-byte public key`);
  }
};

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding: the grant-key form Host.enrol stores. */
const b64urlOf = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64URL[a >> 2] + B64URL[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += B64URL[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += B64URL[c & 63];
  }
  return out;
};

/** The Host surface phone-key enrol needs: the real Host fits with no kit-to-kit import. */
export type EnrolHost = {
  devices(): readonly { id: string; key: string; kind?: string }[];
  enrol(g: { key: Uint8Array; name: string; role: 'control'; kind: string }): Promise<{ id: string }>;
};

/** On the setup device: deliver the authenticated phone's public key to the machine's inbox. */
export async function deliverPhoneKey(m: Machine, r: HostRecipe, key: Uint8Array): Promise<void> {
  checkKey(key);
  await m.deliver(r, PHONE_KEY_FILE, key);
}

/**
 * On the machine, inside the host process: bind a delivered phone key with Host.enrol.
 * Resolves `{ id, bound: false }` when that key is already bound, rejects `exists` when
 * another phone key holds the binding, and enrols otherwise. The durable grant store is
 * the binding record, so the decision survives restarts.
 */
export async function bindPhoneKey(host: EnrolHost, key: Uint8Array, name = 'Phone'): Promise<{ id: string; bound: boolean }> {
  checkKey(key);
  const want = b64urlOf(key);
  const phones = host.devices().filter((g) => g.kind === 'phone');
  const same = phones.find((g) => g.key === want);
  if (same !== undefined) return { id: same.id, bound: false };
  if (phones.length > 0) throw new MachineError('exists', 'this computer already has an owner phone enrolled');
  const added = await host.enrol({ key, name, role: 'control', kind: 'phone' });
  return { id: added.id, bound: true };
}

/** The setup() `pair` gate: deliver the phone key, so the stream emits `pairing` before `ready`. */
export function pairEnrol(m: Machine, r: HostRecipe, key: Uint8Array): (ref: MachineRef) => Promise<void> {
  return async () => { await deliverPhoneKey(m, r, key); };
}
