import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeSandboxServer } from '../../packages/cloud/src/testing/fake-sandbox-server.ts';
import { setupFakeSsh } from '../../packages/cloud/src/testing/fake-ssh.ts';
import { boat } from '../../packages/cloud/src/boat.ts';
import { sshVm, sshHostKey } from '../../packages/cloud/src/ssh.ts';
import { memoryStore } from '../../packages/cloud/src/testing/fake-provider.ts';
import { crewhouseRecipe } from './recipes.ts';
import { runProof, type Report, type ProofTarget } from './proof.ts';
import type { HostRecipe, Price } from '../../packages/cloud/src/types.ts';

export const fakeNode: HostRecipe['node'] = {
  version: '24.15.0', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) },
};
const fakePrice: Price = { size: 'small', perHour: 0.018, asleepPerHour: 0, currency: 'USD', basis: 'fixture', source: 'http://boat.test/prices', checked: '2026-09-29' };
export async function dryRun(record: (r: Report) => Promise<void>): Promise<Report> {
  const dir = await mkdtemp(join(tmpdir(), 'm6-'));
  const server = await startFakeSandboxServer();
  const ssh = setupFakeSsh(join(dir, 'ssh'));
  try {
    const keyPath = join(dir, 'id');
    await writeFile(keyPath, 'fake-private-key');
    const scanned = await sshHostKey({ ssh: ssh.ssh, host: ssh.host, stateDir: join(dir, 'state') });
    await scanned.confirm();
    const sandbox = boat({ baseUrl: server.url, label: 'Fixture', prices: [fakePrice], key: async () => 'test-key' });
    const vm = sshVm({ ssh: ssh.ssh, host: ssh.host, user: 'user', keyPath, stateDir: join(dir, 'state'), label: 'Fixture', monthly: { ...fakePrice, perMonthCap: 6 } });
    const app = crewhouseRecipe({ home: '/home/user', node: fakeNode, archive: '/home/user/release.tgz', archiveSha256: 'a'.repeat(64) });
    const success = { code: 0, stdout: '', stderr: '', timedOut: false };
    for (const command of ['unshare', 'curl', 'apt-get']) { server.machine.script(command, success); ssh.script(command, success); }
    server.machine.script('hostname', { ...success, stdout: '192.0.2.1\n' });
    ssh.script('hostname', { ...success, stdout: '192.0.2.2\n' });
    const wake = sandbox.wake!;
    sandbox.wake = async ref => { await wake(ref); server.machine.reboot(); };
    const targets: ProofTarget[] = [sandbox, vm].map(provider => ({
      provider, app, prepare: async () => {},
      contractRecipe: name => ({ name, node: fakeNode, workDir: '/home/user/app', install: [['npm', 'ci']], run: { argv: ['node', 'server.mjs'], env: { PORT: '7310' } } }),
      bench: async () => ({ provider, store: memoryStore(), installs: true }),
      cleanupContract: async () => {},
    }));
    return await runProof({ targets, mode: 'dry-run', record, hooks: {
      address: async () => '192.0.2.1',
      observe: async check => ({ status: 'pass', detail: `SIMULATED app observation: ${check}; no real phone, account or workload` }),
      cycleVm: async () => { const m = ssh.readMachine(); m.reboot(); ssh.writeMachine(m); },
      noEnvScrub: async (provider, ref) => {
        await provider.sleep!(ref);
        const response = await fetch(`${server.url}/sandboxes/${ref.id}/resume`, { method: 'POST', headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' }, body: JSON.stringify({ ttlSeconds: null, noEnv: true }) });
        if (response.status !== 400) throw new Error('fake must reject redundant noEnv');
        return { status: 'observed', detail: 'SIMULATED API rejects redundant noEnv with HTTP 400' };
      },
    } });
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}
