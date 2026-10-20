// Live owner re-enrol on boat.dev (features/cloud-phone-enrol.md, Live run). One small sandbox this run
// creates and always deletes: phone A sets it up, a reinstalled app (empty store, phone B) gets the typed
// `error.ownerEnrolled` cause, then the confirmed `replaceOwner: true` setup moves the owner to B, and a
// restart of the unit keeps B only. The machine's host is a real `Host` with a file grant store that
// handles its inbox with `bindPhoneKey`/`replacePhoneKey` and writes the pairing receipt. Keys show only as 12-hex fingerprints; the
// Boat key is read once from the file, never printed.
// Usage (worktree root): node .agents/skills/done-done-verify-byokit/capture/cloud-owner-reenrol.mjs <boat-key-file> [cloud.tgz]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { boat, deliverPhoneKey, machine, pairEnrol, setup, words } from '@byokit/cloud';
import { memoryStore } from '@byokit/cloud/testing';
import { keyPair } from '@byokit/pair';

const [keyFile, tgz] = process.argv.slice(2);
if (!keyFile) throw new Error('usage: cloud-owner-reenrol.mjs <boat-key-file> [cloud.tgz]');
const key = readFileSync(keyFile, 'utf8').trim();
const out = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const fp = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = `import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Host, keyPair } from '@byokit/pair';
import { OWNER_KEY_FILE, PHONE_KEY_FILE, RECEIPT_FILE, bindPhoneKey, phoneReceipt, replacePhoneKey } from '@byokit/cloud';
const here = new URL('.', import.meta.url).pathname;
const file = here + 'grants.json';
const host = await Host.open({ keys: keyPair(), name: 'Cloud computer', confirm: () => false, handle: async () => ({ ok: true }),
  grants: { load: () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [],
    save: (g) => { writeFileSync(file + '.tmp', JSON.stringify(g), { mode: 0o600 }); renameSync(file + '.tmp', file); } } });
const started = Date.now();
const handled = [];
const fp = (k) => createHash('sha256').update(Buffer.from(k, 'base64url')).digest('hex').slice(0, 12);
const report = () => writeFileSync(here + 'state.json', JSON.stringify({ started, handled,
  phones: host.devices().filter((g) => g.kind === 'phone').map((g) => fp(g.key)) }));
let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try {
    for (const name of [OWNER_KEY_FILE, PHONE_KEY_FILE]) {
      let bytes;
      try { bytes = new Uint8Array(readFileSync(here + '.byokit/inbox/' + name)); } catch { continue; }
      try {
        const r = name === OWNER_KEY_FILE ? await replacePhoneKey(host, bytes) : await bindPhoneKey(host, bytes);
        mkdirSync(here + '.byokit/outbox', { recursive: true, mode: 0o700 });
        writeFileSync(here + '.byokit/outbox/.receipt.tmp', phoneReceipt(host, bytes), { mode: 0o600 });
        renameSync(here + '.byokit/outbox/.receipt.tmp', here + '.byokit/outbox/' + RECEIPT_FILE);
        handled.push(name + ':' + (r.bound ? 'bound' : 'already'));
      }
      catch (e) { handled.push(name + ':' + (e.code ?? 'error')); }
      rmSync(here + '.byokit/inbox/' + name, { force: true });
    }
    report();
  } finally { busy = false; }
};
await tick();
setInterval(tick, 1000);
`;

const recipe = {
  name: 'ownerlab', workDir: '/home/user/byokit-owner-lab',
  node: { version: '22.22.3', sha256: {
    'linux-x64': '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f',
    'linux-arm64': '1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7' } },
  install: [
    ['npm', 'install', '--no-audit', '--no-fund', '--save-exact', tgz ? '/home/user/byokit-cloud-lab.tgz' : '@byokit/cloud@next', '@byokit/pair@0.10.4'],
    ['node', '-e', `require('node:fs').writeFileSync('host.mjs', ${JSON.stringify(HOST)}, {mode:384})`],
  ],
  run: { argv: ['node', '/home/user/byokit-owner-lab/host.mjs'], env: {} },
};

const provider = boat({ baseUrl: 'https://boat.dev/api/v1', label: 'Boat', prices: [], key: async () => key });
const vars = { app: 'Umer', label: 'Boat' };
let ref = null;
try {
  ref = await provider.create({ name: 'ownerlab', size: 'small', keepCopies: false, idempotencyKey: `byokit-ownerlab-${Date.now()}` });
  out('created', true);
  for (let i = 0; i < 60 && (await provider.status(ref)) !== 'on'; i++) await sleep(5000);
  if (tgz) await provider.write(ref, '/home/user/byokit-cloud-lab.tgz', new Uint8Array(readFileSync(tgz)), 0o644);
  const state = async () => {
    const r = await provider.exec(ref, ['cat', `${recipe.workDir}/state.json`], { timeoutMs: 30_000 });
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  };
  const until = async (label, ok) => {
    for (let i = 0; i < 60; i++) {
      const s = await state();
      if (s !== null && ok(s)) { out(label, { phones: s.phones, handled: s.handled }); return s; }
      await sleep(2000);
    }
    throw new Error(`${label}: the host never reached the expected grants`);
  };
  const connect = async (phone, replaceOwner) => {
    const store = memoryStore();
    const m = machine({ provider, store });
    const steps = [];
    for await (const s of setup({ provider, store, recipe, pick: (all) => all.find((r) => r.id === ref.id), confirmId: ref.id,
      pair: pairEnrol(m, recipe, phone.publicKey), ...(replaceOwner ? { replaceOwner } : {}) })) {
      steps.push(s.step === 'failed' ? `failed:${s.at}:${s.cause}:retryable=${s.retryable}` : s.step === 'pairing' && s.receipt ? 'pairing:receipt' : s.step);
      if (s.step === 'failed') out('failed-words', words(s.cause, vars));
    }
    return { steps, m };
  };
  const a = keyPair();
  const b = keyPair();
  out('phone-a', fp(a.publicKey));
  out('phone-b', fp(b.publicKey));

  out('setup-a', (await connect(a)).steps);
  await until('host-a', (s) => s.phones.length === 1 && s.phones[0] === fp(a.publicKey));

  out('setup-b', (await connect(b)).steps);
  const after = await state();
  out('unchanged-after-refusal', after.phones.length === 1 && after.phones[0] === fp(a.publicKey));

  const owner = await connect(b, true);
  out('setup-b-replace', owner.steps);
  const swapped = await until('host-b', (s) => s.phones.length === 1 && s.phones[0] === fp(b.publicKey));

  const restart = await provider.exec(ref, ['systemctl', 'restart', `byokit-${recipe.name}.service`], { timeoutMs: 60_000, root: true });
  out('restart-exit', restart.code);
  await until('after-restart', (s) => s.started > swapped.started && s.phones.length === 1 && s.phones[0] === fp(b.publicKey));
  // A plain phone.bin delivery of the old key can never take the computer back.
  await deliverPhoneKey(owner.m, recipe, a.publicKey);
  await until('stale-a-refused', (s) => s.handled.includes('phone.bin:owner-enrolled') && s.phones[0] === fp(b.publicKey));
} finally {
  if (ref !== null) {
    await provider.remove(ref, ref.id);
    out('removed', await provider.status(ref));
  }
}
out('leaks', false);
