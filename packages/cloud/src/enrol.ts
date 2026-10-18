// Phone-key enrol (docs/cloud-kit.md 5.12): the setup device hands exactly the one
// authenticated phone's public key to the machine through provider delivery, and the
// machine's host process binds it with Host.enrol. No new pairing crypto; the key
// travels only as delivery bytes, never in run.env, run.argv, logs or error text.
import { MachineError } from './errors.ts';
import type { HostRecipe, Machine, MachineRef } from './types.ts';

/** The one inbox file holding the owner's phone public key (5.8 delivery). */
export const PHONE_KEY_FILE = 'phone.bin';

/** The inbox file holding a new owner phone's public key that replaces the old one (5.12). */
export const OWNER_KEY_FILE = 'owner.bin';

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

/** The Host surface owner replacement adds: the real Host's revoke. */
export type OwnerHost = EnrolHost & { revoke(id: string): Promise<void> };

/**
 * On the setup device: deliver the authenticated phone's public key to the machine's inbox,
 * as `OWNER_KEY_FILE` when the person confirmed replacing the old owner phone.
 */
export async function deliverPhoneKey(m: Machine, r: HostRecipe, key: Uint8Array, o: { replaceOwner?: boolean } = {}): Promise<void> {
  checkKey(key);
  await m.deliver(r, o.replaceOwner === true ? OWNER_KEY_FILE : PHONE_KEY_FILE, key);
}

/**
 * On the machine, inside the host process: bind a delivered phone key with Host.enrol.
 * Resolves `{ id, bound: false }` when that key is already bound, rejects `owner-enrolled` when
 * another phone key holds the binding, and enrols otherwise. The durable grant store is
 * the binding record, so the decision survives restarts.
 */
export async function bindPhoneKey(host: EnrolHost, key: Uint8Array, name = 'Phone'): Promise<{ id: string; bound: boolean }> {
  checkKey(key);
  const want = b64urlOf(key);
  const phones = host.devices().filter((g) => g.kind === 'phone');
  const same = phones.find((g) => g.key === want);
  if (same !== undefined) return { id: same.id, bound: false };
  if (phones.length > 0) throw new MachineError('owner-enrolled', 'this computer already has an owner phone enrolled');
  const added = await host.enrol({ key, name, role: 'control', kind: 'phone' });
  return { id: added.id, bound: true };
}

/**
 * On the machine, inside the host process, for an `OWNER_KEY_FILE` delivery only: revoke every
 * other phone grant, then bind this key. Revoking first ends the old phone's access at once and
 * leaves room under a one-phone cap; a crash between the two leaves no phone, and handling the
 * same file again (remove it only once this resolves) finishes the swap. Never call it for
 * anything a phone or link peer sent: the inbox write is the provider account's authority.
 */
export async function replacePhoneKey(host: OwnerHost, key: Uint8Array, name = 'Phone'): Promise<{ id: string; bound: boolean }> {
  checkKey(key);
  const want = b64urlOf(key);
  for (const g of host.devices()) if (g.kind === 'phone' && g.key !== want) await host.revoke(g.id);
  return bindPhoneKey(host, key, name);
}

/** The setup() `pair` gate: deliver the phone key, so the stream emits `pairing` before `ready`. */
export function pairEnrol(m: Machine, r: HostRecipe, key: Uint8Array): (ref: MachineRef, o?: { replaceOwner?: boolean }) => Promise<void> {
  return async (_ref, o) => { await deliverPhoneKey(m, r, key, o); };
}
