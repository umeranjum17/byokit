// The link's crypto. None of it is ours: the handshakes are Noise from noise-handshake over libsodium (sodium-native in
// Node, sodium-javascript in browsers and React Native), and after the handshake each frame is sealed with
// ChaCha20-Poly1305 from @noble/ciphers, which is twice as fast as sodium-javascript on a phone. See SECURITY.md.
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
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
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
  sodium.crypto_generichash(out, b4a.concat(parts.map((p) => typeof p === 'string' ? b4a.from(p) : b4a.from(p))));
  return out;
}

export function random(bytes: number): Uint8Array {
  const out = b4a.alloc(bytes);
  sodium.randombytes_buf(out);
  return out;
}

/** The host's address on a relay: a hash of its public key, so the relay needs nothing else. */
export const hostId = (hostKey: Uint8Array): string => b64url(hash(16, 'byokit-link-host-id-v1', hostKey));

export function messageBytes(msg: unknown): Uint8Array {
  const body = b4a.from(JSON.stringify(msg));
  if (body.byteLength > MAX_MESSAGE) throw new Error('message too large');
  return body;
}
const decode = (bytes: Uint8Array) => (bytes.byteLength ? JSON.parse(b4a.toString(b4a.from(bytes))) : {});

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
    this.hs.initialise(b4a.from(PROLOGUE), opt.remote ? b4a.from(opt.remote) : undefined);
  }

  write(payload: unknown = {}): string {
    const frame = b64(this.hs.send(messageBytes(payload)));
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

/** Noise's CipherState for one direction: ChaCha20-Poly1305 with the key the handshake gave it, a nonce of four zero
 *  bytes and the 64-bit little-endian frame counter, and no associated data. The same bytes as noise-handshake's own
 *  (test/channel.test.ts checks both ways); a frame that fails to open doesn't move the counter. */
export class Transport {
  nonce = 0;
  private key: Uint8Array;

  constructor(key: Uint8Array) { this.key = new Uint8Array(key); }

  private iv(): Uint8Array {
    const iv = new Uint8Array(12);
    const v = new DataView(iv.buffer);
    v.setUint32(4, this.nonce >>> 0, true);
    v.setUint32(8, Math.floor(this.nonce / 2 ** 32), true);
    return iv;
  }

  encrypt(plain: Uint8Array): Uint8Array {
    const sealed = chacha20poly1305(this.key, this.iv()).encrypt(plain);
    this.nonce++;
    return sealed;
  }

  /** Throws unless `sealed` is the next authentic frame. */
  decrypt(sealed: Uint8Array): Uint8Array {
    if (sealed.byteLength > 65535) throw new Error('frame too large'); // Noise's limit
    const plain = chacha20poly1305(this.key, this.iv()).decrypt(sealed);
    this.nonce++;
    return plain;
  }
}

/** One socket's two Noise CipherStates. Frames are base64 text, so every WebSocket and every relay carries them; a
 *  stream's bytes may also go as the same frame in a binary WebSocket message, where both ends are direct.
 *  Inside, each frame's first byte says what it carries: 0 or 1 a JSON message (1: more frames follow), 2 or 3 a
 *  stream's bytes (a 4-byte stream id, then raw bytes), so a stream chunk isn't base64 inside JSON as well. */
export class Channel {
  private tx: Transport;
  private rx: Transport;
  private parts: Uint8Array[] = [];
  private size = 0;
  private kind = 0; // 0 JSON, 2 stream bytes: what the message being reassembled is

  constructor(hs: any) {
    this.tx = new Transport(hs.tx);
    this.rx = new Transport(hs.rx);
  }

  /** One or more frames; send them in order. */
  seal(msg: unknown): string[] {
    return this.frames(messageBytes(msg), 0).map(b64);
  }

  /** A stream's bytes as raw frames: send each as a binary WebSocket message, or `b64` it where only text goes (a
   *  relay). `open` gives them back as `{ t: 'data', s, d }`. Only for a peer that speaks streams. */
  sealData(s: number, data: Uint8Array): Uint8Array[] {
    const head = b4a.alloc(4);
    new DataView(head.buffer, head.byteOffset, 4).setUint32(0, s);
    return this.frames(b4a.concat([head, b4a.from(data)]), 2);
  }

  private frames(body: Uint8Array, kind: number): Uint8Array[] {
    const out: Uint8Array[] = [];
    for (let at = 0; at === 0 || at < body.length; at += CHUNK) {
      if (this.tx.nonce >= MAX_FRAMES) throw new Error('this connection has carried all it can; reconnect');
      const more = at + CHUNK < body.length ? 1 : 0;
      out.push(this.tx.encrypt(b4a.concat([b4a.from([kind | more]), body.subarray(at, at + CHUNK)])));
    }
    return out;
  }

  /** The whole message once its last frame arrives, else undefined. Throws on any frame that is not the next
   *  authentic one from the other end, and on a message that grows past 16 MB. */
  open(frame: string | Uint8Array): any {
    if (this.rx.nonce >= MAX_FRAMES) throw new Error('this connection has carried all it can; reconnect');
    const plain: Uint8Array = this.rx.decrypt(typeof frame === 'string' ? unb64(frame) : frame);
    const flag = plain[0];
    if (flag > 3 || (this.parts.length && (flag & 2) !== this.kind)) throw new Error('bad frame');
    this.kind = flag & 2;
    this.size += plain.byteLength - 1;
    if (this.size > MAX_MESSAGE) throw new Error('message too large');
    this.parts.push(plain.subarray(1));
    if (flag & 1) return undefined;
    const whole: Uint8Array = b4a.concat(this.parts);
    this.parts = [];
    this.size = 0;
    if (!this.kind) return decode(whole);
    if (whole.byteLength < 4) throw new Error('bad frame');
    return { t: 'data', s: new DataView(whole.buffer, whole.byteOffset, 4).getUint32(0), d: whole.subarray(4) };
  }
}
