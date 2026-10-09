// Native approvals on the pinned engine (B7): with the approvals cap the kit's own operator connection is an
// approval client, so a raised exec approval arrives, attributes to the member, and resolves via decide.
// Runs only in the engine job (npm run test:engine), never in npm test.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { removeScratch, scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { readFileSync } from 'node:fs';
import { OpenClawKit } from '../../src/kit.ts';
import { gatewayTransport } from '../../src/transport.ts';

async function until(there: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 250) {
    if (there()) return;
    await delay(250);
  }
  throw new Error('the expected state never arrived');
}

test('a raised exec approval arrives, attributes, and resolves', { timeout: 360_000 }, async () => {
  const stateDir = scratchDir('engine-approvals');
  const kit = new OpenClawKit({ stateDir, engineDir: sharedEngineDir(), approvalTimeoutMs: 30_000 });
  try {
    try {
      await kit.start();
    } catch {
      // The gateway binds a couple of seconds after spawn (O4 connects once); a retry lands.
      await delay(15_000);
      await kit.start();
    }
    assert.equal(kit.state.phase, 'ready');
    await kit.ensureMember('alice');
    for (let i = 0; i < 20; i++) {
      try {
        await kit.call('health', {});
        break;
      } catch {
        await delay(2000);
      }
    }
    // Raised over a second operator connection, like a real run would: the engine broadcasts requested
    // events to approval-capable connections, and the kit must list, attribute and resolve them.
    const root = join(stateDir, 'openclaw');
    const second = gatewayTransport({
      port: Number(readFileSync(join(root, 'port'), 'utf8')),
      token: readFileSync(join(root, 'token'), 'utf8').trim(),
      identityPath: join(root, 'device.json'),
      bridgeSock: join(root, 'bridge.sock'),
    });
    await second.start();
    try {
      // The request blocks until the approval resolves, so it stays in flight while the kit decides.
      const pending = second.request('exec.approval.request', {
        id: 'engine-exec-1',
        command: 'echo engine',
        agentId: 'alice',
        sessionKey: 'agent:alice:engine:1',
      });
      await until(() => kit.approvals('alice').some((a) => a.id === 'engine-exec-1'));
      assert.equal(kit.approvals('alice')[0].source, 'exec');
      assert.match(kit.approvals('alice')[0].summary, /echo engine/);
      await kit.decide('engine-exec-1', { allow: false });
      const requested = await pending;
      assert.equal((requested as { decision: string }).decision, 'deny');
      await until(() => kit.approvals().length === 0);
    } finally {
      await second.stop();
    }
  } finally {
    await kit.stop();
    removeScratch(stateDir);
  }
});
