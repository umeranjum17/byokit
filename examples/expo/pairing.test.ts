import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import ws from 'ws';
import { Host, keyPair, type DeviceGrant } from '@byokit/pair';
import { forgettableStore, pairInput } from './pairing.ts';

test('typed code and offer both pair with the computer', async () => {
  const host = await Host.open({ keys: keyPair(), name: 'Kitchen computer', confirm: () => true, handle: () => ({}) });
  const server = createServer();
  const Server = (ws as unknown as { Server: new (o: { server: typeof server }) => {
    on(event: 'connection', listener: (socket: Parameters<typeof host.accept>[0]) => void): void;
    close(): void;
  } }).Server;
  const wss = new Server({ server });
  wss.on('connection', (socket) => host.accept(socket));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  try {
    const options = { name: 'Phone', onWords: (_words: string) => {} };
    const code = host.code({ role: 'control' }).code;
    assert.equal((await pairInput(`  ${code.toLowerCase()}  `, url, options)).hostName, 'Kitchen computer');
    assert.equal((await pairInput(`  ${host.offer({ role: 'control', urls: [url] }).text}  `, '', options)).hostName, 'Kitchen computer');
  } finally { host.close(); wss.close(); server.close(); }
});

// Lead-requested offline regression for the actual shell selector, not native acceptance proof.
test('the native journey scrolls past clipped nodes before tapping', () => {
  const script = readFileSync(new URL('./e2e-android.sh', import.meta.url), 'utf8');
  const selectors = script.slice(script.indexOf('seek() {'), script.indexOf('expect() {'));
  for (const bounds of ['[219,1884][741,1848]', '[219,1848][741,1848]']) {
    const run = spawnSync('sh', ['-c', `
      set -eu
      step=0
      screen() {
        if [ "$step" = 0 ]; then
          printf '%s\\n' '<node resource-id="question" bounds="${bounds}"/>'
        else
          printf '%s\\n' '<node resource-id="question" bounds="[219,1400][741,1600]"/>'
        fi
      }
      scroll() { step=1; echo "scroll $1" >&2; }
      a() { printf '%s\\n' "$*"; }
      ${selectors}
      tap question
    `], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, 'scroll up\n', bounds);
    assert.equal(run.stdout, 'shell input tap 480 1500\n', bounds);
  }
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
