import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Channel, Transport, b64, b64url, firstFrame } from '../src/channel.ts';
import { cleanName, decodeOffer, encodeOffer, offerText, parseOffer, type PairOffer } from '../src/pairing.ts';
import frames from '../../../fixtures/conformance/link-frames-typescript.json' with { type: 'json' };

// Fixed seed and bounded iterations: failures reproduce without a model, network or new dependency.
function random(seed: number) {
  return (max: number) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % max; };
}
const key = new Uint8Array(32).fill(7);
const receiver = () => new Channel({ tx: new Uint8Array(32).fill(8), rx: key });

test('frame conformance: authenticated malformed plaintext is rejected', () => {
  for (const c of frames.invalid) {
    assert.throws(() => receiver().open(new Transport(key).encrypt(Uint8Array.from(c.plain))), /bad frame/, c.name);
  }
});

test('seed 0x3c01: frame round trips, corruption, truncation, replay and first-frame parsing', () => {
  const next = random(0x3c01);
  for (let i = 0; i < 300; i++) {
    const body = Uint8Array.from({ length: next(512) }, () => next(256));
    const sender = new Channel({ tx: key, rx: new Uint8Array(32).fill(8) });
    const rx = receiver();
    const id = next(0xffff_ffff) + 1;
    const frame = sender.sealData(id, body)[0];
    const m = rx.open(i % 2 ? frame : b64(frame));
    assert.equal(m.s, id, `case ${i}`);
    assert.deepEqual(new Uint8Array(m.d), body);
    assert.throws(() => rx.open(frame), `replay case ${i}`);
    const corrupt = frame.slice();
    corrupt[next(corrupt.length)] ^= 1 << next(8);
    assert.throws(() => receiver().open(corrupt), `corruption case ${i}`);
    assert.throws(() => receiver().open(frame.subarray(0, next(frame.length))), `truncation case ${i}`);
    const msg = { t: 'req', id: i, text: String.fromCharCode(...body), nested: [null, true, i] };
    assert.deepEqual(receiver().open(senderForJson().seal(msg)[0]), msg);
    const suffix = b64(body);
    for (const mode of ['ik', 'code'] as const) assert.deepEqual(firstFrame(`${mode}:${suffix}`), { mode, body: suffix });
    assert.throws(() => firstFrame(`unknown:${suffix}`));
    // Authenticate random invalid kinds so the framing parser, not only the MAC, is exercised.
    const bad = Uint8Array.from([4 + next(252), ...body]);
    assert.throws(() => receiver().open(new Transport(key).encrypt(bad)), /bad frame/);
  }
});
function senderForJson() { return new Channel({ tx: key, rx: new Uint8Array(32).fill(8) }); }

test('seed 0x3c02: offers and offline envelopes preserve terms and reject mutated input', () => {
  const next = random(0x3c02);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  for (let i = 0; i < 250; i++) {
    const o: PairOffer = {
      v: 1, host: b64url(Uint8Array.from({ length: 32 }, () => next(256))),
      ticket: b64url(Uint8Array.from({ length: 16 }, () => next(256))),
      name: `Home ${i}\u202e\u0000 🍵`, expires: 1_900_000_000_000 + next(1_000_000),
      urls: Array.from({ length: 1 + next(8) }, (_, n) => `wss://relay${n}.example/link/v1/${i}`),
      role: next(2) ? 'control' : 'view', lifetime: 1 + next(86_400_000),
    };
    const expected = { ...o, name: cleanName(o.name, 'your computer') };
    assert.deepEqual(parseOffer(offerText(o, 'https://app.example/pair'), o.expires), expected);
    const code = encodeOffer(o).replace(/-/g, '');
    assert.deepEqual(decodeOffer(code.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l'), 0), expected);
    assert.throws(() => decodeOffer(code, o.expires + 1), /run out/);
    const at = next(code.length);
    const changed = alphabet[(alphabet.indexOf(code[at]) + 1 + next(31)) % 32];
    assert.throws(() => decodeOffer(code.slice(0, at) + changed + code.slice(at + 1), 0), `typo case ${i}`);
    assert.throws(() => decodeOffer(code + '0', 0), `padding case ${i}`);
    const patches = [ { host: 'bad' }, { ticket: 'bad' }, { v: 2 }, { expires: null }, { urls: [] },
      { urls: Array(9).fill('ws://home/link') }, { urls: ['ws://user:secret@home/link'] }, { urls: ['file:///secret'] } ];
    for (const patch of patches) {
      const text = 'byokit-link:1:' + b64url(new TextEncoder().encode(JSON.stringify({ ...o, ...patch })));
      assert.throws(() => parseOffer(text, 0), `invalid offer case ${i}`);
    }
    const junk = String.fromCharCode(...Array.from({ length: next(512) }, () => next(256)));
    assert.throws(() => parseOffer(junk, 0));
    assert.throws(() => decodeOffer('!' + junk, 0));
  }
});
