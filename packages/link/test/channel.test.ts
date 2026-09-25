// The crypto: the library against the Noise spec's own test vectors, then what our channel adds on top.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import b4a from 'b4a';
import Noise from 'noise-handshake';
import Cipher from 'noise-handshake/cipher.js';
import dh from 'noise-handshake/dh.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import sodiumJs from 'sodium-javascript';
import vectors from './fixtures/noise-vectors.json' with { type: 'json' };
import aead from './fixtures/rfc8439-aead.json' with { type: 'json' };
import { Handshake, Transport, b64, firstFrame, keyPair } from '../src/channel.ts';
import { codeKey } from '../src/pairing.ts';

const hex = (s: string) => b4a.from(s, 'hex');
const pair = (secret: string) => dh.generateKeyPair(hex(secret));

test('noise-handshake matches the cacophony vectors for IK, XX and NNpsk0 (every token our two handshakes use)', () => {
  assert.deepEqual(vectors.vectors.map((v: any) => v.protocol_name).sort(),
    ['Noise_IK_25519_ChaChaPoly_BLAKE2b', 'Noise_NNpsk0_25519_ChaChaPoly_BLAKE2b', 'Noise_XX_25519_ChaChaPoly_BLAKE2b']);
  for (const v of vectors.vectors as any[]) {
    const pattern = v.protocol_name.split('_')[1];
    const psk = v.init_psks ? { psk: hex(v.init_psks[0]) } : undefined;
    const i = new Noise(pattern, true, v.init_static ? pair(v.init_static) : undefined, psk);
    const r = new Noise(pattern, false, v.resp_static ? pair(v.resp_static) : undefined, v.resp_psks ? { psk: hex(v.resp_psks[0]) } : undefined);
    i.initialise(hex(v.init_prologue), v.init_remote_static ? hex(v.init_remote_static) : undefined);
    r.initialise(hex(v.resp_prologue), v.resp_remote_static ? hex(v.resp_remote_static) : undefined);
    i.e = pair(v.init_ephemeral);
    r.e = pair(v.resp_ephemeral);
    let n = 0;
    for (; !i.complete; n++) {
      const [from, to] = n % 2 ? [r, i] : [i, r];
      const m = v.messages[n];
      const sent = from.send(hex(m.payload));
      assert.equal(b4a.toString(sent, 'hex'), m.ciphertext, `${v.protocol_name} handshake message ${n}`);
      assert.equal(b4a.toString(to.recv(sent), 'hex'), m.payload);
    }
    assert.equal(b4a.toString(i.hash, 'hex'), v.handshake_hash, `${v.protocol_name} handshake hash`);
    const ci = [new Cipher(i.tx), new Cipher(i.rx)], cr = [new Cipher(r.tx), new Cipher(r.rx)];
    for (; n < v.messages.length; n++) { // transport messages alternate, starting with the initiator
      const [tx, rx] = n % 2 ? [cr[0], ci[1]] : [ci[0], cr[1]];
      const m = v.messages[n];
      const ct = tx.encrypt(hex(m.payload));
      assert.equal(b4a.toString(ct, 'hex'), m.ciphertext, `${v.protocol_name} transport message ${n}`);
      assert.equal(b4a.toString(rx.decrypt(ct), 'hex'), m.payload);
    }
  }
});

/** A device and host that have just finished the IK handshake. */
function ik() {
  const [device, host] = [keyPair(), keyPair()];
  const d = new Handshake('ik', true, device, { remote: host.publicKey });
  const first = d.write({ v: 1 });
  const h = new Handshake('ik', false, host);
  assert.deepEqual(h.read(firstFrame(first).body), { v: 1 });
  d.read(h.write());
  return { device, host, d, h, dc: d.channel(), hc: h.channel() };
}

test('IK: both ends finish, the host learns the device key, and both show the same two words', () => {
  const { device, d, h, dc, hc } = ik();
  assert.ok(d.done && h.done);
  assert.deepEqual(h.remoteKey, new Uint8Array(device.publicKey));
  assert.match(d.words, /^[a-z]+ [a-z]+$/);
  assert.equal(d.words, h.words);
  const [f] = dc.seal({ hi: 'ünïcode ✓', secret: 'plaintext-marker' });
  assert.doesNotMatch(Buffer.from(f, 'base64').toString('latin1'), /marker|hi/, 'nothing readable on the wire');
  assert.deepEqual(hc.open(f), { hi: 'ünïcode ✓', secret: 'plaintext-marker' });
  assert.deepEqual(dc.open(hc.seal({ back: 1 })[0]), { back: 1 });
});

test('RFC 8439: @noble/ciphers ChaCha20-Poly1305 (the transport cipher) matches the AEAD vectors; a flipped bit is refused', () => {
  for (const v of aead.vectors) {
    const box = chacha20poly1305(hex(v.key), hex(v.nonce), hex(v.aad));
    assert.equal(b4a.toString(b4a.from(box.encrypt(hex(v.plaintext))), 'hex'), v.ciphertext + v.tag, `RFC 8439 ${v.name} seals`);
    const sealed = hex(v.ciphertext + v.tag);
    assert.equal(b4a.toString(b4a.from(box.decrypt(sealed)), 'hex'), v.plaintext, `RFC 8439 ${v.name} opens`);
    sealed[5] ^= 1;
    assert.throws(() => box.decrypt(sealed));
  }
});

test('the transport is byte for byte the previous one: noble-sealed frames open with sodium-native and sodium-javascript, and back', () => {
  const key = hex(aead.vectors[1].key);
  const noiseNonce = (n: number) => { const b = Buffer.alloc(12); b.writeUInt32LE(n, 4); return b; }; // counters stay under 2^32
  for (const n of [0, 1, 255, 65_536, 2 ** 32 - 2]) {
    for (const size of [0, 1, 1000, 60_001]) {
      const plain = b4a.from(Array.from({ length: size }, (_, i) => (i * 13 + n) & 255));
      const ours = new Transport(key); ours.nonce = n;
      const native = new Cipher(b4a.from(key)); native.nonce = n; // noise-handshake over sodium-native, as before
      const sealed = ours.encrypt(plain);
      assert.ok(b4a.equals(b4a.from(sealed), native.encrypt(plain)), `same frame at counter ${n}, ${size} bytes`);
      native.nonce = n;
      assert.ok(b4a.equals(native.decrypt(b4a.from(sealed)), plain), 'noble seals, sodium-native opens');
      const back = new Transport(key); back.nonce = n;
      native.nonce = n;
      assert.ok(b4a.equals(b4a.from(back.decrypt(native.encrypt(plain))), plain), 'sodium-native seals, noble opens');

      const js = b4a.alloc(size + 16); // sodium-javascript: what browsers and React Native used before
      sodiumJs.crypto_aead_chacha20poly1305_ietf_encrypt(js, plain, null, null, noiseNonce(n), key);
      assert.ok(b4a.equals(js, b4a.from(sealed)), 'sodium-javascript seals the same frame');
      const opened = b4a.alloc(size);
      sodiumJs.crypto_aead_chacha20poly1305_ietf_decrypt(opened, null, b4a.from(sealed), null, noiseNonce(n), key);
      assert.ok(b4a.equals(opened, plain), 'noble seals, sodium-javascript opens');
    }
  }
  const t = new Transport(key);
  const f = t.encrypt(b4a.from('hi'));
  const r = new Transport(key);
  f[0] ^= 1;
  assert.throws(() => r.decrypt(f));
  f[0] ^= 1;
  assert.equal(b4a.toString(b4a.from(r.decrypt(f))), 'hi', 'a frame that failed to open left the counter where it was');
  assert.throws(() => r.decrypt(new Uint8Array(65_536)), /too large/);
});

test('wrong keys are refused both ways', () => {
  const [device, host, other] = [keyPair(), keyPair(), keyPair()];
  // A device holding a different host key (a forged QR, or the wrong computer) can't reach the host.
  const toOther = new Handshake('ik', true, device, { remote: other.publicKey }).write({ v: 1 });
  assert.throws(() => new Handshake('ik', false, host).read(firstFrame(toOther).body));
  // And an answer from anyone but the host in the QR fails on the device.
  const d = new Handshake('ik', true, device, { remote: host.publicKey });
  d.write({ v: 1 });
  const impostor = new Handshake('ik', false, other);
  impostor.read(firstFrame(new Handshake('ik', true, device, { remote: other.publicKey }).write({ v: 1 })).body);
  assert.throws(() => d.read(impostor.write()));
});

test('typed code (XXpsk0): the right code finishes, a wrong one fails at the first message', () => {
  const [device, host] = [keyPair(), keyPair()];
  const d = new Handshake('code', true, device, { psk: codeKey('7KQ4-M2XP-9RTH') });
  const first = firstFrame(d.write());
  assert.equal(first.mode, 'code');
  assert.throws(() => new Handshake('code', false, host, { psk: codeKey('7KQ4-M2XP-9RTJ') }).read(first.body), 'a wrong code learns nothing');
  const h = new Handshake('code', false, host, { psk: codeKey('7kq4 m2xp 9rth') });
  h.read(first.body);
  d.read(h.write());
  assert.deepEqual(h.read(d.write({ name: 'Pixel' })), { name: 'Pixel' });
  assert.deepEqual(d.remoteKey, new Uint8Array(host.publicKey), 'the device learns the host key');
  assert.deepEqual(h.remoteKey, new Uint8Array(device.publicKey));
  assert.equal(d.words, h.words);
});

test('frames: replay, skip, reorder, tamper, reflection and another socket are all refused', () => {
  const { dc, hc } = ik();
  const [f0] = dc.seal({ n: 0 }), [f1] = dc.seal({ n: 1 }), [f2] = dc.seal({ n: 2 });
  assert.deepEqual(hc.open(f0), { n: 0 });
  assert.throws(() => hc.open(f0), 'a replayed frame');
  assert.throws(() => hc.open(f2), 'a skipped (or reordered) frame');
  const bytes = Buffer.from(f1, 'base64'); bytes[3] ^= 1;
  assert.throws(() => hc.open(bytes.toString('base64')), 'a flipped bit');
  const other = ik();
  const [h0] = other.hc.seal({ n: 'host' });
  assert.throws(() => other.hc.open(h0), "the host's own frame sent back to it (reflection)");
  assert.throws(() => hc.open(other.dc.seal({ n: 0 })[0]), 'a frame from another socket');
});

test('big messages go in pieces; one past 16 MB drops the socket; the 32-bit counter never wraps', () => {
  const { dc, hc } = ik();
  const frames = dc.seal({ text: 'x'.repeat(150_000) });
  assert.equal(frames.length, 3);
  assert.equal(hc.open(frames[0]), undefined);
  assert.equal(hc.open(frames[1]), undefined);
  assert.equal(hc.open(frames[2]).text.length, 150_000);
  assert.throws(() => dc.seal({ text: 'y'.repeat(17 << 20) }), /too large/);
  const worn = ik();
  (worn.dc as any).tx.nonce = 2 ** 32 - 1;
  assert.throws(() => worn.dc.seal({}), /reconnect/);
});


test('T4/F4: stream bytes go as binary inner messages, beside JSON ones; a message that changes kind midway is refused', () => {
  const { dc, hc } = ik();
  const bytes = Uint8Array.from({ length: 150_000 }, (_, i) => (i * 7) & 255);
  const frames = dc.sealData(7, bytes);
  assert.equal(frames.length, 3, 'chunked like any message');
  assert.ok(frames.every((f) => f instanceof Uint8Array), 'raw frames, for binary WebSocket messages');
  assert.ok(frames.reduce((n, f) => n + f.byteLength, 0) < bytes.length * 1.01, 'about one wire byte per byte');
  assert.equal(hc.open(frames[0]), undefined);
  assert.equal(hc.open(b64(frames[1])), undefined, 'or base64 text where only text goes (a relay), in the same sequence');
  const m = hc.open(frames[2]);
  assert.deepEqual([m.t, m.s], ['data', 7]);
  assert.deepEqual(new Uint8Array(m.d), bytes, 'byte for byte, no base64 inside');
  assert.deepEqual(hc.open(dc.seal({ t: 'credit', s: 7, n: 1 })[0]), { t: 'credit', s: 7, n: 1 });
  assert.equal(hc.open(dc.sealData(1, new Uint8Array(0))[0]).d.length, 0);
  assert.deepEqual(hc.open(b4a.from(Buffer.from(dc.seal({ json: 1 })[0], 'base64'))), { json: 1 }, 'JSON in a binary message opens too');

  const tx = (dc as any).tx;
  assert.equal(hc.open(b4a.toString(tx.encrypt(b4a.from([1, 123])), 'base64')), undefined, 'a JSON message begins');
  assert.throws(() => hc.open(b4a.toString(tx.encrypt(b4a.from([2, 0, 0, 0, 1])), 'base64')), /bad frame/);
  const fresh = ik();
  assert.throws(() => fresh.hc.open(b4a.toString((fresh.dc as any).tx.encrypt(b4a.from([4])), 'base64')), /bad frame/, 'an unknown kind');
  const short = ik();
  assert.throws(() => short.hc.open(b4a.toString((short.dc as any).tx.encrypt(b4a.from([2, 0])), 'base64')), /bad frame/, 'no room for a stream id');
});
