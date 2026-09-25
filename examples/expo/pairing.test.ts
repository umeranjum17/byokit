import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Host, keyPair } from '@byokit/link';
import { pairInput } from './pairing.ts';

test('typed code and offer both pair with the computer', async () => {
  const host = await Host.open({ keys: keyPair(), name: 'Kitchen computer', confirm: () => true, handle: () => ({}) });
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => host.accept(ws));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  try {
    const options = { name: 'Phone', onWords: (_words: string) => {} };
    const code = host.code({ role: 'control' }).code;
    assert.equal((await pairInput(`  ${code.toLowerCase()}  `, url, options)).hostName, 'Kitchen computer');
    assert.equal((await pairInput(`  ${host.offer({ role: 'control', urls: [url] }).text}  `, '', options)).hostName, 'Kitchen computer');
  } finally { host.close(); wss.close(); server.close(); }
});
