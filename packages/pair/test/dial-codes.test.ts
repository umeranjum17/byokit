// K2: "can't reach the computer" (network or firewall) versus "the computer is slow".
// A dial or probe whose socket never opens ends as `unreachable`; an open socket
// with no answer ends as `slow`. Each word set carries its next step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, LINK_WORDS, type LinkError } from '../src/index.ts';
import { pairWithCode, startHost } from './helpers.ts';

/** A socket that never opens: the network or firewall dropped it. */
class NeverOpens {
  onopen: unknown = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  binaryType = '';
  constructor(_url: string) {}
  send(_data: string) {}
  close() {}
}

/** A socket that opens and then stays silent: the computer is slow. */
class OpensSilent {
  onopen: (() => void) | null = null;
  onmessage: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  binaryType = '';
  constructor(_url: string) {
    setTimeout(() => { try { this.onopen?.(); } catch {} }, 0);
  }
  send(_data: string) {}
  close() {}
}

test('dial that never opens is unreachable, with the network-or-firewall next step', async () => {
  const h = await startHost();
  const { code } = h.host.shortCode({ role: 'control' });
  await assert.rejects(
    pairWithCode(h.url, code, { name: 'Umer phone', timeoutMs: 150, WebSocket: NeverOpens as any }),
    (e: LinkError) => e.code === 'unreachable' && e.message === LINK_WORDS.unreachable && !e.sealed,
  );
  assert.match(LINK_WORDS.unreachable, /same network/i, 'says the next step');
  assert.match(LINK_WORDS.unreachable, /firewall/i, 'names the firewall');
  assert.deepEqual(h.asked, [], 'nothing reached the host');
});

test('dial that opens but stays silent is slow, with the wait-and-retry next step', async () => {
  const h = await startHost();
  const { code } = h.host.shortCode({ role: 'control' });
  await assert.rejects(
    pairWithCode(h.url, code, { name: 'Umer phone', timeoutMs: 150, WebSocket: OpensSilent as any }),
    (e: LinkError) => e.code === 'slow' && e.message === LINK_WORDS.slow && !e.sealed,
  );
  assert.match(LINK_WORDS.slow, /slow to answer/i, 'names the slow computer');
  assert.match(LINK_WORDS.slow, /try again/i, 'says the next step');
  assert.deepEqual(h.asked, [], 'nothing reached the host');
});

test('check that never opens is unreachable', async () => {
  const [r] = await check(['ws://127.0.0.1:1/link'], { timeoutMs: 150, WebSocket: NeverOpens as any });
  assert.deepEqual(r, { url: 'ws://127.0.0.1:1/link', ok: false, code: 'unreachable', message: LINK_WORDS.unreachable });
});

test('check that opens but stays silent is slow', async () => {
  const [r] = await check(['ws://127.0.0.1:1/link'], { timeoutMs: 150, WebSocket: OpensSilent as any });
  assert.deepEqual(r, { url: 'ws://127.0.0.1:1/link', ok: false, code: 'slow', message: LINK_WORDS.slow });
});
