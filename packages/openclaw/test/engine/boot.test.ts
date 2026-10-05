// O11 cold boot: the first kit.start() on a fresh state dir rides out gateway boot instead of rejecting
// `connect ECONNREFUSED 127.0.0.1:<port>` (firstmate steer 002; Crewhouse reproduced it on a cold state:
// connect() handed the transport to the gateway before it listened and the transport rejected on the first
// onConnectError ~6s in). Now the transport retries within start's 90s handshake budget while the child is
// alive; a throw here fails the case. Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { hostKeySeal } from '@byokit/secrets';
import { join, relative } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { cached } from '../../src/auth-store.ts';
import { Engine } from '../../src/engine.ts';
import { pidAlive } from '../../src/engine-status.ts';
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

test('a real title-rewriting gateway is recovered gracefully after its host is killed', { skip: process.platform !== 'linux', timeout: 600_000 }, async () => {
  const stateDir = scratchDir('real-orphan');
  const root = join(stateDir, 'openclaw');
  const marker = join(root, 'home', 'retained-canary');
  mkdirSync(join(root, 'home'), { recursive: true });
  writeFileSync(marker, 'retained-store');
  const kitModule = new URL('../../src/kit.ts', import.meta.url).href;
  const sealModule = import.meta.resolve('@byokit/secrets');
  const hostFile = join(stateDir, 'host.mjs');
  writeFileSync(hostFile, `
import { OpenClawKit } from ${JSON.stringify(kitModule)};
import { hostKeySeal } from ${JSON.stringify(sealModule)};
const kit = new OpenClawKit({ stateDir: ${JSON.stringify(stateDir)}, engineDir: ${JSON.stringify(engineDir)},
  authSeal: hostKeySeal({ key: new Uint8Array(32).fill(7) }), tools: [] });
await kit.start();
process.send('ready');
setInterval(() => {}, 1000);
`);
  const host = spawn(process.execPath, [hostFile], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  host.stderr!.on('data', chunk => { stderr += chunk; });
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [], authSeal: hostKeySeal({ key: new Uint8Array(32).fill(7) }) });
  let gateway = 0;
  try {
    const ready = await Promise.race([
      once(host, 'message'),
      once(host, 'exit').then(() => { throw new Error(`host exited before ready: ${stderr}`); }),
      delay(120_000, undefined, { ref: false }).then(() => { throw new Error('host never reached ready'); }),
    ]);
    assert.equal(ready[0], 'ready');
    gateway = Number(readFileSync(join(root, 'gateway.pid'), 'utf8'));
    assert.equal(readFileSync(`/proc/${gateway}/cmdline`, 'utf8').replaceAll('\0', '').trim(), 'openclaw-gateway', 'the pinned engine rewrote its original entry/arguments');
    const exited = once(host, 'exit');
    host.kill('SIGKILL');
    await exited;
    assert.equal(pidAlive(gateway), true, 'the detached real gateway survived its host');
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.equal(pidAlive(gateway), false, 'recovery witnessed the orphan exit');
    assert.notEqual(Number(readFileSync(join(root, 'gateway.pid'), 'utf8')), gateway);
    assert.match(readFileSync(join(stateDir, 'logs', 'openclaw.log'), 'utf8'), /SIGTERM/, 'the real engine handled graceful termination');
    assert.equal(readFileSync(marker, 'utf8'), 'retained-store');
    await kit.stop();
    // At rest only regenerable caches may remain under `home`; the sealed canary itself is gone.
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(root, 'state')), false);
    if (existsSync(join(root, 'home'))) {
      for (const entry of readdirSync(join(root, 'home'), { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
          const name = relative(join(root, 'home'), join(entry.parentPath, entry.name)).split('\\').join('/');
          assert.equal(cached(`home/${name}`) || name.split('/').slice(0, -1).some((_, i) => cached(`home/${name.split('/').slice(0, i + 1).join('/')}`)), true, `only caches stay at rest: ${name}`);
        }
      }
    }
    assert.equal(existsSync(join(root, 'gateway.pid')), false);
    assert.equal(existsSync(join(root, 'auth-store.lock')), false);
    assert.ok(existsSync(join(root, 'auth-store.sealed')));
  } finally {
    if (host.exitCode === null && host.signalCode === null) {
      const exited = once(host, 'exit'); host.kill('SIGKILL'); await exited;
    }
    // Capture only this fixture's launched pid, including a failure before the ready message.
    if (!gateway && existsSync(join(root, 'gateway.pid'))) gateway = Number(readFileSync(join(root, 'gateway.pid'), 'utf8'));
    if (gateway && pidAlive(gateway)) { try { process.kill(gateway, 'SIGTERM'); } catch {} }
    for (let i = 0; i < 30 && gateway && pidAlive(gateway); i++) await delay(100);
    if (gateway && pidAlive(gateway)) { try { process.kill(gateway, 'SIGKILL'); } catch {} }
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

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
