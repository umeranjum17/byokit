// O11: the contract suite against the real pinned engine with the scripted model stub.
// Runs only in the engine job (npm run test:engine), never in npm test: it installs the pin (network)
// and boots a gateway per case. The device-code happy path needs a person at the device URL, so the
// engine job skips it with the reason and proves sign-in live instead (the O11 fan-out lab).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { scratchDir } from '../../../test-support.ts';
import { startModelStub, useModelStub, type ModelStub } from '../../src/testing/model-stub.ts';
import { openclawContract, type ContractFixture } from '../../src/testing/contract.ts';

const NOTE = { name: 'note', description: 'a test tool the host answers', parameters: { type: 'object' } };

const install = scratchDir('o11-engine-contract');
const engineDir = join(install, 'engine');
let stub: ModelStub;

before(async () => {
  // Install the pin once; every case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
  stub = await startModelStub();
}, { timeout: 600_000 });

after(async () => {
  await stub?.close();
});

async function make(): Promise<ContractFixture> {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o11-engine-'));
  const kit = new OpenClawKit({
    stateDir,
    engineDir,
    approvalTimeoutMs: 30_000,
    tools: [NOTE],
    host: {
      gate: async (_run, _tool, input) => {
        const mode = (input as { mode?: string }).mode;
        if (mode === 'ask') return { ask: { summary: `note ${String((input as { text?: string }).text ?? '')}` } };
        if (mode === 'deny') return { allow: false, reason: 'denied by the test host' };
        return { allow: true };
      },
      call: async (_run, _tool, input) => `note: ${String((input as { text?: string }).text ?? '')}`,
    },
  });
  // No manual port poll: the transport rides out gateway boot (O11 ECONNREFUSED fix); a throw here fails the case.
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  await useModelStub(kit, stub);
  // A second operator connection for the native-approval case (the O5 approvals.test.ts pattern).
  const root = join(stateDir, 'openclaw');
  const peerTransport = gatewayTransport({ port: Number(readFileSync(join(root, 'port'), 'utf8')),
    token: readFileSync(join(root, 'token'), 'utf8').trim(),
    identityPath: join(root, 'device.json'), bridgeSock: join(root, 'bridge.sock') });
  await peerTransport.start();
  const stop = kit.stop.bind(kit);
  kit.stop = async () => {
    try { await stop(); } finally { await peerTransport.stop().catch(() => {}); rmSync(stateDir, { recursive: true, force: true }); }
  };
  return { kit, model: stub, peer: { request: peerTransport.request } };
}

openclawContract(make, { skipDeviceCode: 'needs a person at the device URL' });

// The O3 config-restart case the O5 probe named: members created before a restart are persisted agents
// afterwards — ensureMember finds them (no duplicate create, no map-as-array crash) on the same state dir.
test('config-restart: persisted agents are found, not duplicated (O3)', { timeout: 600_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o11-restart-'));
  const opts = { stateDir, engineDir, approvalTimeoutMs: 30_000, onState: () => {} };
  const first = new OpenClawKit(opts);
  try {
    await first.start();
    assert.equal(first.state.phase, 'ready');
    await first.ensureMember('kept');
    const created = (await first.call('agents.list', {}) as { agents: { id: string }[] }).agents.map((a) => a.id);
    assert.ok(created.includes('kept'));
  } finally {
    await first.stop();
  }
  const second = new OpenClawKit(opts);
  try {
    await second.start();
    assert.equal(second.state.phase, 'ready');
    const ensured = await second.ensureMember('kept');
    assert.equal(ensured.agentId, 'kept');
    const list = await second.call('agents.list', {}) as { agents: unknown };
    assert.ok(Array.isArray(list.agents), `persisted agents.list is not an array: ${JSON.stringify(list.agents).slice(0, 200)}`);
    assert.equal(list.agents.filter((a) => (a as { id: string }).id === 'kept').length, 1);
  } finally {
    await second.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
