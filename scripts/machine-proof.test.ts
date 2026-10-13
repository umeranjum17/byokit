import { test } from 'node:test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Socket, type AddressInfo } from 'node:net';
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
import { fakeNode } from './machine-proof/dry-run.ts';
import { checks, runProof } from './machine-proof/proof.ts';
import { crewhouseRecipe, muxrRecipe, studioRecipe, installApp, wrapper } from './machine-proof/recipes.ts';
import type { HostRecipe } from '../packages/cloud/src/types.ts';

const inputs = { home: '/home/user', node: fakeNode, archive: '/home/user/release.tgz', archiveSha256: 'a'.repeat(64) };
const runtime: HostRecipe = {
  name: 'muxr-runtime', user: 'muxrbot', node: fakeNode, workDir: '/home/user/.users/muxrbot/runtime',
  installRoot: [['install', '-d', '/home/user/.users/muxrbot/runtime']],
  install: [['true']], run: { argv: ['/home/user/.users/muxrbot/runtime/herdr', 'server'], env: { HERDR_SOCKET_PATH: '/home/user/.users/muxrbot/runtime/lab.sock' } },
};

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

test('raw-port probe accepts refusal or a timeout and rejects a connection (loopback/forced-timer controls, not live provider proof)', async t => {
  const listener = createServer((_q, r) => r.end('Umer lab listener'));
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const open = (listener.address() as AddressInfo).port;
  const closedServer = createServer();
  await new Promise<void>(resolve => closedServer.listen(0, '127.0.0.1', resolve));
  const closed = (closedServer.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => closedServer.close(e => e ? reject(e) : resolve()));
  const provider = fakeProvider();
  const ref = await provider.create!({ name: 'web', size: 'small', keepCopies: false, idempotencyKey: 'private-port' });
  const probeAt = (port: number) => {
    const app = { ...studioRecipe(inputs), exposure: { ...studioRecipe(inputs).exposure, port } };
    return probes({ apiRoot: 'https://boat.test', key: async () => 'test-key', vmRelayUrl: 'https://boat.test',
      publicAddress: async () => '127.0.0.1', ask: async () => '', commands: {} }).observe('raw-port', { provider, ref, app, url: null });
  };
  try {
    assert.equal(await (await fetch(`http://127.0.0.1:${open}`)).text(), 'Umer lab listener');
    provider.fake.machine.script('curl', { code: 0, stdout: 'Umer lab listener', stderr: '', timedOut: false });
    const refused = await probeAt(closed);
    assert.equal(refused.status, 'pass');
    assert.match(refused.detail, /refused \(ECONNREFUSED\)/);
    const exposed = await probeAt(open);
    assert.equal(exposed.status, 'fail');
    assert.match(exposed.detail, /accepted/);
    // Force only this probe's owned socket deadline; do not change host networking or claim a provider drop.
    const deadline = t.mock.method(Socket.prototype, 'setTimeout', function (this: Socket, ms: number, callback?: () => void) {
      assert.equal(ms, 10_000);
      queueMicrotask(() => callback?.call(this));
      return this;
    });
    try {
      const dropped = await probeAt(open);
      assert.equal(dropped.status, 'pass');
      assert.match(dropped.detail, /dropped \(timeout\)/);
    } finally { deadline.mock.restore(); }
    provider.fake.machine.script('curl', { code: 7, stdout: '', stderr: 'no listener', timedOut: false });
    await assert.rejects(probeAt(closed), /listener must answer locally/);
  } finally {
    listener.closeAllConnections();
    await new Promise<void>((resolve, reject) => listener.close(e => e ? reject(e) : resolve()));
  }
});

test('websocket probe dials the private tailnet route on the app port over plain ws (checks the probe; the live proof checks the tailnet)', async () => {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/relay/v1/host' });
  const paths: string[] = [];
  wss.on('connection', (_socket, request) => { paths.push(request.url ?? ''); });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  const provider = fakeProvider();
  const ref = await provider.create!({ name: 'web', size: 'small', keepCopies: false, idempotencyKey: 'ws-route' });
  const app = { ...studioRecipe(inputs), exposure: { ...studioRecipe(inputs).exposure, port } };
  const hooks = probes({ apiRoot: 'https://boat.test', key: async () => 'test-key', vmRelayUrl: 'https://boat.test',
    publicAddress: async () => '127.0.0.1', ask: async () => '', commands: {} });
  try {
    const result = await hooks.observe('websocket', { provider, ref, app, url: `http://127.0.0.1:${port}` });
    assert.equal(result.status, 'pass');
    assert.deepEqual(paths, ['/relay/v1/host']);
  } finally {
    wss.close();
    await new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve()));
  }
});

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
    provider, app, prepare: async () => null, contractRecipe: () => app.host,
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
