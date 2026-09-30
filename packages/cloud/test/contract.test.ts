// M3 turns installs on: all 20 contract cases pass on fakeProvider(), and on the
// sandbox and SSH benches every non-*fake* case passes or skips for a missing
// method (the later of M3 and M4 turns the sandbox bench on; M3 is later).
// Fixtures use http://sandbox.test, mapped to the loopback port through fetch (D-2).
// The SSH VM bench runs the same contract against sshVm with the fake `ssh`.
// Case 1 creates by adoption after confirm().
import { after } from 'node:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { fakeProvider, memoryStore } from '../src/testing/fake-provider.ts';
import { machineContract, type MachineBench } from '../src/testing/contract.ts';
import type { Price } from '../src/types.ts';
import { sshVm, sshHostKey } from '../src/ssh.ts';
import { setupFakeSsh } from '../src/testing/fake-ssh.ts';
import { sandboxApi } from '../src/sandbox-api.ts';
import { startFakeSandboxServer, type SandboxServer } from '../src/testing/fake-sandbox-server.ts';

machineContract(async (): Promise<MachineBench> => {
  const f = fakeProvider();
  return { provider: f, store: memoryStore(), fake: f.fake, installs: true };
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
  return { provider, store: memoryStore(), installs: true };
});

const benchSsh = setupFakeSsh(scratchDir('fake-ssh-contract'));

machineContract(async (): Promise<MachineBench> => {
  const root = scratchDir('ssh-bench');
  const stateDir = join(root, 'state');
  const keyPath = join(root, 'id_ed25519');
  writeFileSync(keyPath, 'fake-private-key\n');
  const scanned = await sshHostKey({ ssh: benchSsh.ssh, host: benchSsh.host, port: 2222, stateDir });
  await scanned.confirm();
  const monthly: Price = {
    size: 'vm',
    perMonthCap: 6,
    asleepPerHour: 6,
    currency: 'EUR',
    basis: 'incl. IPv4, excl. VAT',
    source: 'http://sandbox.test/prices',
    checked: new Date().toISOString().slice(0, 10),
  };
  const provider = sshVm({
    ssh: benchSsh.ssh,
    host: benchSsh.host,
    port: 2222,
    user: 'app',
    keyPath,
    stateDir,
    label: 'Fake VM',
    monthly,
  });
  return { provider, store: memoryStore(), installs: true };
});
