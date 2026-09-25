// The link's crypto. None of it is ours: the handshakes are Noise from noise-handshake, and the primitives are libsodium
// (sodium-native in Node, sodium-javascript in browsers and React Native). See SECURITY.md.
//
// - Scanned code, and every later connection: Noise_IK_25519_ChaChaPoly_BLAKE2b. The device knows the host's static
//   key (from the QR, then its grant) and sends its own static key encrypted in the first message.
// - Typed code: Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b, the code as the pre-shared key. Neither side knows the other's
//   key yet; only someone who holds the code can finish the handshake.
//
// After the handshake each direction has its own CipherState, whose nonce counter refuses any replayed, dropped,
// reordered or reflected frame.
import b4a from 'b4a';
import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher.js';
import dh from 'noise-handshake/dh.js';
import sodium from 'sodium-universal';
import { CONFIRM_WORDS } from './confirm-words.ts';

export type KeyPair = { publicKey: Uint8Array; secretKey: Uint8Array };
export type Mode = 'ik' | 'code';

/** Mixed into every handshake, so a v2 of this protocol can never be confused with v1. */
export const PROLOGUE = 'byokit-link-v1';
const CHUNK = 60_000; // a Noise message is at most 65535 bytes; larger payloads go in pieces
const MAX_MESSAGE = 16 << 20; // what one reassembled message may grow to before the socket is dropped
// ponytail: noise-handshake writes a 32-bit nonce counter, so a socket stops at 2^32 frames; rekey if one ever gets close.
const MAX_FRAMES = 2 ** 32 - 1;

const text = new TextEncoder();
const untext = new TextDecoder('utf-8', { fatal: true });

export const b64 = (u: Uint8Array): string => b4a.toString(b4a.from(u), 'base64');
export const unb64 = (s: string): Uint8Array => b4a.from(s, 'base64');
export const b64url = (u: Uint8Array): string => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export function unb64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('not base64url');
  return unb64(s.replace(/-/g, '+').replace(/_/g, '/'));
}

export const keyPair = (): KeyPair => dh.generateKeyPair();
export const keyPairFrom = (secretKey: Uint8Array): KeyPair => dh.generateKeyPair(b4a.from(secretKey));

export function hash(bytes: number, ...parts: (Uint8Array | string)[]): Uint8Array {
  const out = b4a.alloc(bytes);
  sodium.crypto_generichash(out, b4a.concat(parts.map((p) => (typeof p === 'string' ? b4a.from(text.encode(p)) : b4a.from(p)))));
  return out;
}

export function random(bytes: number): Uint8Array {
  const out = b4a.alloc(bytes);
  sodium.randombytes_buf(out);
  return out;
}

/** The host's address on a relay: a hash of its public key, so the relay needs nothing else. */
export const hostId = (hostKey: Uint8Array): string => b64url(hash(16, 'byokit-link-host-id-v1', hostKey));

const encode = (msg: unknown) => b4a.from(text.encode(JSON.stringify(msg)));
const decode = (bytes: Uint8Array) => (bytes.byteLength ? JSON.parse(untext.decode(bytes)) : {});

/** One handshake. The first frame an initiator writes carries its mode in the clear (`ik:` or `code:`), so the host
 *  knows which handshake to run; everything after that is bare base64. */
export class Handshake {
  readonly mode: Mode;
  private hs: any;
  private first: boolean;

  constructor(mode: Mode, initiator: boolean, me: KeyPair, opt: { remote?: Uint8Array; psk?: Uint8Array } = {}) {
    this.mode = mode;
    this.first = initiator;
    this.hs = new Noise(mode === 'ik' ? 'IK' : 'XXpsk0', initiator, { publicKey: b4a.from(me.publicKey), secretKey: b4a.from(me.secretKey) },
      mode === 'code' ? { psk: b4a.from(opt.psk!) } : undefined);
    this.hs.initialise(b4a.from(text.encode(PROLOGUE)), opt.remote ? b4a.from(opt.remote) : undefined);
  }

  write(payload: unknown = {}): string {
    const frame = b64(this.hs.send(encode(payload)));
    if (!this.first) return frame;
    this.first = false;
    return `${this.mode}:${frame}`;
  }

  /** The payload, or a throw unless this is the next authentic handshake message. */
  read(frame: string): any {
    return decode(this.hs.recv(unb64(frame)));
  }

  get done(): boolean { return this.hs.complete; }
  /** The other side's static public key, once the handshake has revealed it. */
  get remoteKey(): Uint8Array { return new Uint8Array(this.hs.rs); }
  /** The same two words on both screens: they match only if both ends ran this very handshake. */
  get words(): string { return confirmWords(this.hs.hash); }
  channel(): Channel { return new Channel(this.hs); }
}

/** Splits an initiator's first frame into its mode and the Noise message. */
export function firstFrame(frame: string): { mode: Mode; body: string } {
  const m = /^(ik|code):(.*)$/s.exec(frame);
  if (!m) throw new Error('not a link handshake');
  return { mode: m[1] as Mode, body: m[2] };
}

function confirmWords(handshakeHash: Uint8Array): string {
  const h = hash(16, 'byokit-link-words-v1', handshakeHash); // BLAKE2b gives at least 16 bytes; two are used
  return `${CONFIRM_WORDS[h[0]]} ${CONFIRM_WORDS[h[1]]}`;
}

/** One socket's two Noise CipherStates. Frames are base64 text, so every WebSocket and every relay carries them. */
export class Channel {
  private tx: any;
  private rx: any;
  private parts: Uint8Array[] = [];
  private size = 0;

  constructor(hs: any) {
    this.tx = new Cipher(hs.tx);
    this.rx = new Cipher(hs.rx);
  }

  /** One or more frames; send them in order. */
  seal(msg: unknown): string[] {
    const body = encode(msg);
    const out: string[] = [];
    for (let at = 0; at === 0 || at < body.length; at += CHUNK) {
      if (this.tx.nonce >= MAX_FRAMES) throw new Error('this connection has carried all it can; reconnect');
      const more = at + CHUNK < body.length ? 1 : 0;
      out.push(b64(this.tx.encrypt(b4a.concat([b4a.from([more]), body.subarray(at, at + CHUNK)]))));
    }
    return out;
  }

  /** The whole message once its last frame arrives, else undefined. Throws on any frame that is not the next
   *  authentic one from the other end, and on a message that grows past 16 MB. */
  open(frame: string): any {
    if (this.rx.nonce >= MAX_FRAMES) throw new Error('this connection has carried all it can; reconnect');
    const plain: Uint8Array = this.rx.decrypt(unb64(frame));
    this.size += plain.byteLength - 1;
    if (this.size > MAX_MESSAGE) throw new Error('message too large');
    this.parts.push(plain.subarray(1));
    if (plain[0] === 1) return undefined;
    const whole = b4a.concat(this.parts);
    this.parts = [];
    this.size = 0;
    return decode(whole);
  }
}
