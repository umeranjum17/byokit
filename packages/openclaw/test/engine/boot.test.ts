// O11 cold boot: the first kit.start() on a fresh state dir rides out gateway boot instead of rejecting
// `connect ECONNREFUSED 127.0.0.1:<port>` (firstmate steer 002; Crewhouse reproduced it on a cold state:
// connect() handed the transport to the gateway before it listened and the transport rejected on the first
// onConnectError ~6s in). Now the transport retries within start's 90s handshake budget while the child is
// alive; a throw here fails the case. Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { scratchDir } from '../../../test-support.ts';

const install = scratchDir('o11-engine-boot');
const engineDir = join(install, 'engine');

before(async () => {
  // Install the pin once; the case boots from a cold state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

test('cold boot: the first start() reaches ready without ECONNREFUSED', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o11-boot');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 10_000 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.ok(kit.hello, 'no hello after cold boot');
    assert.equal(kit.hello.protocol, 4);
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

// O11 fan-out gap: a second connection handshakes with the paired device.json shape
// ({ deviceId, publicKeyPem, privateKeyPem }) holding the same key material, proving the kit can sit on a
// gateway-paired state dir. Throwaway keys only; each case owns its state dir.
test('a paired-shape device.json handshakes with identical key material', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o11-paired');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 10_000 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    const root = join(stateDir, 'openclaw');
    const shaped = JSON.parse(readFileSync(join(root, 'device.json'), 'utf8')) as { privateKey: string; publicKey: string };
    const raw32 = createPublicKey(shaped.publicKey).export({ format: 'der', type: 'spki' }).subarray(-32);
    writeFileSync(join(root, 'device.json'), JSON.stringify({ deviceId: createHash('sha256').update(raw32).digest('hex'),
      publicKeyPem: shaped.publicKey, privateKeyPem: shaped.privateKey }));
    const peer = gatewayTransport({ port: Number(readFileSync(join(root, 'port'), 'utf8')),
      token: readFileSync(join(root, 'token'), 'utf8').trim(),
      identityPath: join(root, 'device.json'), bridgeSock: join(root, 'bridge.sock') });
    try {
      const hello = await peer.start();
      assert.equal(hello.protocol, 4);
    } finally {
      await peer.stop().catch(() => {});
    }
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
