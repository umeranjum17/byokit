// Explicitly invoked lab code; never imported by library entries or run by CI.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { boat } from '../../packages/cloud/src/boat.ts';
import { sshVm, sshHostKey, type SshVmOptions } from '../../packages/cloud/src/ssh.ts';
import { joinTailnet } from '../../packages/cloud/src/tailnet.ts';
import { memoryStore } from '../../packages/cloud/src/testing/fake-provider.ts';
import type { HostRecipe, MachineRef, Price, Provider } from '../../packages/cloud/src/types.ts';
import type { AppRecipe } from './recipes.ts';
import { runProof, type ProofHooks, type ProofTarget, type Report, type Session, type Timing } from './proof.ts';

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

function track(
  provider: Provider,
  refs: MachineRef[],
  save: (ref: MachineRef) => Promise<void>,
): Provider {
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
  // M6 comparison timings (scout report §6 step 4): create->on, resume->on, install duration and
  // a timed /dev/kvm probe. Recorded per adapter; never a transport URL or key.
  const timings: Timing[] = [];
  const at = (adapter: string, phase: Timing['phase'], seconds: number, detail?: string): void => {
    timings.push({ adapter, phase, seconds, ...(detail === undefined ? {} : { detail }) });
  };
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
    // Time resume->on by wrapping the app provider's wake (the VM uses the console power cycle).
    const timed: Provider = { ...provider };
    let appCreateStarted: number | undefined;
    if (provider.create !== undefined) {
      const create = provider.create;
      timed.create = async opts => {
        appCreateStarted = Date.now();
        return create(opts);
      };
    }
    if (provider.wake !== undefined) {
      const wake = provider.wake;
      timed.wake = async ref => {
        const started = Date.now();
        await wake(ref);
        at(provider.id, 'resume->on', (Date.now() - started) / 1000);
      };
    }
    const fixtureDir = `${home}/app`;
    // Real contract installs a harmless Node fixture, rather than the fake's nonexistent package.
    const fixture: HostRecipe = {
      name: 'web', node: config.node, workDir: fixtureDir,
      install: [['node', '-e', "require('node:fs').writeFileSync('server.mjs','setInterval(() => {}, 60000)')"]],
      run: { argv: ['node', `${fixtureDir}/server.mjs`], env: { PORT: '7310' } },
    };
    targets.push({
      provider: timed, app,
      prepare: async s => {
        await saveResource(s);
        if (appCreateStarted !== undefined) {
          at(provider.id, 'create->on', (Date.now() - appCreateStarted) / 1000);
          const kvmStarted = Date.now();
          let present = false;
          try {
            present = (await rawSandbox.exec(s.ref, ['sh', '-c', '[ -c /dev/kvm ]'], { timeoutMs: 30_000 })).code === 0;
          } catch {
            present = false;
          }
          at(provider.id, 'kvm', (Date.now() - kvmStarted) / 1000, present ? 'present' : 'absent');
          appCreateStarted = undefined;
        }
        await config.prepare(s);
        if (provider.id !== 'sandbox-api') return null;
        const joined = await joinTailnet(provider, s.ref, { hostname: s.app.host.name }, step => {
          if (step.step === 'open-page') console.error(`Sign in ${s.app.host.name} on your phone: ${step.url}`);
        });
        return `https://${joined.name}`;
      },
      onInstall: seconds => at(provider.id, 'install', seconds),
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
    report.timings = [...timings].sort((a, b) => a.adapter.localeCompare(b.adapter) || a.phase.localeCompare(b.phase));
    await record(report);
  } });
}
