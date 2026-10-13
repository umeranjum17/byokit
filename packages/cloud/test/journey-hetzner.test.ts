import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { scratchDir } from '../../test-support.ts';
import { hetzner, type HetznerOptions } from '@byokit/cloud/hetzner';
import { machine } from '@byokit/cloud';
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
  // Without usage(), the app records its chosen monthly price (cloud-kit 10.1); prices()[0] stays smallest.
  await b.store.save({ ref: recovered, providerKey: '', monthlyEntered: chosen.perMonthCap });
  assert.equal((await machine({ provider: await hetzner(b.options), store: b.store }).cost()).perMonth, 6.6);
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
  await b.provider.remove!(again, again.id); assert.equal(b.api.firewalls.size, 1);
  await m.remove(ref.id);
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);
});

test('a 500 after allocation reconciles late listing, while never-listed allocation reports actionable ownership', async () => {
  const b = await bench(); const m = machine(b); b.api.failNextCreate(2);
  const ref = await m.create({ name: 'late', size: 'small', keepCopies: false });
  assert.equal(ref.id, '1'); assert.equal(m.ref?.id, ref.id);
  assert.equal(b.api.servers.get(Number(ref.id))?.['name'], 'late');
  assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1);
  assert.ok(b.api.requests.filter(r => r.method === 'GET' && r.path.startsWith('/servers?name=late')).length >= 4, 'preflight plus two hidden lists and a visible reconciliation');
  assert.equal(await m.state(), 'on'); await m.remove(ref.id);
  assert.equal(b.api.servers.size + b.api.ips.size + b.api.firewalls.size, 0);

  b.api.failNextCreate(Infinity);
  await assert.rejects(m.create({ name: 'never', size: 'small', keepCopies: false }), e => {
    const error = e as { code: string; extra: Record<string, string> };
    assert.equal(error.code, 'provider'); assert.equal(error.extra['name'], 'never');
    assert.equal(error.extra['firewall'], String([...b.api.firewalls.keys()][0]));
    assert.equal('machine' in error.extra, false, 'unknown id is omitted, never an empty or invented machine id');
    assert.ok(error.extra['operation']); return true;
  });
  assert.equal(m.ref, null); assert.equal((await b.store.load())?.ref ?? null, null);
  assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 2, 'one POST per attempt, no duplicate allocation');
  assert.equal(b.api.servers.size, 1); assert.equal(b.api.ips.size, 1); assert.equal(b.api.firewalls.size, 1, 'the named allocation remains for manual recovery, not a false cleanup success');
  assert.doesNotMatch(JSON.stringify(b.api.requests), /test-key/);
});

test('a lost create response reconciles a late-listed server, and one never listed fails naming it', async () => {
  const b = await bench();
  b.api.dropNextCreate(2);
  const ref = await b.provider.create!({ name: 'web', size: 'small', keepCopies: false, idempotencyKey: 'lagged-op' });
  assert.equal(ref.id, '1'); assert.equal(b.api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1);
  await b.provider.remove!(ref, ref.id);
  b.api.dropNextCreate(Infinity);
  await assert.rejects(b.provider.create!({ name: 'lost', size: 'small', keepCopies: false, idempotencyKey: 'lost-op' }), e => {
    const extra = (e as { code: string; extra: Record<string, string> });
    assert.equal(extra.code, 'provider'); assert.equal(extra.extra['name'], 'lost');
    assert.equal(extra.extra['firewall'], String([...b.api.firewalls.values()].find(f => (f['labels'] as Record<string, string>)['byokit-create'] === 'lost-op')?.['id']));
    assert.equal('machine' in extra.extra, false);
    return true;
  });
});
