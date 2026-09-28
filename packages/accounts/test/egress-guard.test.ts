// The suite is offline by contract (AGENTS.md: mocks only, no network); scripts/test.sh loads
// scripts/test-egress-guard.cjs into every node of the run so a public address fails loudly while loopback
// fake servers and Unix-socket IPC stay usable. This pins that boundary where it once leaked: an unstubbed
// sign-out attempted the real auth.openai.com revoke with a fake token (backpass finding).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createConnection, type AddressInfo, Socket } from 'node:net';
import { Accounts, memoryStore } from '../src/index.ts';
import { scratchDir } from '../../test-support.ts';

const guarded = (globalThis as { __byokitEgressGuard?: boolean }).__byokitEgressGuard === true;
const blocked = (e: unknown) => e instanceof Error && /byokit tests are offline.*blocked by scripts\/test-egress-guard\.cjs/.test(e.cause instanceof Error ? e.cause.message : e.message);

test('the guard is loaded and loopback fake servers still answer', async () => {
  assert.equal(guarded, true, 'run the suite through scripts/test.sh (npm test); the egress guard is missing');
  const server = createServer((req, res) => { res.end('loopback'); });
  const listening = new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    await listening;
    const { port } = server.address() as AddressInfo;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'loopback');
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('Unix-socket IPC still connects', async () => {
  const path = `${scratchDir('egress')}/sock`;
  const server = createServer().listen(path);
  await new Promise<void>((r) => server.on('listening', r));
  try {
    await new Promise<void>((resolve, reject) => {
      const socket: Socket = createConnection({ path });
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
  } finally { await new Promise<void>((r) => server.close(() => r())); }
});

test('raw method connect forms: loopback stays usable, a trailing options object cannot shadow a public host', { skip: !guarded }, async () => {
  const path = `${scratchDir('egress')}/sock-flat`;
  const server = createServer(() => {});
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const unix = createServer().listen(path);
  await new Promise<void>((r) => unix.on('listening', r));
  const { port } = server.address() as AddressInfo;
  try {
    await new Promise<void>((resolve, reject) => {
      const socket: Socket = new Socket().connect(port, () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    await new Promise<void>((resolve, reject) => {
      const socket: Socket = new Socket().connect(path, () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    assert.throws(() => new Socket().connect(53, '192.0.2.1', {}, () => {}), /byokit tests are offline.*192\.0\.2\.1/);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await new Promise<void>((r) => unix.close(() => r()));
  }
});

test('a public address is denied immediately, with no dial', { skip: !guarded }, async () => {
  // 192.0.2.0/24 is documentation-only: reachable nowhere, so the only way this rejects is the guard itself.
  await assert.rejects(fetch('http://192.0.2.1/probe', { signal: AbortSignal.timeout(2_000) }), blocked);
  await assert.rejects(fetch('https://auth.openai.com/oauth/revoke', { method: 'POST', signal: AbortSignal.timeout(2_000) }), blocked);
});

test('an unstubbed sign-out can no longer attempt the real revoke endpoint', { skip: !guarded }, async () => {
  const store = memoryStore();
  await store.modify('openai-codex', async () => ({ type: 'oauth', access: 'at_guard', refresh: 'rt_guard', expires: Date.now() + 3_600_000, accountId: 'acct_guard' }));
  const a = new Accounts({ store: () => store });
  await assert.rejects(a.logout(1, 'chatgpt'), blocked);
  assert.equal(await store.read('openai-codex'), undefined, 'the credential is still deleted here whatever the revoke did');
});

test('a datagram to a public address is denied', { skip: !guarded }, async () => {
  const { createSocket } = await import('node:dgram');
  const socket = createSocket('udp4');
  try {
    assert.throws(() => socket.send(Buffer.from('ping'), 53, '192.0.2.1'), /byokit tests are offline.*192\.0\.2\.1/);
    assert.throws(() => socket.connect(53, '192.0.2.1'), /byokit tests are offline.*192\.0\.2\.1/);
  } finally { socket.close(); }
});
