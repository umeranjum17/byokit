#!/usr/bin/env node
// Phone-only Hetzner and one-line console proof driver (features/cloud-hetzner-firstboot.md).
//
//   WORK=<scratch dir holding noble.img> IMAGE=<qemu image> NODE_SHA_X64=<sha256> NODE_VERSION=<x.y.z> node cloud-firstboot.mjs
//
// Each machine is a real KVM VM booted from the Ubuntu 24.04 cloud image (noble.img, checked against Ubuntu's
// SHA256SUMS) with real cloud-init and a NoCloud seed, the way a Hetzner server boots; the driver never runs a
// command inside it and reads only its serial console.
// 1. G8: the built portable `hetznerApi()` (no SSH, no publicKey) creates one computer on the loopback Hetzner bench
//    with a first-boot recipe and an owner phone key; the exact user_data it sent seeds VM 1, whose cloud-init
//    installs the pinned node, the recipe and the unit. The host process reads the delivered phone key and writes
//    the outbox file that the ready line returns.
// 2. K-DIRECT: VM 2 runs the exact `setupCommand()` lines with sh, as root (a provider console) and as a logged-in
//    non-root user (their own desktop), plus a bad node checksum that must print `byokit-failed broken node`.
// VMs and their containers are task-owned and always removed. Exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hetznerApi, machine, setupCommand } from '@byokit/cloud';
import { memoryStore, startFakeHetznerServer } from '@byokit/cloud/testing';

const { WORK, IMAGE, NODE_SHA_X64, NODE_VERSION } = process.env;
if (!WORK || !existsSync(join(WORK, 'noble.img')) || !IMAGE || !/^[0-9a-f]{64}$/.test(NODE_SHA_X64 ?? '') || !/^\d+\.\d+\.\d+$/.test(NODE_VERSION ?? '')) { console.error('WORK (with noble.img), IMAGE, NODE_SHA_X64 and NODE_VERSION are required'); process.exit(2); }
const log = (label, value) => console.log(`${new Date().toISOString()} ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args) => { try { return docker(...args); } catch (e) { return `exit ${e.status}`; } };
const host = "const fs=require('fs');const k=fs.readFileSync('.byokit/inbox/phone.bin');fs.mkdirSync('.byokit/outbox',{recursive:true});fs.writeFileSync('.byokit/outbox/code.txt','bound '+k.toString('base64url')+'\\n');setInterval(()=>{},1e9)";
const recipe = (name, sha = NODE_SHA_X64, version = NODE_VERSION) => ({
  name, node: { version, sha256: { 'linux-x64': sha, 'linux-arm64': '0'.repeat(64) } },
  install: [['node', '-e', `require('fs').writeFileSync('host.js', ${JSON.stringify(host)})`]],
  run: { argv: ['node', 'host.js'], env: { OWNER: 'Umer' } }, workDir: '~/runner',
});
const phoneKey = new Uint8Array(32).map((_, i) => i + 1);
const keyText = Buffer.from(phoneKey).toString('base64url');
const vms = [];
// Boot one VM from a seed; resolve its serial console once `done` matches it.
const boot = async (run, userData, done) => {
  const dir = join(WORK, run); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'user-data'), userData); writeFileSync(join(dir, 'meta-data'), `instance-id: ${run}\nlocal-hostname: ${run}\n`);
  const name = `byk-${run}-${process.pid}`; vms.push({ name, dir });
  docker('run', '-d', '--name', name, '--user', `${process.getuid()}:${process.getgid()}`, '--device', '/dev/kvm', '--memory', '2g', '-v', `${WORK}:/work`, '-w', `/work/${run}`, IMAGE, 'sh', '-c',
    'genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data && qemu-img create -q -f qcow2 -F qcow2 -b /work/noble.img disk.qcow2 10G && exec qemu-system-x86_64 -enable-kvm -cpu host -m 1536 -smp 2 -display none -serial file:console.log -drive file=disk.qcow2,if=virtio -drive file=seed.iso,media=cdrom -nic user,model=virtio');
  const end = Date.now() + 600_000;
  for (;;) {
    const text = existsSync(join(dir, 'console.log')) ? readFileSync(join(dir, 'console.log'), 'utf8') : '';
    if (done(text)) return text;
    if (Date.now() > end || tryDocker('inspect', '-f', '{{.State.Running}}', name) !== 'true') throw new Error(`${run} did not finish: ${text.split('\n').slice(-5).join(' | ')}`);
    await new Promise(r => setTimeout(r, 3000));
  }
};
const lines = (text) => text.split(/\r?\n/).filter(l => /byokit-|check [a-z]/.test(l)).map(l => l.replace(/^.*?(byokit-|check [a-z])/, "$1"));
const api = await startFakeHetznerServer();
let failed = false;
try {
  // G8: phone side, HTTPS only.
  const store = memoryStore();
  const p = await hetznerApi({ baseUrl: api.url, label: 'Hetzner', project: 'Umer', location: 'fsn1', image: 'ubuntu-24.04', key: async () => 'test-key', store, firstBoot: { recipe: recipe('runner'), phoneKey, returnFile: 'code.txt' } });
  const m = machine({ provider: p, store });
  const ref = await m.create({ name: 'runner', size: p.sizes()[0].id, keepCopies: false });
  log('created', { ref, state: await m.state() });
  log('firewall-rules', [...api.firewalls.values()][0].rules);
  assert.deepEqual([...api.firewalls.values()][0].rules, [], 'nothing inbound is open');
  await assert.rejects(p.exec(ref, ['true'], { timeoutMs: 1000 }), e => { log('phone-exec', `${e.code}: ${e.message}`); return e.code === 'unsupported'; });
  const userData = api.requests.find(r => r.method === 'POST' && r.path === '/servers').body.user_data;
  assert.ok(!userData.includes('test-key'), 'the token never enters user_data');
  log('user_data-bytes', userData.length);
  const g8 = await boot('g8', userData, t => /byokit-(ready|failed)/.test(t));
  log('vm1-console', lines(g8));
  assert.ok(lines(g8).includes(`byokit-ready runner bound ${keyText}`), 'the host read exactly the delivered phone key');
  await m.remove(ref.id); assert.equal(api.servers.size + api.ips.size + api.firewalls.size, 0);
  log('removed', 'server, primary IP and firewall deleted over HTTPS');

  // K-DIRECT: the one line as a console root shell, as the person on their own desktop, and a broken one.
  const root = setupCommand(recipe('direct'), { phoneKey, returnFile: 'code.txt' });
  const desk = setupCommand(recipe('desk'), { phoneKey, returnFile: 'code.txt' });
  const bad = setupCommand(recipe('broken', 'f'.repeat(64), '22.0.0'));
  log('command-chars', [root.command.length, desk.command.length]); log('pinned-return', [root.ready, desk.ready]);
  const console2 = '#cloud-config\n' + JSON.stringify({
    users: [{ name: 'user', shell: '/bin/bash', lock_passwd: true }],
    runcmd: [
      ['sh', '-c', root.command], ['sh', '-c', root.command],
      ['sh', '-c', 'echo "check root-unit $(systemctl is-active byokit-direct.service) $(stat -c %U:%a /root/runner/.byokit/inbox/phone.bin)"'],
      ['loginctl', 'enable-linger', 'user'], ['sh', '-c', 'i=0; until [ -S /run/user/$(id -u user)/bus ] || [ $i -gt 30 ]; do sleep 1; i=$((i+1)); done'],
      ['runuser', '-u', 'user', '--', 'env', 'HOME=/home/user', 'XDG_RUNTIME_DIR=/run/user/1000', 'sh', '-c', desk.command],
      ['sh', '-c', 'echo "check desk-unit $(runuser -u user -- env XDG_RUNTIME_DIR=/run/user/1000 systemctl --user is-active byokit-desk.service) $(stat -c %U:%a /home/user/runner/.byokit/inbox/phone.bin)"'],
      ['sh', '-c', `${bad.command}; echo "check broken-exit $?"`],
    ],
  });
  const direct = await boot('direct', console2, t => /check broken-exit/.test(t));
  const seen = lines(direct); log('vm2-console', seen);
  assert.deepEqual(seen.filter(l => l.startsWith('byokit-ready direct')), [`${root.ready} bound ${keyText}`, `${root.ready} bound ${keyText}`], 'root console, then a second paste repairs in place');
  assert.ok(seen.includes('check root-unit active root:600'));
  assert.ok(seen.includes(`${desk.ready} bound ${keyText}`), 'the desktop user line');
  assert.ok(seen.includes('check desk-unit active user:600'));
  assert.ok(seen.includes('byokit-failed broken node') && seen.includes('check broken-exit 1'), 'a bad checksum fails closed');
  log('result', 'PASS');
} catch (e) {
  failed = true; log('result', `FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  for (const v of vms) { tryDocker('rm', '-f', v.name); rmSync(v.dir, { recursive: true, force: true }); }
  await api.close();
}
process.exit(failed ? 1 : 0);
