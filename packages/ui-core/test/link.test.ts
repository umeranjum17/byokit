// Pairing and link copy, by checklist row: P1 the QR (a real offer, drawn, then scanned back), P5 the consent before
// pairing; plus the two-word comparison phases and the link status, all in plain words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import jsqr from 'jsqr';
import { Host, keyPair } from '../../link/src/index.ts';
import { consentWords, linkWords, pairingView, qrMatrix, type LinkStatus, type PairPhase } from '../src/link.ts';

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


test('pairing phases show the two words to compare, and the link status is one plain sentence', () => {
  assert.deepEqual(pairingView({ phase: 'compare', hostName: 'Kitchen computer', words: 'maple river' }),
    { phase: 'compare', title: 'Check Kitchen computer shows these two words, then say yes there.', words: 'maple river' });
  assert.equal(pairingView({ phase: 'failed', error: 'Your computer said no to this device.' }).title, 'Your computer said no to this device.');
  for (const phase of ['scan', 'compare', 'waiting', 'paired', 'failed'] as PairPhase[]) plain(pairingView({ phase, hostName: 'Kitchen computer' }).title);
  for (const s of ['connecting', 'online', 'offline', 'refused', 'removed'] as LinkStatus[]) plain(linkWords(s, 'Kitchen computer'));
  assert.equal(linkWords('online', 'Kitchen computer'), 'Connected to Kitchen computer.');
});
