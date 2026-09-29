// The transport reads both device.json shapes: the kit's `{ privateKey, publicKey }` and the
// Crewhouse legacy `{ deviceId, publicKeyPem, privateKeyPem }`. An existing file is only read,
// never rewritten, and anything else fails naming the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Engine } from '../src/engine.ts';
import { gatewayTransport, loadDeviceKeys } from '../src/transport.ts';

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }) as string,
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }) as string,
  };
}

test('legacy Crewhouse device.json starts the transport without touching the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-transport-'));
  try {
    const keys = keyPair();
    const path = join(dir, 'device.json');
    const before = JSON.stringify({ deviceId: 'x', publicKeyPem: keys.publicKeyPem, privateKeyPem: keys.privateKeyPem });
    writeFileSync(path, before, { mode: 0o600 });
    const transport = gatewayTransport({ port: 1, token: 'test', identityPath: path, bridgeSock: '' });
    try {
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally {
      await transport.stop();
    }
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kit device.json still starts the transport without touching the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-transport-'));
  try {
    const keys = keyPair();
    const path = join(dir, 'device.json');
    const before = JSON.stringify({ privateKey: keys.privateKeyPem, publicKey: keys.publicKeyPem });
    writeFileSync(path, before, { mode: 0o600 });
    const transport = gatewayTransport({ port: 1, token: 'test', identityPath: path, bridgeSock: '' });
    try {
      assert.equal(readFileSync(path, 'utf8'), before);
    } finally {
      await transport.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDeviceKeys maps both shapes to the same key pair', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-transport-'));
  try {
    const keys = keyPair();
    const legacy = join(dir, 'legacy.json');
    const kit = join(dir, 'kit.json');
    writeFileSync(legacy, JSON.stringify({ deviceId: 'x', publicKeyPem: keys.publicKeyPem, privateKeyPem: keys.privateKeyPem }));
    writeFileSync(kit, JSON.stringify({ privateKey: keys.privateKeyPem, publicKey: keys.publicKeyPem }));
    assert.deepEqual(loadDeviceKeys(legacy), keys);
    assert.deepEqual(loadDeviceKeys(kit), keys);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a device.json with neither shape fails naming the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-transport-'));
  try {
    const path = join(dir, 'device.json');
    writeFileSync(path, JSON.stringify({ deviceId: 'x' }));
    assert.throws(() => gatewayTransport({ port: 1, token: 'test', identityPath: path, bridgeSock: '' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.doesNotMatch(error.message, /undefined/);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Engine.start keeps a legacy device.json byte-for-byte', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-transport-'));
  try {
    const keys = keyPair();
    const root = join(dir, 'openclaw');
    mkdirSync(root, { recursive: true });
    const before = JSON.stringify({ deviceId: 'x', publicKeyPem: keys.publicKeyPem, privateKeyPem: keys.privateKeyPem });
    writeFileSync(join(root, 'device.json'), before, { mode: 0o600 });
    const engine = new Engine({ stateDir: dir, pluginId: 'byokit', tools: [], spawnEngine: false, onState() {}, onExit() {} });
    const ctx = await engine.start();
    try {
      assert.equal(ctx.identityPath, join(root, 'device.json'));
      assert.equal(readFileSync(join(root, 'device.json'), 'utf8'), before);
    } finally {
      await engine.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
