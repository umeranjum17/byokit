// O11 generated-surface proof: every offer:true route starts with only its plugin allowed,
// and native approval requests carry the requesting member. Runs only in the engine job
// (npm run test:engine), never in npm test: the cases boot gateways.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { gatewayTransport } from '../../src/transport.ts';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';
import routes from '../../src/routes.json' with { type: 'json' };

const install = scratchDir('o11-engine-generated');
const engineDir = sharedEngineDir() ?? join(install, 'engine');

before(async () => {
  // Install the pin once; every case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
}, { timeout: 600_000 });

async function until(there: () => boolean, ms = 120_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 250) {
    if (there()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('the expected state never arrived');
}

test('every offer:true route starts with only its plugin allowed', { timeout: 600_000 }, async () => {
  const offered = (routes as { choice: string; plugin: string; offer: boolean }[]).filter((r) => r.offer);
  assert.ok(offered.length > 0, 'routes.json offers nothing');
  for (const route of offered) {
    const stateDir = scratchDir('o11-offer');
    const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 10_000,
      config: { plugins: { allow: [route.plugin] } } });
    try {
      await kit.start();
      assert.equal(kit.state.phase, 'ready', `${route.choice} did not start`);
      const saved = JSON.parse(readFileSync(join(stateDir, 'openclaw', 'openclaw.json'), 'utf8'));
      assert.ok((saved.plugins?.allow ?? []).includes(route.plugin), `${route.choice} lost its plugin: ${JSON.stringify(saved.plugins?.allow)}`);
    } finally {
      await kit.stop().catch(() => {});
      rmSync(stateDir, { recursive: true, force: true });
    }
  }
});

test('plugin approval requests carry the requesting member', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o11-plugappr');
  const kit = new OpenClawKit({ stateDir, engineDir, tools: [], approvalTimeoutMs: 30_000 });
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await kit.ensureMember('m1');
    const root = join(stateDir, 'openclaw');
    const peer = gatewayTransport({ port: Number(readFileSync(join(root, 'port'), 'utf8')),
      token: readFileSync(join(root, 'token'), 'utf8').trim(),
      identityPath: join(root, 'device.json'), bridgeSock: join(root, 'bridge.sock') });
    await peer.start();
    try {
      // The engine holds the request open until the approval resolves, so it stays in flight; unlike the
      // fake's old shape the engine requires title+description and mints the id itself.
      const pending = peer.request('plugin.approval.request', { title: 'install x',
        description: 'contract plugin approval', agentId: 'm1', sessionKey: 'agent:m1:o11:plugin:1' });
      // The approval must attribute while the request is still in flight.
      let seen;
      for (let waited = 0; ; waited += 250) {
        seen = kit.approvals('m1').find((a) => a.source === 'plugin');
        if (seen || waited >= 120_000) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(seen, 'no plugin approval arrived');
      assert.equal(seen.member, 'm1');
      assert.match(seen.summary, /install x/);
      await kit.decide(seen.id, { allow: true });
      const requested = await pending as { id?: string };
      assert.equal(requested?.id, seen.id);
      await until(() => kit.approvals().length === 0);
    } finally {
      await peer.stop().catch(() => {});
    }
  } finally {
    await kit.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});
