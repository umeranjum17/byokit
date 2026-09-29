// Pairing and link copy, by checklist row: P1 the QR (a real offer, drawn, then scanned back), P5 the consent before
// pairing; plus the two-word comparison phases and the link status, all in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsqr from 'jsqr';
import { Host, keyPair } from '../../link/src/index.ts';
import { consentWords, linkWords, pairingView, qrMatrix, qrText, type LinkStatus, type PairPhase } from '../src/link.ts';

const PLAIN = new RegExp(JSON.parse(readFileSync(new URL('../../../fixtures/conformance/plain-words.json', import.meta.url), 'utf8')).pattern, 'i');
const plain = (s: string) => assert.doesNotMatch(s.replace(/Kitchen computer|relay\.example\.com|example\.com/g, 'X'), PLAIN, s);

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

test('P5: consent says which computer, what this device may do, and for how long', () => {
  assert.equal(consentWords({ hostName: 'Kitchen computer', role: 'control' }),
    'Pair with Kitchen computer? This device will be able to see and change things on it, until you remove it there.');
  assert.equal(consentWords({ hostName: 'Kitchen computer', role: 'view' }),
    'Pair with Kitchen computer? This device will be able to see it, but not change anything, until you remove it there.');
  for (const role of ['control', 'view'] as const) plain(consentWords({ hostName: 'Kitchen computer', role }));
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

test('P25: consent and pairing words name a phone or a browser, and carry one app sentence', () => {
  assert.equal(consentWords({ hostName: 'Kitchen computer', role: 'control', device: 'browser' }),
    'Pair with Kitchen computer? This browser will be able to see and change things on it, until you remove it there.');
  assert.equal(consentWords({ hostName: 'Kitchen computer', role: 'view', device: 'phone', detail: 'It can also show the shopping list.' }),
    'Pair with Kitchen computer? This phone will be able to see it, but not change anything, until you remove it there. It can also show the shopping list.');
  assert.deepEqual(pairingView({ phase: 'scan', hostName: 'Kitchen computer', device: 'browser' }),
    { phase: 'scan', title: 'Open the pairing link on Kitchen computer, or type the code it shows.' });
  assert.equal(pairingView({ phase: 'paired', hostName: 'Kitchen computer', device: 'phone' }).title,
    'This phone is paired with Kitchen computer.');
  assert.equal(pairingView({ phase: 'paired', hostName: 'Kitchen computer' }).title,
    'This device is paired with Kitchen computer.');
  assert.equal(pairingView({ phase: 'compare', hostName: 'Kitchen computer', words: 'maple river', detail: 'It can also show the shopping list.' }).title,
    'Check Kitchen computer shows these two words, then say yes there. It can also show the shopping list.');
  for (const device of [undefined, 'phone', 'browser'] as const) {
    plain(consentWords({ hostName: 'Kitchen computer', role: 'control', device }));
    for (const phase of ['scan', 'compare', 'waiting', 'paired', 'failed'] as PairPhase[])
      plain(pairingView({ phase, hostName: 'Kitchen computer', device }).title);
  }
  plain(pairingView({ phase: 'compare', hostName: 'Kitchen computer', detail: 'It can also show the shopping list.' }).title);
});


test('pairing phases show the two words to compare, and the link status is one plain sentence', () => {
  assert.deepEqual(pairingView({ phase: 'compare', hostName: 'Kitchen computer', words: 'maple river' }),
    { phase: 'compare', title: 'Check Kitchen computer shows these two words, then say yes there.', words: 'maple river' });
  assert.equal(pairingView({ phase: 'failed', error: 'Your computer said no to this device.' }).title, 'Your computer said no to this device.');
  for (const phase of ['scan', 'compare', 'waiting', 'paired', 'failed'] as PairPhase[]) plain(pairingView({ phase, hostName: 'Kitchen computer' }).title);
  for (const s of ['connecting', 'online', 'offline', 'refused', 'removed'] as LinkStatus[]) plain(linkWords(s, 'Kitchen computer'));
  assert.equal(linkWords('online', 'Kitchen computer'), 'Connected to Kitchen computer.');
});
