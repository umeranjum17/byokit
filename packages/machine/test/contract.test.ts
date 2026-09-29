// M1 acceptance: contract.test.ts runs machineContract against fakeProvider() with
// installs: false (cases 1-4, 6, 9-12, 15, 16 and 20 pass).
// M4 adds the sandbox bench: machineContract against sandboxApi over the loopback fake
// server, with installs off until M3 merges (the later of M3 and M4 turns it on).
// Fixtures use http://sandbox.test, mapped to the loopback port through fetch (D-2).
import { after } from 'node:test';
import { fakeProvider, memoryStore } from '../src/testing/fake-provider.ts';
import { machineContract, type MachineBench } from '../src/testing/contract.ts';
import { sandboxApi } from '../src/sandbox-api.ts';
import { startFakeSandboxServer, type SandboxServer } from '../src/testing/fake-sandbox-server.ts';

machineContract(async (): Promise<MachineBench> => {
  const f = fakeProvider();
  return { provider: f, store: memoryStore(), fake: f.fake, installs: false };
});

let sandbox: SandboxServer | null = null;
after(async () => {
  await sandbox?.close();
});

machineContract(async (): Promise<MachineBench> => {
  sandbox ??= await startFakeSandboxServer();
  const port = new URL(sandbox.url).port;
  const provider = sandboxApi({
    baseUrl: 'http://sandbox.test/api/v1',
    label: 'Test',
    prices: [{
      size: 'small', perHour: 0.018, planFloorPerMonth: 20, asleepPerHour: 0,
      currency: 'USD', basis: 'incl. IPv4, excl. VAT', source: 'http://sandbox.test/prices', checked: '2026-09-29',
    }],
    key: async () => 'test-key',
    fetch: ((url: unknown, init: unknown) =>
      fetch(String(url).replace('http://sandbox.test', `http://127.0.0.1:${port}`), init as RequestInit)) as typeof fetch,
  });
  return { provider, store: memoryStore(), installs: false };
});
