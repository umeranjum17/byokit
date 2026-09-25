// Stream throughput: link's stream bytes (`Channel.sealData`) in binary WebSocket frames and in text frames (a relay),
// the same bytes as base64 inside JSON, and muxr's tweetnacl envelopes today. `sh bench/hermes.sh` runs it in
// Hermes on the React Native graph (sodium-javascript, b4a/browser); `node bench/streams.ts` runs it in Node. Needs
// tweetnacl, pinned as a root dev dependency.
import b4a from 'b4a';
import nacl from 'tweetnacl';
import { Handshake, keyPair, b64, unb64 } from '../src/channel.ts';

declare const print: ((s: string) => void) | undefined;
const out = typeof print === 'function' ? print : console.log;

const host = keyPair(), dev = keyPair();
const i = new Handshake('ik', true, dev, { remote: host.publicKey });
const r = new Handshake('ik', false, host);
r.read(i.write({ v: 1 }).slice(3)); i.read(r.write());
const tx = i.channel(), rx = r.channel();
const naclKey = nacl.randomBytes(32);
const te = new TextEncoder(), td = new TextDecoder();

function bytes(n: number) { const u = new Uint8Array(n); for (let j = 0; j < n; j++) u[j] = (j * 31 + 7) & 255; return u; }

const cases: Record<string, (p: Uint8Array) => number> = {
  // The pre-stream JSON/text encoding cost: base64 inside JSON inside ChaCha inside base64.
  'link text (json+b64)': (p) => {
    const frames = tx.seal({ t: 'data', s: 1, d: b64(p) });
    let m: any; for (const f of frames) m = rx.open(f);
    if (unb64(m.d).length !== p.length) throw new Error('bad');
    return frames.reduce((n, f) => n + f.length, 0);
  },
  // What link streams send through a relay: the bytes as a binary inner message, the frame base64 text.
  'link sealData, text frames (relay)': (p) => {
    const frames = tx.sealData(1, p).map(b64);
    let m: any; for (const f of frames) m = rx.open(f);
    if (m.d.length !== p.length) throw new Error('bad');
    return frames.reduce((n, f) => n + f.length, 0);
  },
  // What link streams send on a direct socket: binary WebSocket messages, no base64 anywhere.
  'link sealData, binary frames': (p) => {
    const frames = tx.sealData(1, p);
    let m: any; for (const f of frames) m = rx.open(f);
    if (m.d.length !== p.length) throw new Error('bad');
    return frames.reduce((n, f) => n + f.byteLength, 0);
  },
  // muxr today: terminal/session payloads are JSON sealed with secretbox, enveloped as `e2ee:v2:<base64>`.
  'muxr tweetnacl (json+b64)': (p) => {
    const nonce = nacl.randomBytes(24);
    const box = nacl.secretbox(te.encode(JSON.stringify({ t: 'data', d: b64(p) })), nonce, naclKey);
    const wire = 'e2ee:v2:' + b64(b4a.concat([nonce, box]));
    const raw = unb64(wire.slice(8));
    const opened = nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), naclKey)!;
    if (unb64(JSON.parse(td.decode(opened)).d).length !== p.length) throw new Error('bad');
    return wire.length;
  },
  // muxr's preview tunnel: binary secretbox per TCP payload.
  'muxr tweetnacl binary (preview)': (p) => {
    const nonce = nacl.randomBytes(24);
    const box = b4a.concat([nonce, nacl.secretbox(p, nonce, naclKey)]);
    const opened = nacl.secretbox.open(box.subarray(24), box.subarray(0, 24), naclKey)!;
    if (opened.length !== p.length) throw new Error('bad');
    return box.length;
  },
};

// What the phone alone pays: the host (Node, sodium-native) seals; the phone opens a batch.
const phoneOpen: Record<string, (p: Uint8Array, k: number) => () => void> = {
  'link text (json+b64)': (p, k) => { const fs: string[] = []; for (let j = 0; j < k; j++) fs.push(...tx.seal({ t: 'data', s: 1, d: b64(p) })); return () => { for (const f of fs) { const m = rx.open(f); if (m) unb64(m.d); } }; },
  'link sealData, text frames (relay)': (p, k) => { const fs: string[] = []; for (let j = 0; j < k; j++) fs.push(...tx.sealData(1, p).map(b64)); return () => { for (const f of fs) rx.open(f); }; },
  'link sealData, binary frames': (p, k) => { const fs: Uint8Array[] = []; for (let j = 0; j < k; j++) fs.push(...tx.sealData(1, p)); return () => { for (const f of fs) rx.open(f); }; },
  'muxr tweetnacl (json+b64)': (p, k) => { const fs: string[] = []; for (let j = 0; j < k; j++) { const nonce = nacl.randomBytes(24); fs.push('e2ee:v2:' + b64(b4a.concat([nonce, nacl.secretbox(te.encode(JSON.stringify({ t: 'data', d: b64(p) })), nonce, naclKey)]))); } return () => { for (const w of fs) { const raw = unb64(w.slice(8)); unb64(JSON.parse(td.decode(nacl.secretbox.open(raw.subarray(24), raw.subarray(0, 24), naclKey)!)).d); } }; },
  'muxr tweetnacl binary (preview)': (p, k) => { const fs: Uint8Array[] = []; for (let j = 0; j < k; j++) { const nonce = nacl.randomBytes(24); fs.push(b4a.concat([nonce, nacl.secretbox(p, nonce, naclKey)])); } return () => { for (const b of fs) nacl.secretbox.open(b.subarray(24), b.subarray(0, 24), naclKey); }; },
};
out('phone opens | payload | case | MB/s');
for (const size of [64, 4096, 60000]) {
  const p = bytes(size), k = Math.max(20, Math.floor(3e6 / size));
  for (const [name, mk] of Object.entries(phoneOpen)) {
    const run = mk(p, k); const start = Date.now(); run();
    out(`open | ${size} | ${name} | ${((k * size) / ((Date.now() - start) / 1000) / 1e6).toFixed(2)}`);
  }
}

out('payload | case | MB/s (seal+open) | wire bytes per payload byte');
for (const size of [64, 4096, 60000]) {
  const p = bytes(size);
  for (const [name, fn] of Object.entries(cases)) {
    for (let w = 0; w < 20; w++) fn(p); // warm up
    let n = 0, wire = 0;
    const start = Date.now();
    while (Date.now() - start < 1500) { wire = fn(p); n++; }
    const mbs = (n * size) / ((Date.now() - start) / 1000) / 1e6;
    out(`${size} | ${name} | ${mbs.toFixed(2)} | ${(wire / size).toFixed(2)}`);
  }
}
