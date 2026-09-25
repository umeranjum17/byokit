// How a host proves to the relay that it holds the secret half of the key its relay address is derived from. Link's
// keys are X25519, which cannot sign, so the proof is a DH: the relay sends a fresh X25519 key and a nonce on every
// host socket, and the host answers with an HMAC keyed by the DH of its secret key and the relay's fresh one. Only the
// holder of the host's secret key (or the relay, which made the fresh key) can compute it, and it is good for that one
// socket only. Node-only (node:crypto); the host and the relay both run in Node.
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url');
const pub = (key: Uint8Array) => createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: b64u(key) }, format: 'jwk' });

/** How the relay closes a host's socket. A client stops on `replaced` (another copy of this host took over) and on the
 *  refusals; anything else is a drop it reconnects after. */
export const CLOSE = { replaced: 4000, notEnrolled: 4401, badProof: 4403, enrolment: 4410, revoked: 1008, tooMany: 4429 } as const;

export type Challenge = { t: 'challenge'; v: 1; key: string; nonce: string };

function mac(shared: Buffer, nonce: Uint8Array, hostKey: Uint8Array, relayKey: Uint8Array) {
  if (shared.every((b) => b === 0)) throw new Error('low-order key'); // a key with no secret behind it
  return createHmac('sha256', shared).update('byokit-relay-host-v1').update(nonce).update(hostKey).update(relayKey).digest();
}

/** The relay's side: a fresh challenge, and a check of the host's answer to it. */
export function challenge(): { msg: Challenge; verify(hostKey: Uint8Array, proof: Uint8Array): boolean } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const relayKey = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const nonce = randomBytes(32);
  return {
    msg: { t: 'challenge', v: 1, key: b64u(relayKey), nonce: b64u(nonce) },
    verify(hostKey, proof) {
      try {
        const want = mac(diffieHellman({ privateKey, publicKey: pub(hostKey) }), nonce, hostKey, relayKey);
        return proof.length === want.length && timingSafeEqual(proof, want);
      } catch {
        return false;
      }
    },
  };
}

/** The host's side: its answer to one challenge. */
export function prove(keys: { publicKey: Uint8Array; secretKey: Uint8Array }, c: Challenge): Uint8Array {
  const relayKey = Buffer.from(c.key, 'base64url');
  const privateKey: KeyObject = createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', d: b64u(keys.secretKey), x: b64u(keys.publicKey) }, format: 'jwk' });
  return mac(diffieHellman({ privateKey, publicKey: pub(relayKey) }), Buffer.from(c.nonce, 'base64url'), keys.publicKey, relayKey);
}
