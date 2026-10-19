import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { scratchDir } from '../../test-support.ts';
import { hetzner, type HetznerOptions } from '@byokit/cloud/hetzner';
import { hetznerApi, installScript, machine, setupCommand } from '@byokit/cloud';
import { machineContract, memoryStore, setupFakeSsh, startFakeHetznerServer } from '@byokit/cloud/testing';

const servers: Awaited<ReturnType<typeof startFakeHetznerServer>>[] = [];
after(async () => { for (const s of servers) await s.close(); });
async function bench() {
  const root = scratchDir('hetzner'); const api = await startFakeHetznerServer(); servers.push(api);
  const ssh = setupFakeSsh(join(root, 'bin'), { user: 'user', home: '/home/user' });
  const keyPath = join(root, 'id_ed25519'); writeFileSync(keyPath, 'task-only-fake-key', { mode: 0o600 });
  const store = memoryStore();
  const options: HetznerOptions = { baseUrl: api.url, label: 'Hetzner', project: 'project-umer', location: 'fsn1', image: 'ubuntu-24.04', key: async () => 'test-key', store, publicKey: 'ssh-ed25519 YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=', ssh: { ssh: ssh.ssh, keyPath, stateDir: join(root, 'state') } };
  const provider = await hetzner(options);
  // Only the fake's known key is approved here; real consumers ask the person.
  const create = provider.create!;
  provider.create = async o => { const ref = await create(o); await (await provider.hostKey(ref)).confirm(); return ref; };
  return { provider, store, api, ssh, options, installs: true, keepCopies: false };
}
// Advance only the adapter's 2-second polls; HTTP and SSH keep their real event loops.
function fastPolls(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const timer = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 2000) t.mock.timers.tick(ms);
    return timer(fn, ms === 2000 ? 0 : ms, ...args);
  });
}
// All applicable shared assertions use the HTTP API and the native fake SSH binary.
machineContract(bench);

test('Umer rents, bootstraps, prices and deletes one Hetzner computer without leaking a token', async () => {
  const b = await bench(); const m = machine(b);
  assert.deepEqual(b.provider.sizes().map(s => s.id), ['small', 'large'], 'paginated API catalogue, sorted smallest first');
  const p = b.provider.prices()[0]; assert.equal(p.perMonthCap, 3.6); assert.equal(p.perHour, p.asleepPerHour);
  await assert.rejects(m.create({ name: 'web', size: 'small', keepCopies: true }), { code: 'unsupported' });
  b.api.dropNextCreate();
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: false });
  assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1, 'lost create response reconciles by name and operation label');
  assert.equal(await m.state(), 'on'); assert.equal(b.provider.sleep, undefined); assert.equal(b.provider.wake, undefined);
  assert.equal(b.api.firewalls.size, 1);
  const firewall = [...b.api.firewalls.values()][0];
  assert.deepEqual(firewall['rules'], [{ direction: 'in', protocol: 'tcp', port: '22', source_ips: ['0.0.0.0/0'] }]);
  await assert.rejects(m.sleep(), { code: 'unsupported' });
  await m.install({ name: 'web', node: { version: '24.15.0', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'a'.repeat(64) } }, install: [['npm', 'ci']], run: { argv: ['node', 'server.mjs'], env: {} }, workDir: '/home/user/app' });
  assert.equal(await m.host(), 'running'); assert.equal((await m.cost()).perMonth, 3.6);
  assert.equal((firewall['rules'] as unknown[]).length, 1, 'install never opens an app port');
  const bytes = new TextEncoder().encode('Umer'); await b.provider.write(ref, '/home/user/app/name.txt', bytes, 0o600);
  const written = b.ssh.readMachine().readFile('/home/user/app/name.txt'); assert.ok(written);
  assert.deepEqual(Uint8Array.from(written), bytes);
  await assert.rejects(m.remove('wrong'), { code: 'confirm' });
  await assert.rejects(b.provider.create!({ name: 'web', size: 'small', keepCopies: false, idempotencyKey: 'other-operation' }), { code: 'exists' });
  b.api.failNext(500, 'echoed test-key');
  await assert.rejects(b.provider.hostKey(ref), e => { assert.match(String(e), /\[masked\]/); assert.doesNotMatch(String(e), /test-key/); return true; });
  await assert.rejects(hetzner({ ...b.options, key: async () => 'secret-wrong-key' }), { code: 'unauthorized' });
  b.api.failNext(503, 'temporary outage'); assert.equal(await b.provider.status(ref), 'unknown');
  b.ssh.setFail({ code: 255, stderr: 'REMOTE HOST IDENTIFICATION HAS CHANGED' });
  await assert.rejects(b.provider.exec(ref, ['true'], { timeoutMs: 1000 }), { code: 'host-key' }); b.ssh.setFail(null);
  const original = b.api.servers.get(Number(ref.id))!; b.api.servers.delete(Number(ref.id));
  const reloaded = machine({ provider: await hetzner(b.options), store: b.store });
  await assert.rejects(reloaded.state(), { code: 'wrong-account' });
  assert.deepEqual((await b.store.load())?.ref, ref); b.api.servers.set(Number(ref.id), original);
  await m.remove(ref.id); assert.equal(m.ref, null); assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
  b.api.failNext(503, 'IP setup failed', '/primary_ips/4');
  await assert.rejects(b.provider.create!({ name: 'recovery', size: 'small', keepCopies: false, idempotencyKey: 'recover-op' }), { code: 'provider' });
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0, 'failed setup cleans every allocated resource');
  const recovered = await b.provider.create!({ name: 'recovery', size: 'large', keepCopies: false, idempotencyKey: 'recover-op' });
  assert.deepEqual(b.provider.prices().map(p => p.size), ['small', 'large'], 'touching a larger server never reorders the catalogue');
  const chosen = b.provider.prices().find(p => p.size === 'large'); assert.ok(chosen?.perMonthCap);
  // Restart with a fresh store; without usage(), the app records its chosen monthly price (cloud-kit 10.1).
  const restarted = memoryStore({ ref: recovered, providerKey: '', monthlyEntered: chosen.perMonthCap });
  assert.equal((await machine({ provider: await hetzner({ ...b.options, store: restarted }), store: restarted }).cost()).perMonth, 6.6);
  await b.provider.remove!(recovered, recovered.id); assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
  assert.ok(b.api.requests.some(r => r.method === 'GET' && r.path === `/servers/${ref.id}`));
  assert.doesNotMatch(JSON.stringify(b.api.requests) + JSON.stringify(b.ssh.calls()), /test-key|secret-wrong-key/);
});

test('a failed firewall attachment never saves or leaves a half-open server', async () => {
  const b = await bench(); const m = machine(b); b.api.detachNextCreate();
  await assert.rejects(m.create({ name: 'web', size: 'small', keepCopies: false }), { code: 'provider' });
  assert.equal(m.ref, null); assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
  assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1);
  assert.ok(b.api.requests.some(r => r.method === 'DELETE' && r.path === '/servers/1'));
});

test('remove destroys a detached-firewall machine before sweeping its kit firewall', async () => {
  const b = await bench(); const m = machine(b);
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: false });
  const allocated = b.api.servers.get(Number(ref.id)); assert.ok(allocated);
  (allocated['public_net'] as { firewalls: unknown[] }).firewalls = [];
  const before = b.api.requests.length;
  await m.remove(ref.id);
  assert.equal(m.ref, null); assert.equal((await b.store.load())?.ref, null);
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
  const removal = b.api.requests.slice(before);
  const serverDelete = removal.findIndex(r => r.method === 'DELETE' && r.path === `/servers/${ref.id}`);
  const firewallRead = removal.findIndex(r => r.method === 'GET' && r.path.startsWith('/firewalls'));
  assert.ok(serverDelete >= 0 && firewallRead > serverDelete, 'no firewall lookup gates server deletion');
});

test('SSH refuses a detached or unapplied firewall with typed re-attach-or-remove guidance', async () => {
  const b = await bench(); const m = machine(b);
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: false });
  const allocated = b.api.servers.get(Number(ref.id)); assert.ok(allocated);
  const net = allocated['public_net'] as { firewalls: { id: number; status: string }[] };
  const attached = net.firewalls[0]; assert.ok(attached);
  const before = b.ssh.calls().length;
  for (const firewalls of [[], [{ ...attached, status: 'pending' }]]) {
    net.firewalls = firewalls;
    const refusal = { name: 'MachineError', code: 'provider', message: /re-attach.*remove the machine/ };
    await assert.rejects(b.provider.exec(ref, ['true'], { timeoutMs: 1000 }), refusal);
    await assert.rejects(b.provider.write(ref, '/home/user/app/private.txt', new Uint8Array([1]), 0o600), refusal);
    await assert.rejects(b.provider.hostKey(ref), refusal);
  }
  assert.equal(b.ssh.calls().length, before, 'the unsafe machine receives no SSH subprocess');
  await m.remove(ref.id); assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
});

test('remove forgets a server deleted in the Hetzner console and clears its orphan firewall', async () => {
  const b = await bench(); const m = machine(b);
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: false });
  b.api.servers.delete(Number(ref.id)); b.api.ips.clear();
  await assert.rejects(m.state(), { code: 'wrong-account' });
  await m.remove(ref.id);
  assert.equal(m.ref, null); assert.equal((await b.store.load())?.ref, null);
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
});

test('a new create never deletes another operation firewall; remove sweeps the orphan of its machine name', async () => {
  const b = await bench(); const m = machine(b);
  const ref = await m.create({ name: 'web', size: 'small', keepCopies: false });
  const orphan = [...b.api.firewalls.keys()][0];
  b.api.servers.delete(Number(ref.id)); b.api.ips.clear();
  const again = await b.provider.create!({ name: 'web', size: 'small', keepCopies: false, idempotencyKey: 'second-op' });
  assert.equal(b.api.servers.size, 1); assert.equal(b.api.firewalls.size, 2); assert.ok(b.api.firewalls.has(orphan));
  await b.provider.remove!(again, again.id); assert.equal(b.api.firewalls.size, 0, 'removal sweeps both the attached firewall and the prior operation orphan');
  await m.remove(ref.id);
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
});

test('a 500 after allocation reconciles late listing, while never-listed allocation reports actionable ownership', async t => {
  fastPolls(t);
  const b = await bench(); const m = machine(b); b.api.failNextCreate(2);
  const ref = await m.create({ name: 'late', size: 'small', keepCopies: false });
  assert.equal(ref.id, '1'); assert.equal(m.ref?.id, ref.id);
  assert.equal(b.api.servers.get(Number(ref.id))?.['name'], 'late');
  assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1);
  assert.ok(b.api.requests.filter(r => r.method === 'GET' && r.path.startsWith('/servers?name=late')).length >= 4, 'preflight plus two hidden lists and a visible reconciliation');
  assert.equal(await m.state(), 'on'); await m.remove(ref.id);
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);

  const unresolvedAt = Date.now(); b.api.failNextCreate(Infinity);
  await assert.rejects(m.create({ name: 'never', size: 'small', keepCopies: false }), e => {
    const error = e as { code: string; extra: Record<string, string> };
    assert.equal(error.code, 'provider'); assert.equal(error.extra['name'], 'never');
    assert.equal(error.extra['firewall'], String([...b.api.firewalls.keys()][0]));
    assert.equal('machine' in error.extra, false, 'unknown id is omitted, never an empty or invented machine id');
    assert.ok(error.extra['operation']); return true;
  });
  assert.equal(Date.now() - unresolvedAt, 30_000, 'the full reconciliation budget still elapses on the fixture clock');
  assert.equal(m.ref, null); assert.equal((await b.store.load())?.ref ?? null, null);
  assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 2, 'one POST per attempt, no duplicate allocation');
  assert.equal(b.api.servers.size, 1); assert.equal(b.api.ips.size, 1); assert.equal(b.api.firewalls.size, 1, 'the named allocation remains for manual recovery, not a false cleanup success');
  assert.doesNotMatch(JSON.stringify(b.api.requests), /test-key/);
});

test('a lost create response reconciles a late-listed server, and one never listed fails naming it', async t => {
  fastPolls(t);
  const b = await bench();
  b.api.dropNextCreate(2);
  const ref = await b.provider.create!({ name: 'web', size: 'small', keepCopies: false, idempotencyKey: 'lagged-op' });
  assert.equal(ref.id, '1'); assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1);
  await b.provider.remove!(ref, ref.id);
  const unresolvedAt = Date.now(); b.api.dropNextCreate(Infinity);
  await assert.rejects(b.provider.create!({ name: 'lost', size: 'small', keepCopies: false, idempotencyKey: 'lost-op' }), e => {
    const extra = (e as { code: string; extra: Record<string, string> });
    assert.equal(extra.code, 'provider'); assert.equal(extra.extra['name'], 'lost');
    assert.equal(extra.extra['firewall'], String([...b.api.firewalls.values()].find(f => (f['labels'] as Record<string, string>)['byokit-create'] === 'lost-op')?.['id']));
    assert.equal('machine' in extra.extra, false);
    return true;
  });
  assert.equal(Date.now() - unresolvedAt, 30_000, 'a lost response keeps the same bounded reconciliation budget');
});

test('Umer\'s phone rents a Hetzner computer over HTTPS alone and it installs itself on first boot', async () => {
  const api = await startFakeHetznerServer(); servers.push(api); const store = memoryStore();
  const recipe = { name: 'runner', node: { version: '22.23.3', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) } }, install: [['npm', 'ci']], run: { argv: ['node', 'host.mjs'], env: {} }, workDir: '~/runner' };
  const phoneKey = new Uint8Array(32).fill(7);
  const options = { baseUrl: api.url, label: 'Hetzner', project: 'project-umer', location: 'fsn1', image: 'ubuntu-24.04', key: async () => 'test-key', store,
    firstBoot: { recipe, phoneKey, returnFile: 'code.txt' }, server: { labels: { owner: 'umer' }, public_net: { enable_ipv6: true } }, cloudConfig: { packages: ['git'], runcmd: [['echo', 'app first']] } };
  await assert.rejects(hetznerApi({ ...options, firstBoot: { recipe, phoneKey: new Uint8Array(3) } }), { code: 'bad-recipe' });
  const p = await hetznerApi(options); const m = machine({ provider: p, store });
  await assert.rejects(p.create!({ name: 'other', size: 'small', keepCopies: false, idempotencyKey: 'op-1' }), { code: 'bad-recipe' });
  const ref = await m.create({ name: 'runner', size: 'small', keepCopies: false });
  assert.equal(await m.state(), 'on');
  assert.deepEqual([...api.firewalls.values()][0]['rules'], [], 'without a public key nothing inbound is open');
  await assert.rejects(p.exec(ref, ['true'], { timeoutMs: 1000 }), { code: 'unsupported' });
  await assert.rejects(p.write(ref, '/home/user/x', new Uint8Array(1), 0o600), { code: 'unsupported' });
  const body = api.requests.find(r => r.method === 'POST' && r.path === '/servers')!.body;
  assert.deepEqual(body['labels'], { owner: 'umer', 'byokit-create': (body['labels'] as Record<string, string>)['byokit-create'] });
  assert.deepEqual(body['public_net'], { enable_ipv6: true, enable_ipv4: true }, 'pass-through fields reach Hetzner; the kit keeps IPv4');
  const userData = String(body['user_data']); assert.ok(userData.startsWith('#cloud-config\n')); assert.doesNotMatch(userData, /test-key/);
  const config = JSON.parse(userData.slice(14));
  assert.equal(config.users[0].ssh_authorized_keys, undefined); assert.deepEqual(config.packages, ['git']);
  assert.deepEqual(config.runcmd, [['echo', 'app first'], ['loginctl', 'enable-linger', 'user'], ['sh', '/var/lib/byokit/setup-runner.sh', 'user']]);
  const script = Buffer.from(config.write_files[0].content, 'base64').toString();
  assert.equal(script, installScript(recipe, { phoneKey, returnFile: 'code.txt' }));
  assert.match(script, new RegExp(Buffer.from(phoneKey).toString('base64').replaceAll('+', '\\+')), 'the phone key rides in the first-boot install');
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0, 'the script parses');
  assert.deepEqual(await p.request('GET', `/servers/${ref.id}`).then(r => (r as { server: { name: string } }).server.name), 'runner');
  await m.remove(ref.id); assert.equal(api.servers.size + api.ips.size + api.firewalls.size, 0);
});

test('the one console line installs the same recipe and ends with its pinned return', () => {
  const recipe = { name: 'desk', node: { version: '22.23.3', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'b'.repeat(64) } }, install: [], run: { argv: ['node', 'host.mjs'], env: {} }, workDir: '~/desk' };
  const line = setupCommand(recipe, { returnFile: 'code.txt' });
  assert.equal(line.ready, 'byokit-ready desk'); assert.doesNotMatch(line.command, /\n/);
  const [, encoded] = /^echo ([A-Za-z0-9+/=]+) \| base64 -d \| sh$/.exec(line.command) ?? [];
  assert.equal(Buffer.from(encoded!, 'base64').toString(), line.script);
  assert.equal(spawnSync('sh', ['-n'], { input: line.script }).status, 0);
  assert.throws(() => setupCommand({ ...recipe, workDir: 'desk' }), { code: 'bad-recipe' });
  assert.throws(() => setupCommand(recipe, { returnFile: '../x' }), { code: 'bad-recipe' });
});
