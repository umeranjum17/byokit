import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import nacl from 'tweetnacl';
import { WebSocketServer } from 'ws';
import { DeviceLink, Host, LinkError, b64url, keyPairFrom, type DeviceGrant } from '../src/index.ts';

const until = async (check: () => boolean) => {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) if (check()) return;
  throw new Error('timed out');
};

test('muxr box keys migrate unchanged to view and control grants without pairing', async () => {
  const machine = nacl.box.keyPair();
  const machineSecret = Buffer.from(machine.secretKey).toString('base64');
  const machinePublic = Buffer.from(machine.publicKey).toString('base64');
  const keys = keyPairFrom(Buffer.from(machineSecret, 'base64'));
  assert.deepEqual(Buffer.from(keys.publicKey), Buffer.from(machine.publicKey));
  let confirmations = 0;
  const host = await Host.open({
    keys, name: 'Computer', confirm: () => { confirmations++; return true; },
    canView: (req) => req.op === 'get.state',
    handle: (req) => ({ op: req.op }),
  });
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => host.accept(ws));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/link`;
  const links: DeviceLink[] = [];
  try {
    for (const [authority, role] of [['observe', 'view'], ['control', 'control']] as const) {
      const device = nacl.box.keyPair();
      const deviceSecret = Buffer.from(device.secretKey).toString('base64');
      const muxrDeviceId = `muxr-${authority}`;
      const grant = await host.enrol({ key: device.publicKey, name: authority, role, meta: { muxrDeviceId, kind: 'phone' } });
      const stored: DeviceGrant = {
        v: 1, secretKey: b64url(Buffer.from(deviceSecret, 'base64')),
        host: b64url(Buffer.from(machinePublic, 'base64')),
        hostName: 'Computer', urls: [url], device: { id: '', name: '', role },
      };
      const link = new DeviceLink(stored);
      links.push(link);
      await until(() => link.status === 'online');
      assert.equal(link.grant.device.id, grant.id);
      assert.deepEqual(await link.request('get.state'), { op: 'get.state' });
      if (role === 'view') await assert.rejects(link.request('send.message'), (e: LinkError) => e.code === 'view-only');
      else assert.deepEqual(await link.request('send.message'), { op: 'send.message' });
      await host.revoke(grant.id);
      await until(() => link.status === 'removed');
      assert.equal(host.devices().length, 0);
    }
    assert.equal(confirmations, 0);
  } finally {
    for (const link of links) link.stop();
    host.close();
    wss.close();
    server.close();
  }
});
