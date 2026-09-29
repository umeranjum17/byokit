// O11: the contract suite against fakeGateway — runs in `npm test` (offline, no engine).
// The same cases run against the real pinned engine in test/engine/contract.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import { openclawContract, type ContractFixture } from '../src/testing/contract.ts';

const NOTE = { name: 'note', description: 'a test tool the host answers', parameters: { type: 'object' } };

async function make(): Promise<ContractFixture> {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o11-fake-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({
    stateDir,
    transport: fake.factory,
    spawnEngine: false,
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
  await kit.start();
  const stop = kit.stop.bind(kit);
  kit.stop = async () => {
    try { await stop(); } finally { rmSync(stateDir, { recursive: true, force: true }); }
  };
  return { kit };
}

openclawContract(make);
