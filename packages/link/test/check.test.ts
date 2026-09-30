// check(): a reachability probe that leaves the one-time offer alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { check, LINK_WORDS } from '../src/index.ts';
import { closers, pairWithOffer, startHost } from './helpers.ts';

async function closedPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `ws://127.0.0.1:${port}/link`;
}

test('check ok leaves the offer usable: it still pairs afterwards, host never asked', async () => {
  const h = await startHost();
  const offer = h.host.offer({ role: 'control', urls: [h.url] });
  assert.deepEqual(await check([h.url], { timeoutMs: 2000 }), [{ url: h.url, ok: true }]);
  assert.deepEqual(await check([h.url], { timeoutMs: 2000 }), [{ url: h.url, ok: true }]);
  assert.equal(h.asked.length, 0); // the probe never reached pairing
  const grant = await pairWithOffer(offer.text, { name: 'Umer phone' });
  assert.equal(grant.device.name, 'Umer phone');
  assert.equal(h.asked.length, 1); // only the real pairing asked
});

test('check maps failures to LinkProblem codes with sentences', async () => {
  const h = await startHost();
  // Something else answers: a WebSocket server that is not a link host.
  const other = createServer();
  const wss = new WebSocketServer({ server: other });
  wss.on('connection', (ws) => ws.on('message', () => ws.send('not a link host')));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const wrongUrl = `ws://127.0.0.1:${(other.address() as AddressInfo).port}/link`;
  closers.push(() => { wss.close(); other.close(); });
  // Nothing answers: a port that just closed.
  const dead = await closedPort();
  const [ok, wrong, deadR] = await check([h.url, wrongUrl, dead], { timeoutMs: 2000 });
  assert.deepEqual(ok, { url: h.url, ok: true });
  assert.deepEqual(wrong, { url: wrongUrl, ok: false, code: 'wrong-host', message: LINK_WORDS['wrong-host'] });
  assert.deepEqual(deadR, { url: dead, ok: false, code: 'unreachable', message: LINK_WORDS.unreachable });
});

test('check times out on a socket that never answers, keeping input order', async () => {
  const h = await startHost();
  const quiet = createServer(); // completes the upgrade, then never answers
  const silent = new WebSocketServer({ server: quiet });
  silent.on('connection', () => {});
  await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', r));
  closers.push(() => { silent.close(); quiet.close(); });
  const quietUrl = `ws://127.0.0.1:${(quiet.address() as AddressInfo).port}/link`;
  const [first, second, third] = await check([quietUrl, h.url, await closedPort()], { timeoutMs: 300 });
  assert.equal(first!.url, quietUrl);
  assert.deepEqual({ ...first, url: '' }, { url: '', ok: false, code: 'timeout', message: LINK_WORDS.timeout });
  assert.deepEqual(second, { url: h.url, ok: true });
  assert.equal(third!.ok, false);
});
