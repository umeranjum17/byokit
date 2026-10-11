// The pairing QR, by checklist row: P1 a real offer, drawn, then scanned back; P24 its border and terminal drawing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jsqr from 'jsqr';
import { Host, keyPair } from '../../pair/src/index.ts';
import { qrMatrix, qrText } from '../src/link.ts';

test('P1: the QR of a real pairing offer scans back to the same text', async () => {
  const host = await Host.open({ keys: keyPair(), name: 'Kitchen computer', confirm: () => true, handle: () => ({}) });
  try {
    const { text } = host.offer({ role: 'control', urls: ['wss://relay.example.com/link/v1/abc', 'ws://192.168.1.20:8787/link'] });
    const m = qrMatrix(text);
    assert.ok(m.length === m[0].length && m.length > 21, 'square, and bigger than the smallest QR');
    // Draw it 4 pixels a module, as a screen would, and scan it.
    const px = 4, size = m.length * px, rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const v = m[Math.floor(y / px)][Math.floor(x / px)] ? 0 : 255;
      rgba.set([v, v, v, 255], (y * size + x) * 4);
    }
    const scan = jsqr as unknown as typeof jsqr.default; // CommonJS: the default export is the module itself
    assert.equal(scan(rgba, size, size)?.data, text);
  } finally { host.close(); }
});

test('P24: qrMatrix takes a border, and qrText draws the same matrix as half blocks', () => {
  const def = qrMatrix('hello');
  assert.deepEqual(qrMatrix('hello', { border: 2 }), def);
  const bare = qrMatrix('hello', { border: 0 });
  assert.ok(bare.length === bare[0].length && bare.length >= 21 && bare.length < def.length);
  const lines = qrText('hello').split('\n');
  assert.equal(lines.length, Math.ceil(def.length / 2));
  const bit = (ch: string, top: boolean): boolean => (ch === '█' ? true : ch === ' ' ? false : top ? ch === '▀' : ch === '▄');
  lines.forEach((line, r) => {
    const chars = [...line.padEnd(def.length, ' ')];
    assert.equal(chars.length, def.length);
    chars.forEach((ch, x) => {
      assert.ok(ch === '█' || ch === '▀' || ch === '▄' || ch === ' ', `half block, saw ${JSON.stringify(ch)}`);
      assert.equal(bit(ch, true), def[2 * r][x], `top module row ${2 * r} col ${x}`);
      if (2 * r + 1 < def.length) assert.equal(bit(ch, false), def[2 * r + 1][x], `bottom module row ${2 * r + 1} col ${x}`);
    });
  });
});
