import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Host, keyPair, type DeviceGrant } from '@byokit/link';
import { forgettableStore, pairInput, pairingGeneration } from './pairing.ts';

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

test('late load and pairing completions cannot restore a forgotten generation', async () => {
  const generation = pairingGeneration();
  const applied: string[] = [];
  let finishLoad!: (name: string) => void;
  let finishPair!: (name: string) => void;
  const load = new Promise<string>((resolve) => { finishLoad = resolve; });
  const pair = new Promise<string>((resolve) => { finishPair = resolve; });
  const accept = async (pending: Promise<string>, current: number) => {
    const name = await pending;
    if (generation.isCurrent(current)) applied.push(name);
  };
  const loading = accept(load, generation.next());
  const pairing = accept(pair, generation.next());
  generation.next();
  finishLoad('old stored computer'); finishPair('old pending pair');
  await Promise.all([loading, pairing]);
  assert.deepEqual(applied, []);
  const next = generation.next();
  await accept(Promise.resolve('new pair'), next);
  assert.deepEqual(applied, ['new pair']);
});

test('forget waits for an in-flight save and suppresses queued reconnect saves', async () => {
  const grant: DeviceGrant = { v: 1, host: 'host', hostName: 'Kitchen', secretKey: 'secret', urls: [], device: { id: 'phone', name: 'Phone', role: 'control' } };
  let stored: DeviceGrant | null = null;
  let release!: () => void;
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const kept = forgettableStore({
    load: async () => stored,
    save: async (g) => { entered(); await writing; stored = g; },
    clear: async () => { stored = null; },
  });
  const first = kept.save(grant);
  await started;
  const reconnect = kept.save({ ...grant, hostName: 'Reconnected' });
  const forgetting = kept.forget();
  release();
  await Promise.all([first, reconnect, forgetting]);
  await kept.save(grant);
  assert.equal(await kept.load(), null);
});
