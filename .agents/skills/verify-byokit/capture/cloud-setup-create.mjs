// Live setup({ create }) on boat.dev (features/cloud-setup-create.md). A phone-only person with no
// computer yet: one setup() rents a small sandbox, waits until it is on, installs a real `Host` from the
// packed kit, and pairs the phone; the same setup() again resumes on that machine and rents nothing. The
// machine's host takes the key with `takeInbox` and answers with `writeOutbox` (`@byokit/cloud/unit`).
// The run always deletes the machine it made. Keys show only as 12-hex fingerprints; the Boat key is read
// once from the file and never printed.
// Usage (worktree root): node .agents/skills/verify-byokit/capture/cloud-setup-create.mjs <boat-key-file> <cloud.tgz>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { boat, machine, pairEnrol, setup, words } from '@byokit/cloud';
import { memoryStore } from '@byokit/cloud/testing';
import { keyPair } from '@byokit/pair';

const [keyFile, tgz] = process.argv.slice(2);
if (!keyFile || !tgz) throw new Error('usage: cloud-setup-create.mjs <boat-key-file> <cloud.tgz>');
const key = readFileSync(keyFile, 'utf8').trim();
const out = (label, value) => {
  const line = `${label}: ${JSON.stringify(value)}`;
  if (line.includes(key)) throw new Error('refusing to print the Boat key');
  console.log(line);
};
const fp = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HOST = `import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Host, keyPair } from '@byokit/pair';
import { PHONE_KEY_FILE, RECEIPT_FILE, bindPhoneKey, phoneReceipt } from '@byokit/cloud';
import { takeInbox, writeOutbox } from '@byokit/cloud/unit';
const workDir = new URL('.', import.meta.url).pathname.replace(/\\/$/, '');
const file = workDir + '/grants.json';
const host = await Host.open({ keys: keyPair(), name: 'Cloud computer', confirm: () => false, handle: async () => ({ ok: true }),
  grants: { load: () => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [],
    save: (g) => { writeFileSync(file + '.tmp', JSON.stringify(g), { mode: 0o600 }); renameSync(file + '.tmp', file); } } });
const handled = [];
const fp = (k) => createHash('sha256').update(Buffer.from(k, 'base64url')).digest('hex').slice(0, 12);
const report = () => writeFileSync(workDir + '/state.json', JSON.stringify({ handled,
  phones: host.devices().filter((g) => g.kind === 'phone').map((g) => fp(g.key)) }));
let busy = false;
const tick = async () => {
  if (busy) return;
  busy = true;
  try {
    const got = await takeInbox(workDir, PHONE_KEY_FILE);
    if (got !== null) {
      try {
        const r = await bindPhoneKey(host, got.bytes);
        await writeOutbox(workDir, RECEIPT_FILE, phoneReceipt(host, got.bytes));
        handled.push('phone.bin:' + (r.bound ? 'bound' : 'already'));
      } catch (e) { handled.push('phone.bin:' + (e.code ?? 'error')); }
      await got.done();
    }
    report();
  } finally { busy = false; }
};
await tick();
setInterval(tick, 1000);
`;

// The packed kit travels in the install steps themselves: setup() creates the machine, so there is no
// moment between create and install to upload a file. The first chunk truncates, so a resumed install starts clean.
const chunks = readFileSync(tgz).toString('base64').match(/.{1,30000}/g);
const recipe = {
  name: 'createlab', workDir: '/home/user/byokit-create-lab',
  node: { version: '22.22.3', sha256: {
    'linux-x64': '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f',
    'linux-arm64': '1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7' } },
  install: [
    ...chunks.map((c, i) => ['node', '-e', `require('node:fs').${i === 0 ? 'writeFileSync' : 'appendFileSync'}('cloud.b64', ${JSON.stringify(c)})`]),
    ['node', '-e', `const fs = require('node:fs'); fs.writeFileSync('cloud.tgz', Buffer.from(fs.readFileSync('cloud.b64', 'utf8'), 'base64'))`],
    ['npm', 'install', '--no-audit', '--no-fund', '--save-exact', './cloud.tgz', '@byokit/pair@0.10.4'],
    ['node', '-e', `require('node:fs').writeFileSync('host.mjs', ${JSON.stringify(HOST)}, {mode:384})`],
  ],
  run: { argv: ['node', '/home/user/byokit-create-lab/host.mjs'], env: {} },
};

const provider = boat({ baseUrl: 'https://boat.dev/api/v1', label: 'Boat', prices: [], key: async () => key });
const vars = { app: 'Umer', label: 'Boat' };
const store = memoryStore();
const phone = keyPair();
out('phone', fp(phone.publicKey));
const before = new Set((await provider.list()).map((r) => r.id));
let ref = null;
const connect = async () => {
  const steps = [];
  const m = machine({ provider, store });
  for await (const s of setup({ provider, store, recipe, create: { size: 'small', keepCopies: false },
    pair: pairEnrol(m, recipe, phone.publicKey, { url: (root, host) => `${root}/link/${host}` }) })) {
    if (s.step === 'creating') { ref = s.ref; out('creating-words', words('setup.creating', vars)); }
    steps.push(s.step === 'failed' ? `failed:${s.at}:${s.cause}:retryable=${s.retryable}` : s.step === 'pairing' && s.receipt ? 'pairing:receipt' : s.step);
    if (s.step === 'failed') out('failed-words', words(s.cause, vars));
  }
  return steps;
};
const state = async () => {
  const r = await provider.exec(ref, ['cat', `${recipe.workDir}/state.json`], { timeoutMs: 30_000 });
  return r.code === 0 ? JSON.parse(r.stdout) : null;
};
let result = 'FAIL';
try {
  const first = await connect();
  out('setup-1', first);
  if (ref === null) ref = (await store.load())?.ref ?? null;
  out('host-1', await state());
  const again = await connect();
  out('setup-2', again);
  out('host-2', await state());
  const fresh = (await provider.list()).map((r) => r.id).filter((id) => !before.has(id));
  out('new-machines', fresh.length);
  out('new-machine-is-ours', fresh.length === 1 && fresh[0] === ref?.id);
  const want = ['checking-access', 'creating', 'installing', 'pairing:receipt', 'ready'];
  if (JSON.stringify(first) === JSON.stringify(want) && JSON.stringify(again) === JSON.stringify(want)
    && fresh.length === 1 && fresh[0] === ref?.id) result = 'PASS';
} finally {
  ref ??= (await store.load())?.ref ?? null;
  if (ref !== null) {
    await provider.remove(ref, ref.id);
    for (let i = 0; i < 30 && (await provider.status(ref)) !== 'gone'; i++) await sleep(2000);
    out('removed', await provider.status(ref));
  }
}
out('result', result);
if (result !== 'PASS') process.exitCode = 1;
