#!/usr/bin/env node
// Phone receipt proof driver (features/cloud-phone-enrol.md): setup() with `address` and `pairEnrol` from the
// built @byokit/cloud, then the "phone" (this process) opens a real @byokit/pair DeviceLink holding only its own
// secret key and the receipt the `pairing` step carried, and makes one request over it.
//
//   bench: node cloud-pair-receipt.mjs bench
//     fakeProvider() machine with a scripted joined tailnet; the host process runs here with a real Host; a
//     resolver stands in for MagicDNS + `tailscale serve` (the tailnet name maps to a loopback listener).
//   live:  BOAT_KEY_FILE=<file> EVIDENCE_DIR=<outside the repo> CLOUD_TGZ=<npm pack of packages/cloud>
//          node cloud-pair-receipt.mjs live
//     Creates ONE Boat machine (recorded in EVIDENCE_DIR/owned.json before anything else), installs a small pair
//     host from CLOUD_TGZ + @byokit/pair, runs setup() against it (the person signs the machine into their
//     tailnet: the link goes to stdout and EVIDENCE_DIR/login-link.txt), links from this computer over the
//     tailnet, then ALWAYS logs the machine out of the tailnet and deletes it. Never prints the Boat key.
// Exit 0 = PASS, 1 = FAIL, 2 = bad setup.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { boat, machine, pairEnrol, phoneReceipt, bindPhoneKey, setup, PHONE_KEY_FILE, RECEIPT_FILE } from '@byokit/cloud';
import { fakeProvider, memoryStore } from '@byokit/cloud/testing';
import { DeviceLink, Host, b64url, keyPair } from '@byokit/pair';

const mode = process.argv[2];
const log = (label, value) => {
  const line = `${new Date().toISOString()} ${label}: ${JSON.stringify(value)}`;
  console.log(line);
  if (process.env.EVIDENCE_DIR) appendFileSync(join(process.env.EVIDENCE_DIR, 'drive.log'), `${line}\n`, { mode: 0o600 });
};
const short = (s) => `${s.slice(0, 6)}…`; // public key / id prefix only, enough to compare
const stepLine = (s) => s.step === 'failed' ? `failed:${s.at}:${s.cause}:${s.retryable}`
  : s.step === 'securing' ? `securing:${s.name}`
  : s.step === 'pairing' ? `pairing:${s.receipt ? 'receipt' : 'none'}` : s.step;

/** The phone side: only its own key pair and the receipt. Resolves the answer to one request. */
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
  const ok = (stdout) => ({ code: 0, stdout, stderr: '', timedOut: false });
  const served = new Map();
  let serveJson = () => JSON.stringify({ TCP: Object.fromEntries([...served].map(([p, to]) => [p, { TCPForward: to }])) });
  const provider = { ...fake, list: async () => [listed], exec: async (ref, argv, o) => {
    if (argv[0] === 'systemctl' && argv[1] === 'is-active') return ok('');
    if (argv[0] === 'tailscale' && argv[1] === 'status') return ok(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'computer.tail-test.ts.net.' } }));
    if (argv[0] === 'tailscale' && argv[2] === '--bg') { served.set(argv[3].slice(6), argv[4].slice(6)); return ok(''); }
    if (argv[0] === 'tailscale' && argv[2] === 'status') return ok(serveJson());
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
  const loopback = `ws://127.0.0.1:${server.address().port}`;
  try {
    const phone = keyPair();
    const store = memoryStore();
    let receipt;
    const steps = [];
    for await (const s of setup({ provider, store, recipe, pick: (all) => all[0], confirmId: 'sb-1',
      address: { hostname: 'computer', port: 7300 }, pair: pairEnrol(machine({ provider, store }), recipe, phone.publicKey) })) {
      steps.push(stepLine(s));
      if (s.step === 'pairing') receipt = s.receipt;
    }
    log('steps', steps);
    log('serve', [...served]);
    log('receipt', { host: short(receipt.host), hostMatches: receipt.host === b64url(host.keys.publicKey),
      device: { ...receipt.device, id: short(receipt.device.id) }, urls: receipt.urls, fields: Object.keys(receipt).sort() });
    const answer = await phoneLinks(phone, receipt, { resolve: (u) => u.replace('ws://computer.tail-test.ts.net:7300', loopback) });
    log('request', answer);
    // Error case: another phone holding the same receipt is refused by the host.
    const stranger = await phoneLinks(keyPair(), receipt, { resolve: (u) => u.replace('ws://computer.tail-test.ts.net:7300', loopback) })
      .then(() => 'linked (unexpected)', (e) => e.message);
    log('stranger', stranger);
    // Error case: a private route that does not read back fails at securing, before pairing.
    serveJson = () => '{}';
    const fresh = fakeProvider();
    const p2 = { ...provider, exec: async (ref, argv, o) => (argv[0] === 'tailscale' || argv[1] === 'is-active') ? provider.exec(ref, argv, o) : fresh.exec(ref, argv, o) };
    const s2 = memoryStore();
    const again = [];
    for await (const s of setup({ provider: p2, store: s2, recipe, pick: (all) => all[0], confirmId: 'sb-1',
      address: { hostname: 'computer', port: 7300 }, pair: pairEnrol(machine({ provider: p2, store: s2 }), recipe, phone.publicKey) })) again.push(stepLine(s));
    log('unserved', again);
    const pass = steps.join() === 'checking-access,listing,inspecting,installing,securing:computer.tail-test.ts.net,pairing:receipt,ready'
      && answer?.machine === 'bench' && stranger.startsWith('link refused') && again.at(-1) === 'failed:securing:state.failed:true';
    log('result', pass ? 'PASS' : 'FAIL');
    return pass;
  } finally { host.close(); wss.close(); server.close(); }
}

// The live host program, run on the machine by the recipe: persistent keys and grants, the inbox watch,
// bindPhoneKey + phoneReceipt, and one answer. It listens on loopback only; setup() serves it on the tailnet.
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

async function live() {
  const { BOAT_KEY_FILE, EVIDENCE_DIR, CLOUD_TGZ } = process.env;
  if (!BOAT_KEY_FILE || !EVIDENCE_DIR || !CLOUD_TGZ) { console.error('BOAT_KEY_FILE, EVIDENCE_DIR and CLOUD_TGZ are required'); return 2; }
  const key = readFileSync(BOAT_KEY_FILE, 'utf8').trim();
  const guard = (text) => { if (key && String(text).includes(key)) throw new Error('leak guard: the Boat key reached an output line'); return text; };
  const provider = boat({ baseUrl: process.env.BOAT_BASE_URL ?? 'https://boat.dev/api/v1', label: 'Boat', prices: [], key: async () => key });
  const tag = Math.random().toString(36).slice(2, 8);
  const name = `rcpt${tag}`;
  const creator = machine({ provider, store: memoryStore() });
  let ref = null;
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
    const phone = keyPair();
    const store = memoryStore();
    const until = Date.now() + 30 * 60_000; // the person may take a while to sign the machine in
    let receipt;
    let links = 0;
    for (let round = 1; receipt === undefined && Date.now() < until; round++) {
      const steps = [];
      let last;
      for await (const s of setup({ provider, store, recipe, pick: (all) => all.find((r) => r.id === ref.id), confirmId: ref.id,
        onLine: (l) => appendFileSync(join(EVIDENCE_DIR, 'install.log'), `${guard(l)}\n`, { mode: 0o600 }),
        address: { hostname: name, port: 7300, onStep: (t) => {
          log('tailnet-step', t.step === 'open-page' ? { step: t.step, n: ++links } : t);
          if (t.step === 'open-page') { writeFileSync(join(EVIDENCE_DIR, 'login-link.txt'), `${t.url}\n`, { mode: 0o600 }); console.log(`SIGN-IN LINK: ${t.url}`); }
        } },
        pair: pairEnrol(machine({ provider, store }), recipe, phone.publicKey) })) {
        steps.push(stepLine(s));
        last = s;
        if (s.step === 'pairing') receipt = s.receipt;
      }
      log(`steps-round-${round}`, steps);
      if (last?.step === 'failed' && !(last.retryable && last.at === 'securing')) break;
    }
    if (receipt === undefined) throw new Error('setup ended without a receipt');
    log('receipt', { host: short(receipt.host), device: { ...receipt.device, id: short(receipt.device.id) }, urls: receipt.urls, fields: Object.keys(receipt).sort() });
    log('serve-status', JSON.parse((await provider.exec(ref, ['tailscale', 'serve', 'status', '--json'], { root: true, timeoutMs: 30_000 })).stdout));
    const answer = await phoneLinks(phone, receipt, { WebSocket: (await import('ws')).WebSocket });
    log('request-over-tailnet', answer);
    const stranger = await phoneLinks(keyPair(), receipt, { WebSocket: (await import('ws')).WebSocket }).then(() => 'linked (unexpected)', (e) => e.message);
    log('stranger', stranger);
    pass = typeof answer?.machine === 'string' && stranger.startsWith('link refused');
  } catch (e) {
    log('error', guard(`${e.code ?? ''} ${e.message}`));
  } finally {
    if (ref !== null) {
      const out = await provider.exec(ref, ['tailscale', 'logout'], { root: true, timeoutMs: 60_000 }).catch((e) => ({ code: -1, stderr: e.message }));
      log('tailnet-logout', { code: out.code, stderr: guard(String(out.stderr ?? '').slice(-200)) });
      await creator.remove(ref.id).then(() => log('removed', ref.id), (e) => log('remove-failed', guard(`${e.code} ${e.message}`)));
      log('still-listed', (await provider.list()).some((r) => r.id === ref.id));
    }
  }
  log('result', pass ? 'PASS' : 'FAIL');
  return pass ? 0 : 1;
}

const code = mode === 'bench' ? ((await bench()) ? 0 : 1) : mode === 'live' ? await live() : 2;
process.exit(code);
