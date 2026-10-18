// Phone-key enrol (docs/cloud-kit.md 5.12): the setup device hands exactly the one
// authenticated phone's public key to the machine through provider delivery, and the
// machine's host process binds it with Host.enrol. No new pairing crypto; the key
// travels only as delivery bytes, never in run.env, run.argv, logs or error text. The host answers with a
// receipt of public values in its outbox, which the setup device reads back as the run user.
import { MachineError } from './errors.ts';
import type { ExecResult, HostRecipe, Machine, MachineRef, Provider } from './types.ts';

/** The one inbox file holding the owner's phone public key (5.8 delivery). */
export const PHONE_KEY_FILE = 'phone.bin';

/** The inbox file holding a new owner phone's public key that replaces the old one (5.12). */
export const OWNER_KEY_FILE = 'owner.bin';

/** The host's answer in `<workDir>/.byokit/outbox/`, written after `bindPhoneKey`. */
export const RECEIPT_FILE = 'receipt.json';

/** What the phone pairs with: the host's public key, its grant on that host, and the secure address. */
export type PairReceipt = { host: string; device: { id: string; name: string; role: 'control' }; urls: string[] };

/** What setup() hands its `pair` gate: the secured address, a read of the host's outbox, and the person's re-enrol consent. */
export type PairContext = { urls: string[]; read(file: string): Promise<string | null>; replaceOwner?: boolean };

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

/** The Host surface the receipt needs: its public key and its grants. The real Host fits. */
export type ReceiptHost = {
  keys: { publicKey: Uint8Array };
  devices(): readonly { id: string; key: string; kind?: string; name: string; role: string }[];
};

/**
 * On the machine, after `bindPhoneKey` or `replacePhoneKey`: the receipt text the host writes to
 * `<workDir>/.byokit/outbox/receipt.json` (mode 0600, written to a temporary name and renamed).
 * Public values only: the host key, the phone's key and its grant.
 */
export function phoneReceipt(host: ReceiptHost, key: Uint8Array): string {
  checkKey(key);
  const want = b64urlOf(key);
  const g = host.devices().find((d) => d.kind === 'phone' && d.key === want);
  if (g === undefined) throw new MachineError('bad-recipe', 'key: that phone is not enrolled; call bindPhoneKey first');
  return JSON.stringify({ v: 1, key: want, host: b64urlOf(host.keys.publicKey), device: { id: g.id, name: g.name, role: 'control' } });
}

/** Prints the outbox file, or nothing while it is absent. */
export const OUTBOX_SHELL = 'test -e "$1" || exit 0; cat "$1"';

/** On the setup device: one outbox file as the run user (8.2), or null while the host has not written it. */
export async function readOutbox(provider: Provider, ref: MachineRef, r: HostRecipe, file: string): Promise<string | null> {
  const argv = ['sh', '-c', OUTBOX_SHELL, 'sh', `${r.workDir}/.byokit/outbox/${file}`];
  const o = { timeoutMs: 30_000 };
  const got: ExecResult = r.user === undefined
    ? await provider.exec(ref, argv, o)
    : await provider.exec(ref, ['runuser', '-u', r.user, '--', ...argv], { ...o, root: true });
  if (got.timedOut) throw new MachineError('timeout', `reading ${file} took too long`);
  if (got.code !== 0) throw new MachineError('provider', `reading ${file} failed with exit ${got.code}: ${got.stderr.slice(-200)}`);
  return got.stdout === '' ? null : got.stdout;
}

/** How long the host has to bind the delivered key and write its receipt. */
const RECEIPT_WAIT_MS = 60_000;

const parseReceipt = (text: string | null): { key: string; host: string; device: PairReceipt['device'] } | null => {
  try {
    const j = JSON.parse(text ?? 'null');
    const d = j?.device;
    return j?.v === 1 && typeof j.key === 'string' && /^[A-Za-z0-9_-]{43}$/.test(j.host ?? '')
      && typeof d?.id === 'string' && d.id !== '' && typeof d.name === 'string' && d.role === 'control'
      ? { key: j.key, host: j.host, device: { id: d.id, name: d.name, role: 'control' } } : null;
  } catch {
    return null; // half-written or not a receipt: the host writes it again
  }
};

/**
 * The setup() `pair` gate: deliver the phone key, then wait for the host's receipt for that
 * same key, so the `pairing` step carries what the phone pairs with.
 */
export function pairEnrol(m: Machine, r: HostRecipe, key: Uint8Array): (ref: MachineRef, ctx: PairContext) => Promise<PairReceipt> {
  return async (_ref, ctx) => {
    await deliverPhoneKey(m, r, key, { replaceOwner: ctx.replaceOwner });
    const want = b64urlOf(key);
    const until = Date.now() + RECEIPT_WAIT_MS;
    for (;;) {
      const got = parseReceipt(await ctx.read(RECEIPT_FILE));
      if (got?.key === want) return { host: got.host, device: got.device, urls: ctx.urls };
      if (Date.now() >= until) {
        // A receipt for another phone means the host refused this one (bindPhoneKey `owner-enrolled`).
        throw got !== null
          ? new MachineError('owner-enrolled', 'this computer already has an owner phone enrolled')
          : new MachineError('timeout', 'the cloud computer did not confirm this phone');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  };
}
