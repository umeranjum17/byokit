// Explicitly invoked lab code; never imported by library entries or run by CI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { boat } from '../../packages/cloud/src/boat.ts';
import { sshVm, sshHostKey, type SshVmOptions } from '../../packages/cloud/src/ssh.ts';
import { memoryStore } from '../../packages/cloud/src/testing/fake-provider.ts';
import type { HostRecipe, MachineRef, Price, Provider } from '../../packages/cloud/src/types.ts';
import type { AppRecipe } from './recipes.ts';
import { runProof, type ProofHooks, type ProofTarget, type Report, type Session } from './proof.ts';

export type LiveConfig = {
  providerUrl: string; providerLabel: string; apiKeyFile: string; prices: readonly Price[];
  vm: SshVmOptions & { fingerprint: string; home: string };
  sandboxHome: string; node: HostRecipe['node'];
  sandboxApp: AppRecipe; vmApp: AppRecipe;
  // App release files only, staged on these two dedicated disposable lab machines.
  prepare(session: Session): Promise<void>;
  hooks: ProofHooks;
  // Saves created resource ids immediately, before any installation, for cleanup after interruption.
  resourcesFile: string;
};

function track(provider: Provider, refs: MachineRef[], save: (ref: MachineRef) => Promise<void>): Provider {
  const p = { ...provider };
  if (provider.create) p.create = async opts => {
    const ref = await provider.create!(opts);
    refs.push(ref); await save(ref);
    const deadline = Date.now() + 300_000;
    while (await provider.status(ref) !== 'on') {
      assert.ok(Date.now() < deadline, 'lab machine did not become ready within five minutes');
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return ref;
  };
  return p;
}
export async function liveRun(config: LiveConfig, record: (r: Report) => Promise<void>): Promise<Report> {
  assert.equal(new URL(config.providerUrl).protocol, 'https:', 'live provider URL must use HTTPS');
  const key = (await readFile(config.apiKeyFile, 'utf8')).trim();
  assert.ok(key, 'app-passed key is empty');
  const fingerprint = await sshHostKey(config.vm);
  assert.equal(fingerprint.fingerprint, config.vm.fingerprint, 'SSH fingerprint differs from the app-verified fingerprint');
  await fingerprint.confirm();
  const rawSandbox = boat({ baseUrl: config.providerUrl, label: config.providerLabel, prices: config.prices, key: async () => key });
  const vm = sshVm(config.vm);
  let resources: { adapter: string; id: string; name: string }[] = [];
  try { resources = JSON.parse(await readFile(config.resourcesFile, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  assert.ok(Array.isArray(resources), 'resource journal must be an array');
  const sandbox = track(rawSandbox, [], async ref => {
    resources.push({ adapter: rawSandbox.id, id: ref.id, name: ref.name });
    await writeFile(config.resourcesFile, JSON.stringify(resources, null, 2), { mode: 0o600 });
  });
  const saveResource = async (s: Session) => {
    resources.push({ adapter: s.provider.id, id: s.ref.id, name: s.ref.name });
    await writeFile(config.resourcesFile, JSON.stringify(resources, null, 2), { mode: 0o600 });
  };
  const targets: ProofTarget[] = [];
  for (const [provider, home, app] of [[sandbox, config.sandboxHome, config.sandboxApp], [vm, config.vm.home, config.vmApp]] as const) {
    const refs: MachineRef[] = [];
    const contractProvider = track(provider, refs, async () => {});
    const fixtureDir = `${home}/app`;
    // Real contract installs a harmless Node fixture, rather than the fake's nonexistent package.
    const fixture: HostRecipe = {
      name: 'web', node: config.node, workDir: fixtureDir,
      install: [['node', '-e', "require('node:fs').writeFileSync('server.mjs','setInterval(() => {}, 60000)')"]],
      run: { argv: ['node', `${fixtureDir}/server.mjs`], env: { PORT: '7310' } },
    };
    targets.push({
      provider, app,
      prepare: async s => { await saveResource(s); await config.prepare(s); },
      contractRecipe: name => ({ ...fixture, name }),
      bench: async () => ({ provider: contractProvider, store: memoryStore(), installs: true }),
      cleanupContract: async () => {
        if (provider.remove) {
          for (const ref of refs) await provider.remove(ref, ref.id);
          refs.length = 0;
        } else {
          // The VM is explicitly lab-only; stop/remove only the contract's own fixture unit.
          const ref = { provider: provider.id, account: await provider.account(), id: await provider.adopt!(), name: 'web', keepCopies: false };
          for (const argv of [['systemctl', '--user', 'disable', '--now', 'byokit-web.service'], ['rm', '-f', `${home}/.config/systemd/user/byokit-web.service`], ['systemctl', '--user', 'daemon-reload']]) {
            const result = await provider.exec(ref, argv, { timeoutMs: 30_000 });
            assert.equal(result.code, 0, 'contract VM cleanup failed');
          }
        }
      },
    });
  }
  // Never print provider errors, transport addresses, keys or model credentials.
  return runProof({ targets, hooks: config.hooks, mode: 'live', record: async report => {
    for (const result of report.results) result.detail = result.detail.split(key).join('[redacted]');
    await record(report);
  } });
}
