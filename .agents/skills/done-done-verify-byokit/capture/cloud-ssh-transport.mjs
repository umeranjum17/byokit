#!/usr/bin/env node
// Phone-only SSH box proof driver (features/cloud-ssh-transport.md).
//
//   WORK=<scratch dir holding noble.img> IMAGE=<docker image with qemu> SSH2_DIR=<dir with node_modules/ssh2> \
//   NODE_SHA_X64=<sha256 of node-v24.15.0-linux-x64.tar.xz> node cloud-ssh-transport.mjs
//
// The box is a real KVM VM booted from the Ubuntu 24.04 cloud image (noble.img, checked against Ubuntu's SHA256SUMS)
// with real cloud-init and real sshd, reached on a loopback-only port. The phone side is the built portable entry
// (`@byokit/cloud`, no `./ssh`) with `ssh2` (pure JavaScript, no `ssh` binary) as the app's own SSH transport:
// 1. sshHostKey() reads the server key over the transport; it must equal the ED25519 fingerprint cloud-init printed
//    on the serial console (the person's provider-console check), and confirm() pins it.
// 2. setup({ pick, confirmId, address }) lists the box, adopts it, installs the pinned Node and the recipe's host as a
//    user unit, then secures it: the kit installs the pinned Tailscale on the box and runs the keyless join until the
//    sign-in link shows (`open-page`). The driver never opens that link, so `joined` and the serve are not reached here.
// 3. While the join waits, the host answers on the box's loopback and the tailnet reads needs-login.
// 4. Refusals: a join key never reaches the transport, a wrong pin reads host-key-changed and exec rejects host-key.
// 5. The Node default (`@byokit/cloud/ssh` with the system `ssh` binary) pins the same key and reads the box on.
// The VM and its container are task-owned and always removed. Exit 0 = PASS, 1 = FAIL.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { machine, MachineError, setup, sshHostKey, sshVm } from '@byokit/cloud';
import { sshHostKey as binHostKey, sshVm as binVm } from '@byokit/cloud/ssh';
import { memoryStore } from '@byokit/cloud/testing';

const { WORK, IMAGE, SSH2_DIR, NODE_SHA_X64 } = process.env;
if (!WORK || !existsSync(join(WORK, 'noble.img')) || !IMAGE || !SSH2_DIR || !/^[0-9a-f]{64}$/.test(NODE_SHA_X64 ?? '')) {
  console.error('WORK (with noble.img), IMAGE, SSH2_DIR and NODE_SHA_X64 are required'); process.exit(2);
}
const { Client } = createRequire(join(SSH2_DIR, 'package.json'))('ssh2');
const log = (label, value) => console.log(`${new Date().toISOString()} ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryDocker = (...args) => { try { return docker(...args); } catch (e) { return `exit ${e.status}`; } };
const fp = (key) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

const run = `ssh-${process.pid}`;
const dir = join(WORK, run); mkdirSync(dir, { recursive: true });
const port = 20000 + (process.pid % 20000);
execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'byokit-proof', '-f', join(dir, 'id_ed25519')]);
const privateKey = readFileSync(join(dir, 'id_ed25519'));

// The phone's SSH module: ssh2 over TCP, the login key held here, the host key checked before login.
const sent = [];
const transport = {
  hostKey: ({ host, port }) => new Promise((resolve, reject) => {
    const c = new Client(); let seen = null;
    c.on('error', (e) => (seen ? resolve({ fingerprint: seen }) : reject(e)));
    c.connect({ host, port, username: 'probe', readyTimeout: 15_000, hostVerifier: (key) => { seen = fp(key); return false; } });
  }),
  exec: (to, command, { input, timeoutMs }) => new Promise((resolve, reject) => {
    sent.push(command);
    const c = new Client(); const out = []; const err = []; let mismatch = false; let done = false;
    const finish = (f) => { if (!done) { done = true; clearTimeout(timer); c.end(); f(); } };
    const timer = setTimeout(() => finish(() => resolve({ code: 124, stdout: '', stderr: '', timedOut: true })), timeoutMs + 15_000);
    c.on('error', (e) => finish(() => reject(mismatch ? new MachineError('host-key', 'the server host key changed') : e)));
    c.on('ready', () => c.exec(command, (e, stream) => {
      if (e) return finish(() => reject(e));
      stream.on('data', (d) => out.push(d)); stream.stderr.on('data', (d) => err.push(d));
      stream.on('close', (code) => finish(() => resolve({ code: code ?? 255, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() })));
      stream.end(input?.length ? Buffer.from(input) : undefined);
    }));
    c.connect({
      host: to.host, port: to.port, username: to.user, privateKey, readyTimeout: 20_000,
      hostVerifier: (key) => { mismatch = fp(key) !== to.fingerprint; return !mismatch; },
    });
  }),
};

const host = "require('http').createServer((q,s)=>s.end('runner up for Ada\\n')).listen(7300,'127.0.0.1')";
const recipe = {
  name: 'runner', node: { version: '24.15.0', sha256: { 'linux-x64': NODE_SHA_X64, 'linux-arm64': '0'.repeat(64) } },
  install: [['node', '-e', `require('fs').writeFileSync('host.js', ${JSON.stringify(host)})`]],
  run: { argv: ['node', 'host.js'], env: { OWNER: 'Ada' } }, workDir: '/home/ada/runner',
};
const name = `byk-${run}`;
let failed = false;
let diag = null; // set once the box is pinned: on a failure, its real state is printed before teardown
try {
  const userData = '#cloud-config\n' + JSON.stringify({
    users: [{ name: 'ada', shell: '/bin/bash', sudo: 'ALL=(ALL) NOPASSWD:ALL', lock_passwd: true, ssh_authorized_keys: [readFileSync(join(dir, 'id_ed25519.pub'), 'utf8').trim()] }],
    ssh_pwauth: false,
  });
  writeFileSync(join(dir, 'user-data'), userData); writeFileSync(join(dir, 'meta-data'), `instance-id: ${run}\nlocal-hostname: ada-box\n`);
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

  // 1. First connect over the phone's transport, compared with the console.
  let pin = null;
  const box = { transport, pins: { load: async () => pin, save: async (f) => { pin = f; } }, host: '127.0.0.1', port, user: 'ada', label: 'My server' };
  const provider = sshVm(box);
  const store = memoryStore();
  const key = await sshHostKey(box);
  log('host-key', { fingerprint: key.fingerprint, pinned: key.pinned, matchesConsole: key.fingerprint === consoleKey });
  assert.equal(key.fingerprint, consoleKey); assert.equal(key.pinned, false);
  await key.confirm();
  diag = async () => {
    const r = (await store.load())?.ref ?? { provider: 'ssh-vm', account: '', id: key.fingerprint, name: 'runner', keepCopies: false };
    for (const argv of [['systemctl', 'status', '--no-pager', 'tailscaled'], ['tailscale', 'status', '--json'], ['journalctl', '-u', 'tailscaled', '-n', '40', '--no-pager'], ['ls', '-la', '/var/run/tailscale', '/dev/net']]) {
      const d = await provider.exec(r, argv, { root: true, timeoutMs: 30_000 }).catch((e) => ({ code: e.code, stdout: '', stderr: e.message }));
      const mask = (t) => t.replace(/https:\/\/login\.tailscale\.com\/\S+/g, 'https://login.tailscale.com/<masked>').replace(/https:\/\/login\.tailsc\.\.\./g, '<masked>');
      log(`diag ${argv.join(' ')}`, { code: d.code, out: mask(d.stdout.slice(-1500)), err: mask(d.stderr.slice(-600)) });
    }
  };

  // 2. setup() on the box until the sign-in link (never opened).
  const steps = []; const lines = [];
  let openPage = null;
  const linked = new Promise((resolve) => { openPage = resolve; });
  const stream = (async () => {
    for await (const s of setup({
      provider, store, recipe, pick: (listed) => listed[0], confirmId: key.fingerprint, onLine: (l) => lines.push(l),
      address: { hostname: 'ada-box', port: 7300, onStep: (t) => { if (t.step === 'open-page') openPage(t.url); } },
    })) { steps.push(s.step); log('step', s.step === 'failed' ? s : s.step); }
  })();
  const url = await Promise.race([linked, stream.then(() => null)]);
  log('steps-before-sign-in', steps);
  assert.deepEqual(steps, ['checking-access', 'listing', 'inspecting', 'installing']);
  assert.ok(typeof url === 'string' && url.startsWith('https://login.tailscale.com/'), 'the keyless join shows the sign-in link');
  log('open-page', `${new URL(url).origin}/<one-time link, not opened>`);

  // 3. While the person would sign in: the host runs and the box waits for that sign-in.
  const m = machine({ provider, store });
  const answer = await provider.exec((await store.load()).ref, ['curl', '-fsS', 'http://127.0.0.1:7300'], { timeoutMs: 30_000 });
  log('host-answer', answer.stdout.trim());
  assert.equal(answer.stdout, 'runner up for Ada\n');
  const tailnet = await m.tailnet();
  log('tailnet', tailnet);
  assert.equal(tailnet.state, 'needs-login');
  const ts = await provider.exec((await store.load()).ref, ['tailscale', 'version'], { timeoutMs: 30_000 });
  log('tailscale-version', ts.stdout.split('\n')[0]);
  assert.equal(ts.stdout.split('\n')[0], '1.104.1');

  // 4. Refusals.
  const canary = ['tskey', 'canary'].join('-');
  await assert.rejects(m.joinTailnet({ hostname: 'ada-box', authKey: canary }), (e) => { log('join-key', `${e.code}: ${e.message}`); return e.code === 'unsupported'; });
  assert.ok(!sent.some((c) => c.includes(canary)), 'a join key never reaches the transport');
  const wrong = sshVm({ ...box, pins: { load: async () => `SHA256:${'B'.repeat(43)}`, save: async () => {} } });
  const ref = (await store.load()).ref;
  log('wrong-pin-status', await wrong.status(ref));
  assert.equal(await wrong.status(ref), 'host-key-changed');
  await assert.rejects(wrong.exec(ref, ['true'], { timeoutMs: 10_000 }), (e) => { log('wrong-pin-exec', `${e.code}: ${e.message}`); return e.code === 'host-key'; });

  // 5. The Node default, unchanged: the system ssh binary pins the same key.
  const stateDir = join(dir, 'ssh-state');
  const scanned = await binHostKey({ ssh: '/usr/bin/ssh', host: '127.0.0.1', port, stateDir });
  log('node-default-host-key', { fingerprint: scanned.fingerprint, matchesConsole: scanned.fingerprint === consoleKey });
  assert.equal(scanned.fingerprint, consoleKey);
  await scanned.confirm();
  const bin = binVm({ ssh: '/usr/bin/ssh', host: '127.0.0.1', port, user: 'ada', keyPath: join(dir, 'id_ed25519'), stateDir, label: 'My server' });
  log('node-default-status', await bin.status(ref));
  assert.equal(await bin.status(ref), 'on');
  log('install-lines', lines.length);
  log('commands-sent', sent.length);
  log('result', 'PASS');
} catch (e) {
  failed = true;
  if (diag) await diag().catch(() => undefined);
  log('result', `FAIL ${e instanceof Error ? e.message : String(e)}`);
} finally {
  tryDocker('rm', '-f', name);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
