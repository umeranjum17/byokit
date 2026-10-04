import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fakeProvider, memoryStore } from '../packages/cloud/src/testing/fake-provider.ts';
import { machine } from '../packages/cloud/src/machine.ts';
import { startFakeSandboxServer } from '../packages/cloud/src/testing/fake-sandbox-server.ts';
import { boat } from '../packages/cloud/src/boat.ts';
import { probes } from './machine-proof/probes.ts';
import { dryRun, fakeNode } from './machine-proof/dry-run.ts';
import { checks, markdown, runProof } from './machine-proof/proof.ts';
import { crewhouseRecipe, muxrRecipe, studioRecipe, installApp, wrapper } from './machine-proof/recipes.ts';
import type { HostRecipe } from '../packages/cloud/src/types.ts';

const inputs = { home: '/home/user', node: fakeNode, archive: '/home/user/release.tgz', archiveSha256: 'a'.repeat(64) };
const runtime: HostRecipe = {
  name: 'muxr-runtime', user: 'muxrbot', node: fakeNode, workDir: '/home/user/.users/muxrbot/runtime',
  installRoot: [['install', '-d', '/home/user/.users/muxrbot/runtime']],
  install: [['true']], run: { argv: ['/home/user/.users/muxrbot/runtime/herdr', 'server'], env: { HERDR_SOCKET_PATH: '/home/user/.users/muxrbot/runtime/lab.sock' } },
};

test('M6 dry runner traverses both adapter contracts and records every check without qualification', async () => {
  let checkpoints = 0;
  const report = await dryRun(async () => { checkpoints++; });
  assert.equal(report.complete, false);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.results.length, checks.length * 2);
  assert.equal(report.results.filter(r => r.status === 'fail').length, 0, JSON.stringify(report.results));
  for (const adapter of ['sandbox-api', 'ssh-vm']) {
    assert.deepEqual(new Set(report.results.filter(r => r.adapter === adapter).map(r => r.check)), new Set(checks));
  }
  assert.ok(checkpoints > checks.length * 2);
  assert.match(markdown(report), /NOT qualified/);
});

for (const id of ['sandbox-api', 'ssh-vm'] as const) {
  for (const app of [crewhouseRecipe(inputs), muxrRecipe({ ...inputs, runtime }), studioRecipe(inputs)]) {
    test(`${id}: ${app.host.name} installs through M3, with scoped users and relay settings`, async () => {
      const provider = fakeProvider({ id });
      provider.fake.machine.script('apt-get', { code: 0, stdout: '', stderr: '', timedOut: false });
      const m = machine({ provider, store: memoryStore() });
      const ref = await m.create({ name: app.host.name, size: 'small', keepCopies: id !== 'ssh-vm' });
      await installApp(provider, ref, app);
      assert.equal(await m.host(), 'running');
      assert.equal(provider.fake.machine.units.size, app.prerequisites.length + 1);
      for (const recipe of [...app.prerequisites, app.host]) {
        const unit = provider.fake.machine.units.get(recipe.name)!;
        assert.match(unit.bytes, new RegExp(`User=${recipe.user}`));
        assert.match(unit.bytes, /Restart=always/);
        assert.equal(unit.enabled, true);
      }
      const enabled = provider.fake.machine.runs.filter(r => r.argv.includes('enable'));
      assert.equal(enabled.at(-1)?.argv.at(-1), `byokit-${app.host.name}.service`);
      assert.equal(app.exposure.trustProxy, false);
      for (const data of app.dataDirs) assert.ok(data.startsWith('/home/user/'));
      if (app.host.name !== 'studio') assert.match(app.host.install.at(-1)![2], /machine-wrapper/);
      assert.ok(!Object.keys(app.host.run.env).some(k => /KEY|TOKEN|SECRET|PASSWORD/.test(k)));
    });
  }
}

test('two-process wrapper forwards termination and exits when a child fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'm6-wrapper-'));
  const stopped = join(dir, 'stopped');
  const source = wrapper([
    { argv: ['node', '-e', `process.on('SIGTERM',()=>{require('node:fs').writeFileSync(${JSON.stringify(stopped)},'yes');process.exit(0)});setInterval(()=>{},1000)`], env: {} },
    { argv: ['node', '-e', 'setTimeout(()=>process.exit(7),500)'], env: {} },
  ]);
  const path = join(dir, 'wrapper.mjs');
  await writeFile(path, source);
  const child = spawn(process.execPath, [path], { env: {}, stdio: 'pipe', cwd: dir });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, 1);
    assert.equal(await readFile(stopped, 'utf8'), 'yes');
  } finally { clearTimeout(timer); child.kill(); await rm(dir, { recursive: true, force: true }); }
});

test('installation failure records missing checks and never qualifies a real report', async () => {
  const provider = fakeProvider();
  provider.fake.machine.sudo = false;
  const app = crewhouseRecipe(inputs);
  const target = {
    provider, app, prepare: async () => {}, contractRecipe: () => app.host,
    bench: async () => { throw new Error('fixture deliberately unavailable'); }, cleanupContract: async () => {},
  };
  const report = await runProof({ targets: [target], mode: 'live', record: async () => {}, hooks: {
    address: async () => '192.0.2.1',
    observe: async () => { throw new Error('must not be reached'); }, cycleVm: async () => {}, noEnvScrub: async () => { throw new Error('must not be reached'); },
  } });
  assert.equal(report.complete, false);
  assert.equal(report.results.length, checks.length);
  assert.ok(report.results.every(r => r.status === 'fail'));
});


test('scrub probe retries the trial TTL before interpreting a redundant noEnv rejection', async () => {
  const server = await startFakeSandboxServer({ trial: true });
  try {
    const provider = boat({ baseUrl: server.url, label: 'Fixture', prices: [], key: async () => 'test-key' });
    const ref = await provider.create!({ name: 'scrub', size: 'small', keepCopies: true, idempotencyKey: 'scrub-test' });
    const hooks = probes({ apiRoot: server.url, key: async () => 'test-key', vmRelayUrl: 'https://boat.test', publicAddress: async () => '192.0.2.1', ask: async () => { throw new Error('no operator during tests'); }, commands: {} });
    const result = await hooks.noEnvScrub(provider, ref);
    assert.equal(result.status, 'observed');
    assert.match(result.detail, /HTTP 400/);
    const resumes = server.requests.filter(r => r.path.endsWith('/resume'));
    assert.deepEqual(resumes.map(r => r.body), [{ ttlSeconds: null, noEnv: true }, { ttlSeconds: 7200, noEnv: true }]);
    assert.ok(!JSON.stringify(result).includes('test-key'));
  } finally { await server.close(); }
});


test('accepted scrub experiment polls readiness without a second normal resume concealing the result', async () => {
  const provider = fakeProvider();
  const ref = await provider.create!({ name: 'scrub', size: 'small', keepCopies: true, idempotencyKey: 'accepted-scrub' });
  let requests = 0;
  const hooks = probes({ apiRoot: 'https://boat.test/api/v1', key: async () => 'test-key', vmRelayUrl: 'https://boat.test', publicAddress: async () => '192.0.2.1', ask: async () => { throw new Error('no operator'); }, commands: {},
    fetch: (async () => { requests++; provider.fake.setState(ref.id, 'on'); return new Response('{}', { status: 200 }); }) as typeof fetch,
  });
  const result = await hooks.noEnvScrub(provider, ref);
  assert.equal(result.status, 'observed');
  assert.match(result.detail, /canary survives: true/);
  assert.equal(requests, 1);
  assert.equal(provider.fake.calls.filter(c => c.op === 'wake').length, 0);
});
