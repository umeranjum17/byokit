import assert from 'node:assert/strict';
import { WORKDIR_SHELL } from '../../packages/cloud/src/unit.ts';
import { machine } from '../../packages/cloud/src/machine.ts';
import { machineContract, type MachineBench } from '../../packages/cloud/src/testing/contract.ts';
import { memoryStore } from '../../packages/cloud/src/testing/fake-provider.ts';
import type { HostRecipe, MachineRef, Provider } from '../../packages/cloud/src/types.ts';
import { installApp, type AppRecipe } from './recipes.ts';

export const checks = [
  'contract', 'host-doctor', 'user-namespaces', 'disk-12gb', 'websocket', 'phone-pairing',
  'device-code', 'unit-resume', 'relay-resume', 'ip-change', 'route-rehost', 'noenv-scrub',
  'peak-memory-disk', 'clean-stop', 'forwarded-for', 'signin-resume', 'claimed-key',
  'trial-cap', 'plan-fields', 'raw-port', 'self-id',
] as const;
export type Check = typeof checks[number];
export type Result = { adapter: string; check: Check; status: 'pass' | 'fail' | 'observed' | 'unavailable'; detail: string };
// Measured durations the live run adds for the M6 comparison (create/resume to `on`, install,
// and a timed `/dev/kvm` presence probe). Dry runs leave `timings` absent.
export type Timing = { adapter: string; phase: 'create->on' | 'resume->on' | 'install' | 'kvm'; seconds: number; detail?: string };
export type Report = { date: string; mode: 'live' | 'dry-run'; complete: boolean; results: Result[]; timings?: Timing[] };
export type Session = { provider: Provider; ref: MachineRef; app: AppRecipe; url: string | null };
export type Observation = { status: Result['status']; detail: string };
export type ProofHooks = {
  // These app-specific checks need the app's phone, sign-in and workload surfaces.
  // Return measured evidence, not canned success. No keys or sign-in material in detail.
  address(session: Session): Promise<string>;
  observe(check: Check, session: Session): Promise<Observation>;
  // SSH VMs do not have sleep/wake. The app provides its lab-only console power cycle.
  cycleVm(session: Session): Promise<void>;
  // Destructive experiment on a separate disposable sandbox; never the app machine.
  noEnvScrub(provider: Provider, ref: MachineRef): Promise<Observation>;
};
// Tailnet ingress is plain HTTP inside the tailnet's WireGuard tunnel, on the app's own exposed port.
export const tailnetRoute = (name: string, port: number): string => `http://${name}:${port}`;
export type ProofTarget = {
  provider: Provider;
  app: AppRecipe;
  // Called before install: upload a clean release archive and lab-owned files only. Returns the
  // private https route (the MagicDNS origin) the probes dial, or null when the adapter has none.
  prepare(session: Session): Promise<string | null>;
  contractRecipe(name: string): HostRecipe;
  // Called with the install duration in seconds once `installApp` returns (live timings).
  onInstall?(seconds: number): void;
  // Disposable contract benches, independent stores; no owner production machines.
  bench(): Promise<MachineBench>;
  cleanupContract(): Promise<void>;
};

const opts = { timeoutMs: 120_000 };
async function exec(s: Session, argv: readonly string[], root = false): Promise<string> {
  const user = s.app.host.user;
  const home = s.app.host.workDir.slice(0, s.app.host.workDir.lastIndexOf('/'));
  const env = Object.entries(s.app.host.run.env).map(([k, v]) => `${k}=${v}`);
  const command = ['sh', '-c', WORKDIR_SHELL, 'sh', s.app.host.workDir, `${home}/.local/share/byokit/node/${s.app.host.node.version}/bin:/usr/local/bin:/usr/bin:/bin`, 'env', `HOME=${home}`, ...env, ...argv];
  const result = await s.provider.exec(s.ref, user && !root ? ['runuser', '-u', user, '--', ...command] : command, { ...opts, root: root || user !== undefined });
  assert.equal(result.timedOut, false, 'remote command timed out');
  assert.equal(result.code, 0, 'remote command failed');
  return result.stdout.trim();
}
export async function contract(target: ProofTarget): Promise<Observation> {
  const jobs: { name: string; run: (t: { skip(message?: string): void }) => void | Promise<void> }[] = [];
  machineContract(target.bench, { recipe: target.contractRecipe, test(name, run) { jobs.push({ name, run }); } });
  let passed = 0;
  let skipped = 0;
  try {
    for (const job of jobs) {
      let skip = false;
      await job.run({ skip() { skip = true; } });
      if (skip) skipped++;
      else passed++;
    }
    return { status: 'pass', detail: `${passed} contract cases passed; ${skipped} unsupported or fake-only cases skipped` };
  } finally {
    await target.cleanupContract();
  }
}

/** Records failures and continues so an incomplete proof cannot appear to qualify M6. */
export async function runProof(o: {
  targets: readonly ProofTarget[];
  hooks: ProofHooks;
  mode: Report['mode'];
  record(report: Report): Promise<void>;
}): Promise<Report> {
  const report: Report = { date: new Date().toISOString(), mode: o.mode, complete: false, results: [] };
  const add = async (adapter: string, check: Check, run: () => Promise<Observation>): Promise<void> => {
    let result: Observation;
    try { result = await run(); }
    catch { result = { status: 'fail', detail: 'check failed; inspect lab locally (raw error omitted to avoid recording credentials)' }; }
    report.results.push({ adapter, check, ...result });
    await o.record(report);
  };
  for (const target of o.targets) {
    const provider = target.provider;
    const adapter = provider.id;
    await add(adapter, 'contract', () => contract(target));
    const m = machine({ provider, store: memoryStore() });
    let session: Session | undefined;
    try {
      const ref = await m.create({ name: target.app.host.name, size: 'small', keepCopies: provider.create !== undefined });
      session = { provider, ref, app: target.app, url: null };
      session.url = await target.prepare(session);
      const installStarted = Date.now();
      await installApp(provider, ref, target.app);
      target.onInstall?.((Date.now() - installStarted) / 1000);
      assert.equal(await m.host(), 'running');
      // prepare() supplies the app's private tailnet route. Never expose a port here.
      const s = session;
      await add(adapter, 'host-doctor', async () => {
        await exec(s, target.app.doctor);
        await exec(s, target.app.health);
        return { status: 'pass', detail: 'app doctor and health check exited zero; unit running' };
      });
      await add(adapter, 'user-namespaces', async () => {
        await exec(s, ['unshare', '--user', '--map-root-user', 'true']);
        return { status: 'pass', detail: 'unprivileged user namespace creation succeeded' };
      });
      for (const check of ['disk-12gb', 'websocket', 'phone-pairing', 'device-code', 'peak-memory-disk', 'forwarded-for', 'claimed-key', 'trial-cap', 'plan-fields', 'raw-port', 'self-id'] as const) {
        await add(adapter, check, () => o.hooks.observe(check, s));
      }
      const beforeIp = await o.hooks.address(s);
      const oldUrl = s.url;
      if (provider.sleep && provider.wake) {
        await m.sleep();
        assert.equal(await m.state(), 'asleep');
        await m.wake();
      } else {
        await o.hooks.cycleVm(s);
      }
      if (provider.id === 'sandbox-api') {
        const tailnet = await m.tailnet();
        s.url = tailnet.name === null ? null : tailnetRoute(tailnet.name, s.app.exposure.port);
      }
      await add(adapter, 'unit-resume', async () => {
        assert.equal(await m.host(), 'running');
        return { status: 'pass', detail: 'enabled app unit running after power cycle' };
      });
      // Probe the private route after waking; the provider must not re-host it.
      await add(adapter, 'relay-resume', () => o.hooks.observe('relay-resume', s));
      await add(adapter, 'ip-change', async () => {
        const afterIp = await o.hooks.address(s);
        const v4 = /(?:\d{1,3}\.){3}\d{1,3}/.test(afterIp);
        return { status: 'observed', detail: `address changed: ${beforeIp !== afterIp}; IPv6-only: ${!v4 && afterIp.includes(':')}` };
      });
      // MagicDNS is stable; private ingress is configured by the app, not provider hosting.
      await add(adapter, 'route-rehost', async () => {
        const observed = await o.hooks.observe('route-rehost', s);
        return { ...observed, detail: `route changed: ${oldUrl !== s.url}; ${observed.detail}` };
      });
      await add(adapter, 'clean-stop', () => o.hooks.observe('clean-stop', s));
      await add(adapter, 'signin-resume', () => o.hooks.observe('signin-resume', s));
      await add(adapter, 'noenv-scrub', async () => {
        if (!provider.create || !provider.remove || !provider.sleep) return { status: 'unavailable', detail: 'SSH adapter has no provider environment or resume API' };
        const throwaway = await provider.create({ name: 'm6-scrub', size: 'small', keepCopies: true, idempotencyKey: crypto.randomUUID() });
        try { return await o.hooks.noEnvScrub(provider, throwaway); }
        finally { await provider.remove(throwaway, throwaway.id); }
      });
    } catch {
      // Fill every missing row: installation/cycle failures never silently omit checks.
    } finally {
      for (const check of checks) {
        if (!report.results.some(r => r.adapter === adapter && r.check === check)) {
          await add(adapter, check, async () => ({ status: 'fail', detail: 'not reached because setup or power cycle failed' }));
        }
      }
      // Keep the app lab machine for inspection; record only its id in the local app store.
      // Contract and scrub resources are separately cleaned even on failure.
      void session;
    }
  }
  report.complete = o.mode === 'live' && o.targets.length === 2 &&
    new Set(o.targets.map(t => t.provider.id)).size === 2 &&
    report.results.every(r => r.status === 'pass' ||
      (r.status === 'observed' && ['ip-change', 'noenv-scrub', 'peak-memory-disk', 'forwarded-for', 'claimed-key', 'trial-cap', 'plan-fields', 'raw-port', 'self-id'].includes(r.check)) ||
      (r.adapter === 'ssh-vm' && ['noenv-scrub', 'claimed-key', 'trial-cap', 'plan-fields'].includes(r.check) && r.status === 'unavailable'));
  await o.record(report);
  return report;
}

/** Report is provider-neutral and contains only app-reviewed evidence, never transport URLs/keys. */
export function markdown(report: Report): string {
  const cell = (s: string) => s.replace(/[\r\n|]/g, ' ').replace(/https?:\/\/\S+/g, '[address omitted]');
  const timings = report.timings === undefined || report.timings.length === 0
    ? ''
    : '\n### M6 measured timings (seconds)\n\n' +
      '| Adapter | Phase | Seconds | Evidence |\n|---|---|---|---|\n' +
      report.timings.map(t => `| ${cell(t.adapter)} | ${t.phase} | ${t.seconds.toFixed(1)} | ${cell(t.detail ?? '')} |`).join('\n') + '\n';
  return `\n### M6 recorded run — ${report.mode} — ${report.date}\n\n` +
    `Qualification: **${report.complete ? 'complete real proof' : 'NOT qualified'}**. Dry-run results describe fakes only.\n\n` +
    '| Adapter | Check | Result | Evidence |\n|---|---|---|---|\n' +
    report.results.map(r => `| ${cell(r.adapter)} | ${r.check} | ${r.status} | ${cell(r.detail)} |`).join('\n') + '\n' + timings;
}
