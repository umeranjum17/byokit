# Hetzner first-slice cloud computer

The Node-only `@byokit/cloud/hetzner` entry loads shared sizes and dated prices from
the API, creates one computer with an app-owned token and project identity, delegates
SSH to the existing pinned adapter, installs the unchanged HostRecipe and confirms
server, automatically allocated primary-IP and SSH-only firewall deletion. Creation
attaches a provider firewall with only SSH 22/tcp inbound on IPv4 and IPv6; recipe
ports stay closed, and an attachment/setup failure must leave no allocated resources. Copies and start/stop are
explicitly absent in this first slice. A stopped server still bills.

## Built consumer (offline)

Build and run Doctor from SKILL.md first. Write the following consumer to an exclusive
scratch folder. A dispatched lane may put scratch and evidence in its authorized
external data folder instead of `.verify-artifacts`; `createRequire` resolves the
public entries from the worktree root without copying dependencies or credentials.
From that root: `node <scratch>/cloud-hetzner.mjs`. Capture command, output and exit
status with the skill's Evidence block (using the authorized evidence path).

```js
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(process.cwd() + '/');
const { hetzner } = await import(require.resolve('@byokit/cloud/hetzner'));
const { machine } = await import(require.resolve('@byokit/cloud'));
const { startFakeHetznerServer, setupFakeSsh, memoryStore } = await import(require.resolve('@byokit/cloud/testing'));
const root = await mkdtemp(join(tmpdir(), 'byk-hz-'));
const api = await startFakeHetznerServer();
try {
  const ssh = setupFakeSsh(join(root, 'bin'), { user: 'user', home: '/home/user' });
  const keyPath = join(root, 'id_ed25519'); await writeFile(keyPath, 'fixture-only-key', { mode: 0o600 });
  const store = memoryStore();
  const options = { baseUrl: api.url, label: 'Hetzner', project: 'Umer', location: 'fsn1', image: 'ubuntu-24.04', key: async () => 'test-key', store, publicKey: 'ssh-ed25519 YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=', ssh: { ssh: ssh.ssh, keyPath, stateDir: join(root, 'state') } };
  const p = await hetzner(options); const m = machine({ provider: p, store });
  console.log('built-entry:', require.resolve('@byokit/cloud/hetzner'));
  console.log('sizes:', JSON.stringify(p.sizes())); console.log('price:', JSON.stringify(p.prices()[0]));
  api.dropNextCreate();
  const ref = await m.create({ name: 'web', size: p.sizes()[0].id, keepCopies: false });
  await (await p.hostKey(ref)).confirm(); // approves only the synthetic fixture key
  await m.install({ name: 'web', node: { version: '24.15.0', sha256: { 'linux-x64': 'a'.repeat(64), 'linux-arm64': 'a'.repeat(64) } }, install: [['npm', 'ci']], run: { argv: ['node', 'server.mjs'], env: {} }, workDir: '/home/user/app' });
  assert.equal(await m.host(), 'running'); console.log('host:', await m.host(), 'state:', await m.state());
  assert.equal(api.requests.filter(r => r.method === 'POST' && r.path === '/servers').length, 1);
  assert.equal(api.firewalls.size, 1); assert.equal([...api.firewalls.values()][0].rules.length, 1);
  console.log('only-public-inbound: SSH 22/tcp, IPv4+IPv6; app-port-rule: absent');
  api.failNext(500, 'echoed test-key');
  try { await p.hostKey(ref); assert.fail('expected provider failure'); }
  catch (e) { assert.equal(e.code, 'provider'); assert.ok(!e.message.includes('test-key')); console.log('typed-error:', e.code, e.message); }
  await m.remove(ref.id); assert.equal(api.servers.size + api.ips.size + api.firewalls.size, 0);
  api.detachNextCreate();
  await assert.rejects(m.create({ name: 'blocked', size: p.sizes()[0].id, keepCopies: false }), { code: 'provider' });
  assert.equal(api.servers.size + api.ips.size + api.firewalls.size, 0);
  console.log('failed-firewall-attachment: typed provider error; leaked-resources: 0');
  assert.ok(!JSON.stringify(api.requests).includes('test-key'));
  console.log('server-primary-ips-firewall-deleted: true; lost-response-create-posts: 1; token-leaks: false');
} finally { await api.close(); await rm(root, { recursive: true, force: true }); }
```

This proves the built public API and native process seam against offline stand-ins,
not Hetzner provisioning or billing. Contract and journey source gates additionally
prove saved-ref visibility refusal without record mutation, no copies, confirmation,
key rejection and SSH file bytes.

## Live proof (authorized token only)

Prerequisites: the lead names a task-owned token file, approves the smallest shared
server's API price and confirms the common Boat/Hetzner spend is below the $15 stop
cap ($10 warning, maximum two concurrent machines). Read the token **only inside the
proof process**, never into argv, logs or cloud-init; this lane's token rule is stricter
than the generic credential-mask example: print no token characters. Create an
exclusive SSH key, pass only its public key, use one current Ubuntu/Debian image and
API-smallest type, create with `keepCopies: false`, poll until on, confirm the host
fingerprint under the lead's proof authorization, wait for SSH/cloud-init readiness,
then run a minimal real HostRecipe and verify `host() === 'running'`. The live lab
host deliberately listens on `0.0.0.0` at its app port: verify a local request through
SSH succeeds, then TCP-connect from this computer to the public IP/app port and
require refusal or timeout. Record that negative with the actual SSH-22-only firewall
rules/applied status; this is provider-firewall proof, not tailnet-only SSH proof.
Always delete in `finally`; independently GET the server, original primary-IP ids
and dedicated firewall id and require 404 for each. Record elapsed time, API hourly rate/currency and the provider's billing
rounding/minimum; that is a bounded list-price estimate, not an invoice or proof of
USD conversion. Scan every evidence file for the entire token without printing it.
A missing token stays `not proven`, never PASS. No real token or key is committed.
