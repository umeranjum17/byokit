#!/usr/bin/env node
// SSH forward proof driver (features/cloud-ssh-transport.md, sub-feature `transport-forward`): no Tailscale.
//
//   WORK=<scratch dir holding noble.img> IMAGE=<docker image with qemu> NODE_SHA_X64=<sha256 of node-v24.15.0-linux-x64.tar.xz> \
//   node cloud-ssh-forward.mjs
//
// The box is a real KVM VM booted from the Ubuntu 24.04 cloud image (noble.img, checked against Ubuntu's SHA256SUMS)
// with real cloud-init and real sshd, reached on a loopback-only port. Everything runs through the built Node entry
// (`@byokit/cloud/ssh`, the system `ssh` binary, the key by path):
// 1. sshHostKey() reads the server key; it must equal the ED25519 fingerprint cloud-init printed on the serial console.
// 2. setup() with no `address` installs the pinned Node and the recipe's host, which listens on the box's loopback only.
// 3. sshResolve() over sshTransport() opens one `ssh -N -L` forward: a request to the rewritten address gets the host's
//    answer, and the box has no tailscale and no listener beyond 127.0.0.1.
// 4. The forward is reused, a closed one is opened again, and a pin the server does not hold is refused with host-key.
// The VM and its container are task-owned and always removed. Exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { join } from 'node:path';
import { setup, sshResolve } from '@byokit/cloud';
import { sshHostKey, sshTransport, sshVm } from '@byokit/cloud/ssh';
import { memoryStore } from '@byokit/cloud/testing';

const { WORK, IMAGE, NODE_SHA_X64 } = process.env;
if (!WORK || !existsSync(join(WORK, 'noble.img')) || !IMAGE || !/^[0-9a-f]{64}$/.test(NODE_SHA_X64 ?? '')) {
  console.error('WORK (with noble.img), IMAGE and NODE_SHA_X64 are required'); process.exit(2);
}
const log = (label, value) => console.log(`${new Date().toISOString()} ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args) => { try { return docker(...args); } catch (e) { return `exit ${e.status}`; } };
const body = (url) => new Promise((resolve, reject) => get(url, (r) => { let t = ''; r.on('data', (d) => (t += d)); r.on('end', () => resolve(t)); }).on('error', reject));

const run = `fwd-${process.pid}`;
const dir = join(WORK, run); mkdirSync(dir, { recursive: true });
const port = 20000 + (process.pid % 20000);
const keyPath = join(dir, 'id_ed25519');
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'byokit-proof', '-f', keyPath]);

const host = "require('http').createServer((q,s)=>s.end('runner up for Ada\\n')).listen(7300,'127.0.0.1')";
const recipe = {
  name: 'runner', node: { version: '24.15.0', sha256: { 'linux-x64': NODE_SHA_X64, 'linux-arm64': '0'.repeat(64) } },
  install: [['node', '-e', `require('fs').writeFileSync('host.js', ${JSON.stringify(host)})`]],
  run: { argv: ['node', 'host.js'], env: { OWNER: 'Ada' } }, workDir: '/home/ada/runner',
};
const name = `byk-${run}`;
let failed = false;
try {
  writeFileSync(join(dir, 'user-data'), '#cloud-config\n' + JSON.stringify({
    users: [{ name: 'ada', shell: '/bin/bash', sudo: 'ALL=(ALL) NOPASSWD:ALL', lock_passwd: true, ssh_authorized_keys: [readFileSync(`${keyPath}.pub`, 'utf8').trim()] }],
    ssh_pwauth: false,
  }));
  writeFileSync(join(dir, 'meta-data'), `instance-id: ${run}\nlocal-hostname: ada-box\n`);
  docker('run', '-d', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`, '--device', '/dev/kvm', '--memory', '2g',
    '-p', `127.0.0.1:${port}:2222`, '-v', `${WORK}:/work`, '-w', `/work/${run}`, IMAGE, 'sh', '-c',
    'genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data && qemu-img create -q -f qcow2 -F qcow2 -b /work/noble.img disk.qcow2 10G && exec qemu-system-x86_64 -enable-kvm -cpu host -m 1536 -smp 2 -display none -serial file:console.log -drive file=disk.qcow2,if=virtio -drive file=seed.iso,media=cdrom -nic user,model=virtio,hostfwd=tcp::2222-:22');
  let consoleText = '';
  for (const end = Date.now() + 600_000; !/Cloud-init v\. \S+ finished/.test(consoleText);) {
    if (Date.now() > end || tryDocker('inspect', '-f', '{{.State.Running}}', name) !== 'true') throw new Error(`the box did not boot: ${consoleText.split('\n').slice(-5).join(' | ')}`);
    await new Promise((r) => setTimeout(r, 3000));
    consoleText = existsSync(join(dir, 'console.log')) ? readFileSync(join(dir, 'console.log'), 'utf8') : '';
  }
  const consoleKey = /(SHA256:[A-Za-z0-9+/]{43}) \S+ \(ED25519\)/.exec(consoleText)?.[1];
  log('console-ed25519', consoleKey ?? 'none');
  assert.ok(consoleKey, 'cloud-init printed the ED25519 host key on the console');

  // 1. First connect with the system ssh binary, compared with the console.
  const stateDir = join(dir, 'ssh-state');
  const base = { ssh: '/usr/bin/ssh', host: '127.0.0.1', port, stateDir };
  const key = await sshHostKey(base);
  log('host-key', { fingerprint: key.fingerprint, matchesConsole: key.fingerprint === consoleKey });
  assert.equal(key.fingerprint, consoleKey);
  await key.confirm();

  // 2. setup() with no address: no tailnet step, the host listens on the box's loopback.
  const provider = sshVm({ ...base, user: 'ada', keyPath, label: 'My server' });
  const steps = [];
  for await (const s of setup({ provider, store: memoryStore(), recipe, pick: (l) => l[0], confirmId: key.fingerprint })) { steps.push(s.step); if (s.step === 'failed') log('failed', s); }
  log('steps', steps);
  assert.deepEqual(steps, ['checking-access', 'listing', 'inspecting', 'installing', 'ready']);

  // 3. One forward to the box's loopback.
  const transport = sshTransport({ ssh: '/usr/bin/ssh', keyPath, stateDir });
  const target = { host: '127.0.0.1', port, user: 'ada' };
  const resolver = sshResolve({ transport, pins: { load: async () => key.fingerprint }, target, port: 7300 });
  const first = await resolver('ws://127.0.0.1:7300/link?x=1');
  const local = /^ws:\/\/127\.0\.0\.1:(\d+)\/link\?x=1$/.exec(first)?.[1];
  log('resolved', first);
  assert.ok(local && Number(local) !== 7300, 'the address is rewritten to a local forward port');
  const answer = await body(`http://127.0.0.1:${local}/`);
  log('host-answer-through-forward', answer.trim());
  assert.equal(answer, 'runner up for Ada\n');
  const onBox = (cmd) => execFileSync('/usr/bin/ssh', ['-F', join(stateDir, 'ssh_config'), '-p', String(port), 'ada@127.0.0.1', cmd], { encoding: 'utf8' });
  const listeners = onBox('ss -ltnH').split('\n').filter((l) => /:7300\s/.test(l)).map((l) => l.trim().split(/\s+/)[3]);
  log('listeners-7300', listeners);
  assert.deepEqual(listeners, ['127.0.0.1:7300'], 'the app port listens on the loopback only');
  const noTailscale = onBox('command -v tailscale tailscaled || echo none; systemctl is-active tailscaled || true').trim();
  log('tailscale-on-box', noTailscale);
  assert.match(noTailscale, /^none\s+(inactive|unknown)$/);

  // 4. Reuse, reopen, refusal.
  assert.equal(await resolver('ws://127.0.0.1:7300/link?x=1'), first, 'the forward is reused');
  assert.equal(await resolver('ws://192.0.2.1:7300/link'), 'ws://192.0.2.1:7300/link', 'other addresses pass through');
  await resolver.close();
  await assert.rejects(body(`http://127.0.0.1:${local}/`), 'a closed forward stops listening');
  const second = await resolver('ws://127.0.0.1:7300/link?x=1');
  log('reopened', second);
  assert.equal(await body(`http://127.0.0.1:${/:(\d+)\//.exec(second)[1]}/`), 'runner up for Ada\n');
  await resolver.close();
  // A server whose key is not the pinned one: known_hosts now pins another key.
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'other')]);
  const [type, other] = readFileSync(join(dir, 'other.pub'), 'utf8').split(' ');
  writeFileSync(join(stateDir, 'known_hosts'), `127.0.0.1 ${type} ${other}\n[127.0.0.1]:${port} ${type} ${other}\n`);
  const wrong = sshResolve({ transport, pins: { load: async () => key.fingerprint }, target, port: 7300 });
  await assert.rejects(wrong('ws://127.0.0.1:7300/link'), (e) => { log('wrong-pin', `${e.code}: ${e.message}`); return e.code === 'host-key'; });
  log('result', 'PASS');
} catch (e) {
  failed = true;
  log('result', `FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  tryDocker('rm', '-f', name);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
