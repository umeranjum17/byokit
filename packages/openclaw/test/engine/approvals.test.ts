// Native approvals on the pinned engine (B7): with the approvals cap the kit's own operator connection is an
// approval client, so a raised exec approval arrives, attributes to the member, and resolves via decide.
// Runs only in the engine job (npm run test:engine), never in npm test.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit } from '../../src/kit.ts';

async function until(there: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 250) {
    if (there()) return;
    await delay(250);
  }
  throw new Error('the expected state never arrived');
}

test('a raised exec approval arrives, attributes, and resolves', { timeout: 360_000 }, async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o5-'));
  const kit = new OpenClawKit({ stateDir, approvalTimeoutMs: 30_000 });
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
    const requested = await kit.call('exec.approval.request', {
      id: 'engine-exec-1',
      command: 'echo engine',
      agentId: 'alice',
      sessionKey: 'agent:alice:engine:1',
    });
    assert.equal((requested as { id: string }).id, 'engine-exec-1');
    await until(() => kit.approvals('alice').some((a) => a.id === 'engine-exec-1'));
    assert.equal(kit.approvals('alice')[0].source, 'exec');
    await kit.decide('engine-exec-1', { allow: false });
    await until(() => kit.approvals().length === 0);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
