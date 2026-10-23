#!/usr/bin/env node
// Phone receipt proof driver (features/cloud-phone-enrol.md): setup() with `address` (the SSH route) and `pairEnrol`
// from the built @byokit/cloud, then the "phone" (this process) opens a real @byokit/pair DeviceLink holding only its
// own secret key, its SSH transport and the receipt the `pairing` step carried, and makes one request over it.
// No tailnet anywhere: the link dials the machine's loopback through one SSH forward (sshResolve).
//
//   bench: node cloud-pair-receipt.mjs bench
//     fakeProvider() machine reached through fakeSshTransport(); the host process runs here with a real Host on a
//     loopback socket the fake forward carries the machine's port 7300 to.
//   live:  BOAT_KEY_FILE=<file> EVIDENCE_DIR=<outside the repo> CLOUD_TGZ=<npm pack of packages/cloud> SSH_BIN=/usr/bin/ssh
//          node cloud-pair-receipt.mjs live
//     Makes a throwaway lab SSH key in its own temp folder (used by path, never printed, deleted at the end), creates
//     ONE Boat machine (recorded in EVIDENCE_DIR/owned.json before anything else), installs a small pair host from
//     CLOUD_TGZ + @byokit/pair, lets the key in with Boat's /sshkey, pins the host key Boat names, runs setup() against
//     it (securing over SSH), links from this computer through an SSH forward, makes one request, then ALWAYS deletes
//     the machine and confirms it is gone. Never prints the Boat key.
// Exit 0 = PASS, 1 = FAIL, 2 = bad setup.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WebSocketServer } from 'ws';
import { boat, machine, pairEnrol, phoneReceipt, bindPhoneKey, setup, sshResolve, PHONE_KEY_FILE, RECEIPT_FILE } from '@byokit/cloud';
import { sshHostKey, sshTransport } from '@byokit/cloud/ssh';
import { fakeProvider, fakeSshTransport, memoryStore } from '@byokit/cloud/testing';
import { DeviceLink, Host, b64url, keyPair } from '@byokit/pair';

const mode = process.argv[2];
const log = (label, value) => {
  const line = `${new Date().toISOString()} ${label}: ${JSON.stringify(value)}`;
  console.log(line);
  if (process.env.EVIDENCE_DIR) appendFileSync(join(process.env.EVIDENCE_DIR, 'drive.log'), `${line}\n`, { mode: 0o600 });
};
const short = (s) => `${s.slice(0, 6)}…`; // public key / id prefix only, enough to compare
const routeLine = (r) => ({ port: r.port, user: r.user, fingerprint: short(r.fingerprint), appPort: r.appPort });
const stepLine = (s) => s.step === 'failed' ? `failed:${s.at}:${s.cause}:${s.retryable}`
  : s.step === 'securing' ? `securing:ssh:${s.route.appPort}`
  : s.step === 'pairing' ? `pairing:${s.receipt ? 'receipt' : 'none'}` : s.step;

/** The phone side: only its own key pair, its SSH route and the receipt. Resolves the answer to one request. */
async function phoneLinks(phone, receipt, o = {}) {
  const seen = [];
  const link = new DeviceLink({ v: 1, secretKey: b64url(phone.secretKey), hostName: 'Cloud computer', ...receipt },
    { store: { save() {}, clear() {} }, onStatus: (s) => seen.push(s), ...o });
  try {
    for (let i = 0; i < 600 && !seen.includes('online'); i++) {
      if (seen.includes('removed')) throw new Error(`link refused: ${seen.join(',')}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!seen.includes('online')) throw new Error(`never online: ${seen.join(',')}`);
    log('link-status', seen);
    return await link.request('get.state');
  } finally { link.stop(); }
}

const sha = (c) => ({ 'linux-x64': c.repeat(64), 'linux-arm64': c.repeat(64) });

async function bench() {
  const fake = fakeProvider();
  const listed = { provider: 'sandbox-api', account: 'acct-test', id: 'sb-1', name: 'computer', keepCopies: true };
  const recipe = { name: 'web', node: { version: '24.15.0', sha256: sha('a') }, install: [['npm', 'ci']],
    run: { argv: ['node', 'server.mjs'], env: { PORT: '7300' } }, workDir: '/home/user/app' };
  let grants = [];
  const host = await Host.open({ keys: keyPair(), name: 'Cloud computer', grants: { load: () => grants, save: (g) => { grants = g; } },
    confirm: () => false, handle: (r) => ({ op: r.op, machine: 'bench' }) });
  const provider = { ...fake, list: async () => [listed], exec: async (ref, argv, o) => {
    const r = await fake.exec(ref, argv, o);
    if (argv[5] === PHONE_KEY_FILE) { // the host process: bind the landed key, write its receipt
      const landed = fake.fake.machine.readFile(`${recipe.workDir}/.byokit/inbox/${PHONE_KEY_FILE}`);
      log('host-bind', await bindPhoneKey(host, landed).then((b) => ({ bound: b.bound })));
      fake.fake.machine.writeFile(`${recipe.workDir}/.byokit/outbox/${RECEIPT_FILE}`, new TextEncoder().encode(phoneReceipt(host, landed)), 0o600);
    }
    return r;
  } };
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => host.accept(ws));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  // The app's SSH transport reaches the same machine; its forward carries machine port 7300 to the host above.
  const transport = fakeSshTransport({ machine: fake.fake.machine });
  transport.loopback.set(7300, server.address().port);
  const pins = { load: async () => transport.fingerprint };
  const address = { port: 7300, transport, target: { host: 'computer.example', user: 'user' }, pins };
  const resolvers = [];
  try {
    const phone = keyPair();
    const run = async (store) => {
      const steps = [];
      let receipt;
      for await (const s of setup({ provider, store, recipe, pick: (all) => all[0], confirmId: 'sb-1', address,
        pair: pairEnrol(machine({ provider, store }), recipe, phone.publicKey) })) {
        steps.push(stepLine(s));
        if (s.step === 'pairing') receipt = s.receipt;
      }
      return { steps, receipt };
    };
    // Error case first: nothing listens on the app port yet, so securing fails before pairing and may be retried.
    const store = memoryStore();
    const early = await run(store);
    log('not-listening', early.steps);
    fake.fake.machine.listening.add(7300);
    const { steps, receipt } = await run(store);
    log('steps', steps);
    log('forwards', transport.forwards);
    log('receipt', { host: short(receipt.host), hostMatches: receipt.host === b64url(host.keys.publicKey),
      device: { ...receipt.device, id: short(receipt.device.id) }, urls: receipt.urls, ssh: routeLine(receipt.ssh), fields: Object.keys(receipt).sort() });
    const via = () => { const r = sshResolve({ transport, pins, target: receipt.ssh, port: receipt.ssh.appPort }); resolvers.push(r); return r; };
    const answer = await phoneLinks(phone, receipt, { resolve: via() });
    log('request', answer);
    // Error case: another phone holding the same receipt is refused by the host.
    const stranger = await phoneLinks(keyPair(), receipt, { resolve: via() }).then(() => 'linked (unexpected)', (e) => e.message);
    log('stranger', stranger);
    const tailscale = fake.fake.machine.runs.filter((r) => r.argv.some((a) => a.includes('tailscale'))).map((r) => r.argv.join(' '));
    log('tailscale-commands', [...new Set(tailscale)]);
    const pass = early.steps.at(-1) === 'failed:securing:state.failed:true'
      && steps.join() === 'checking-access,listing,inspecting,installing,securing:ssh:7300,pairing:receipt,ready'
      && receipt.urls.join() === 'ws://127.0.0.1:7300' && receipt.ssh?.appPort === 7300
      && answer?.machine === 'bench' && stranger.startsWith('link refused')
      && tailscale.every((c) => c === 'test -e /etc/systemd/system/tailscaled.service.d/byokit.conf');
    log('result', pass ? 'PASS' : 'FAIL');
    return pass;
  } finally {
    for (const r of resolvers) await r.close();
    host.close(); wss.close(); server.close();
  }
}

// The live host program, run on the machine by the recipe: persistent keys and grants, the inbox watch,
// bindPhoneKey + phoneReceipt, and one answer. It listens on the machine's loopback only; the phone reaches it over SSH.
const HOST = `import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { hostname, platform } from 'node:os';
import { WebSocketServer } from 'ws';
import { Host, keyPair } from '@byokit/pair';
import { bindPhoneKey, phoneReceipt } from '@byokit/cloud';
const b = (u) => Buffer.from(u).toString('base64'), u = (s) => new Uint8Array(Buffer.from(s, 'base64'));
if (!existsSync('keys.json')) { const k = keyPair(); writeFileSync('keys.json', JSON.stringify({ p: b(k.publicKey), s: b(k.secretKey) }), { mode: 0o600 }); }
const k = JSON.parse(readFileSync('keys.json', 'utf8'));
const grants = { load: () => existsSync('grants.json') ? JSON.parse(readFileSync('grants.json', 'utf8')) : [], save: (g) => writeFileSync('grants.json', JSON.stringify(g), { mode: 0o600 }) };
const host = await Host.open({ keys: { publicKey: u(k.p), secretKey: u(k.s) }, name: 'Cloud computer', grants, confirm: () => false,
  handle: (r) => { if (r.op !== 'get.state') throw new Error('unknown request'); return { machine: hostname(), platform: platform() }; } });
new WebSocketServer({ host: '127.0.0.1', port: 7300 }).on('connection', (ws) => host.accept(ws));
let done = '';
setInterval(async () => {
  let key; try { key = new Uint8Array(readFileSync('.byokit/inbox/phone.bin')); } catch { return; }
  if (b(key) === done) return;
  try {
    await bindPhoneKey(host, key);
    mkdirSync('.byokit/outbox', { recursive: true, mode: 0o700 });
    writeFileSync('.byokit/outbox/.receipt.tmp', phoneReceipt(host, key), { mode: 0o600 });
    renameSync('.byokit/outbox/.receipt.tmp', '.byokit/outbox/receipt.json');
    done = b(key);
    console.log('phone enrolled');
  } catch (e) { console.log('enrol refused:', e.code ?? 'error'); done = b(key); }
}, 500);
`;

/** From this computer to the machine's public address: refused or dropped passes; a connection fails (9.2). */
const probePublic = (host, port) => new Promise((resolve) => {
  const s = connect({ host, port });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(8000, () => done('dropped'));
  s.once('connect', () => done('accepted'));
  s.once('error', (e) => done(e.code === 'ECONNREFUSED' ? 'refused' : e.code === 'ETIMEDOUT' ? 'dropped' : e.code ?? 'error'));
});

async function live() {
  const { BOAT_KEY_FILE, EVIDENCE_DIR, CLOUD_TGZ } = process.env;
  const ssh = process.env.SSH_BIN ?? '/usr/bin/ssh';
  if (!BOAT_KEY_FILE || !EVIDENCE_DIR || !CLOUD_TGZ) { console.error('BOAT_KEY_FILE, EVIDENCE_DIR and CLOUD_TGZ are required'); return 2; }
  const key = readFileSync(BOAT_KEY_FILE, 'utf8').trim();
  const guard = (text) => { if (key && String(text).includes(key)) throw new Error('leak guard: the Boat key reached an output line'); return text; };
  const provider = boat({ baseUrl: process.env.BOAT_BASE_URL ?? 'https://boat.dev/api/v1', label: 'Boat', prices: [], key: async () => key });
  // A throwaway lab login key, by path only: never the owner's own SSH keys, never printed, removed at the end.
  const lab = mkdtempSync(join(tmpdir(), 'byokit-ssh-proof-'));
  const keyPath = join(lab, 'id_ed25519');
  const stateDir = join(lab, 'state');
  execFileSync(join(dirname(ssh), 'ssh-keygen'), ['-q', '-t', 'ed25519', '-N', '', '-C', 'byokit-ssh-proof', '-f', keyPath], { env: {}, stdio: 'ignore' });
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  const transport = sshTransport({ ssh, keyPath, stateDir });
  const tag = Math.random().toString(36).slice(2, 8);
  const name = `ssh${tag}`;
  const creator = machine({ provider, store: memoryStore() });
  let ref = null;
  let resolve = null;
  let pass = false;
  try {
    log('machines-before', (await provider.list()).length);
    ref = await creator.create({ name, size: 'small', keepCopies: false });
    writeFileSync(join(EVIDENCE_DIR, 'owned.json'), JSON.stringify({ id: ref.id, name }), { mode: 0o600 });
    log('created', { id: ref.id, name });
    for (let i = 0; i < 150 && (await creator.state()) !== 'on'; i++) await new Promise((r) => setTimeout(r, 2000));
    log('state', await creator.state());
    await provider.write(ref, '/home/user/rcpt-pkg/byokit-cloud.tgz', new Uint8Array(readFileSync(CLOUD_TGZ)), 0o644);
    const recipe = { name, workDir: `/home/user/${name}`,
      node: { version: '22.22.3', sha256: { 'linux-x64': '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f',
        'linux-arm64': '1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7' } },
      install: [['npm', 'install', '--no-audit', '--no-fund', '--save-exact', '/home/user/rcpt-pkg/byokit-cloud.tgz', '@byokit/pair@0.10.4', 'ws@8.22.0'],
        ['node', '-e', `require('node:fs').writeFileSync('host.mjs', ${JSON.stringify(HOST)}, {mode:384})`]],
      run: { argv: ['node', `/home/user/${name}/host.mjs`], env: {} } };
    // Boat lets the lab key in and names the host key; the Node transport pins through its known_hosts, so the
    // scanned key is checked against Boat's answer and confirmed before setup() dials it.
    const target = await provider.sshAccess(ref, publicKey);
    const scanned = await sshHostKey({ ssh, host: target.host, port: target.port, stateDir });
    log('sshaccess', { port: target.port, user: target.user, hostIsIp: /^[0-9.]+$/.test(target.host), fingerprint: short(target.fingerprint),
      scannedMatches: scanned.fingerprint === target.fingerprint });
    if (scanned.fingerprint !== target.fingerprint) throw new Error('the scanned host key differs from the one Boat named');
    await scanned.confirm();
    const phone = keyPair();
    const store = memoryStore();
    let receipt;
    const until = Date.now() + 10 * 60_000; // install, then the host starting to listen
    for (let round = 1; receipt === undefined && Date.now() < until; round++) {
      const steps = [];
      let last;
      for await (const s of setup({ provider, store, recipe, pick: (all) => all.find((r) => r.id === ref.id), confirmId: ref.id,
        onLine: (l) => appendFileSync(join(EVIDENCE_DIR, 'install.log'), `${guard(l)}\n`, { mode: 0o600 }),
        address: { port: 7300, transport, publicKey },
        pair: pairEnrol(machine({ provider, store }), recipe, phone.publicKey) })) {
        steps.push(stepLine(s));
        last = s;
        if (s.step === 'securing') log('securing-route', routeLine(s.route));
        if (s.step === 'pairing') receipt = s.receipt;
      }
      log(`steps-round-${round}`, steps);
      if (last?.step === 'failed' && !(last.retryable && last.at === 'securing')) break;
      if (receipt === undefined) await new Promise((r) => setTimeout(r, 5000));
    }
    if (receipt === undefined) throw new Error('setup ended without a receipt');
    log('receipt', { host: short(receipt.host), device: { ...receipt.device, id: short(receipt.device.id) }, urls: receipt.urls,
      ssh: routeLine(receipt.ssh), fields: Object.keys(receipt).sort() });
    resolve = sshResolve({ transport, pins: { load: async () => receipt.ssh.fingerprint }, target: receipt.ssh, port: receipt.ssh.appPort });
    log('resolved', (await resolve('ws://127.0.0.1:7300')).replace(/:\d+$/, ':<local port>'));
    const WebSocket = (await import('ws')).WebSocket;
    const answer = await phoneLinks(phone, receipt, { WebSocket, resolve });
    log('request-over-ssh', answer);
    const stranger = await phoneLinks(keyPair(), receipt, { WebSocket, resolve }).then(() => 'linked (unexpected)', (e) => e.message);
    log('stranger', stranger);
    const onBox = await provider.exec(ref, ['sh', '-c', 'command -v tailscale tailscaled || echo none'], { timeoutMs: 30_000 });
    log('tailscale-on-machine', onBox.stdout.trim());
    const outside = await probePublic(target.host, 7300);
    log('public-app-port', outside);
    pass = typeof answer?.machine === 'string' && stranger.startsWith('link refused') && onBox.stdout.trim() === 'none'
      && (outside === 'refused' || outside === 'dropped');
  } catch (e) {
    log('error', guard(`${e.code ?? ''} ${e.message}`));
  } finally {
    await resolve?.close();
    if (ref !== null) {
      await creator.remove(ref.id).then(() => log('removed', ref.id), (e) => log('remove-failed', guard(`${e.code} ${e.message}`)));
      log('still-listed', (await provider.list()).some((r) => r.id === ref.id));
      log('status-after', await provider.status(ref).catch((e) => `error:${e.code}`));
    }
    rmSync(lab, { recursive: true, force: true });
  }
  log('result', pass ? 'PASS' : 'FAIL');
  return pass ? 0 : 1;
}

const code = mode === 'bench' ? ((await bench()) ? 0 : 1) : mode === 'live' ? await live() : 2;
process.exit(code);
