import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

/** Put in the notice's `data` as `answer`: the person may answer this notice from the notification. `host` names the
 *  app-provisioned target the reply goes to; the notice never says where or to which key. */
export type NoticeAnswer = { host: string; choices?: { id: string; label: string }[] };
/** Where a native Answer goes: the relay origin (`https:`) and the host's raw X25519 public key, both from pairing. */
export type AnswerTarget = { host: string; relay: string; key: Uint8Array };
/** The reply, bound to the notification (`event`, the relay's notification id) and the button pressed: the typed `text`,
 *  or the `choice` (one `id` from the notice's `answer.choices`) when the button itself is the answer. */
export type AnswerReply = { event: string; action: string; text: string } | { event: string; action: string; choice: string };

const INFO = new TextEncoder().encode('byokit.push.answer.v1');
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Static-static X25519 between the device's notice key and the host: only that device could have sealed the reply,
// so a relay cannot forge an answer. Salt binds both public keys.
function answerKey(mySecret: Uint8Array, theirPublic: Uint8Array, devicePublic: Uint8Array, hostPublic: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(mySecret, theirPublic);
  const salt = new Uint8Array(64);
  salt.set(devicePublic);
  salt.set(hostPublic, 32);
  try { return hkdf(sha256, shared, salt, INFO, 32); } finally { shared.fill(0); }
}
const encode = (bytes: Uint8Array): string => {
  let bits = 0, hold = 0, out = '';
  for (const byte of bytes) {
    hold = (hold << 8) | byte; bits += 8;
    while (bits >= 6) { bits -= 6; out += B64[(hold >> bits) & 63]; }
  }
  return bits > 0 ? out + B64[(hold << (6 - bits)) & 63] : out;
};
const decode = (text: string): Uint8Array | null => {
  if (text.length % 4 === 1 || /[^A-Za-z0-9_-]/.test(text)) return null;
  const out: number[] = [];
  let bits = 0, hold = 0;
  for (const char of text) {
    hold = ((hold << 6) | B64.indexOf(char)) & 0xfff; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((hold >> bits) & 255); }
  }
  return bits > 0 && (hold & ((1 << bits) - 1)) !== 0 ? null : Uint8Array.from(out);
};

/** The `reply` the device posts with its button press: unpadded base64url of nonce (12) | ChaCha20-Poly1305 of
 *  the sorted-key JSON `{ action, event, text, v: 1 }` (a typed text) or `{ action, choice, event, v: 2 }` (a choice) under HKDF-SHA256(X25519(device, host)). The native handler builds the same bytes. */
export function sealAnswer(reply: AnswerReply, deviceSecret: Uint8Array, hostPublic: Uint8Array,
  rng: (length: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const key = answerKey(deviceSecret, hostPublic, x25519.getPublicKey(deviceSecret), hostPublic);
  const nonce = rng(12);
  try {
    const sealed = chacha20poly1305(key, nonce).encrypt(new TextEncoder().encode(JSON.stringify('choice' in reply
      ? { action: reply.action, choice: reply.choice, event: reply.event, v: 2 }
      : { action: reply.action, event: reply.event, text: reply.text, v: 1 })));
    const out = new Uint8Array(12 + sealed.length);
    out.set(nonce);
    out.set(sealed, 12);
    return encode(out);
  } finally { key.fill(0); }
}

function openReply(press: { event: string; action: string; reply?: string }, devicePublic: Uint8Array, hostSecret: Uint8Array): Record<string, unknown> | null {
  try {
    const bytes = typeof press.reply === 'string' ? decode(press.reply) : null;
    if (bytes === null || bytes.length < 28) return null;
    const key = answerKey(hostSecret, devicePublic, devicePublic, x25519.getPublicKey(hostSecret));
    let value: unknown;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(chacha20poly1305(key, bytes.subarray(0, 12)).decrypt(bytes.subarray(12)))); }
    finally { key.fill(0); }
    const reply = value as Record<string, unknown> | null;
    return reply?.event === press.event && reply.action === press.action ? reply : null;
  } catch { return null; }
}

/** Host side, for the relay's `PushAction`: the typed text, or null unless this device sealed it for exactly this
 *  notification and button. A choice press is not text: it opens with `openChoice`. */
export function openAnswer(press: { event: string; action: string; reply?: string }, devicePublic: Uint8Array, hostSecret: Uint8Array): string | null {
  const reply = openReply(press, devicePublic, hostSecret);
  return reply?.v === 1 && typeof reply.text === 'string' ? reply.text : null;
}

/** Host side, for the relay's `PushAction`: the `id` of the choice the person pressed, or null unless this device
 *  sealed it for exactly this notification and button. The host looks the id up in the choices it sealed into the notice. */
export function openChoice(press: { event: string; action: string; reply?: string }, devicePublic: Uint8Array, hostSecret: Uint8Array): string | null {
  const reply = openReply(press, devicePublic, hostSecret);
  return reply?.v === 2 && typeof reply.choice === 'string' && reply.choice.length > 0 ? reply.choice : null;
}

export function validTarget(target: AnswerTarget): boolean {
  let url: URL | undefined;
  try { url = new URL(target.relay); } catch {}
  return typeof target.host === 'string' && target.host.length > 0 && target.host.length <= 128
    && url?.protocol === 'https:' && url.origin === target.relay.replace(/\/$/, '')
    && target.key instanceof Uint8Array && target.key.length === 32;
}
