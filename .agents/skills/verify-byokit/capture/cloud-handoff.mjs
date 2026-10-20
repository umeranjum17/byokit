// Live run, handoff and lost-create replay on boat.dev (features/cloud-handoff.md). One setup({ create }) rents a
// small sandbox while Boat's first create answer is dropped after Boat made the machine: the kit's retry must send
// the same idempotency key and get that machine back. The pair gate then uses PairContext: `run` shows the
// command sees the unit's node (its unit file's PATH), user, workDir and env; `handoff` runs the host's own pair command, which writes
// offers under names it picks and waits for each answer, after an old offer was left in the outbox. The run
// always deletes the machine it made. The Boat key is read once from the file and never printed.
// Usage (worktree root): node .agents/skills/verify-byokit/capture/cloud-handoff.mjs <boat-key-file> <cloud.tgz>
import { readFileSync } from 'node:fs';
import { boat, setup } from '@byokit/cloud';
import { memoryStore } from '@byokit/cloud/testing';

const [keyFile, tgz] = process.argv.slice(2);
if (!keyFile || !tgz) throw new Error('usage: cloud-handoff.mjs <boat-key-file> <cloud.tgz>');
const key = readFileSync(keyFile, 'utf8').trim();
const out = (label, value) => {
  const line = `${label}: ${JSON.stringify(value)}`;
  if (line.includes(key)) throw new Error('refusing to print the Boat key');
  console.log(line);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The host's own pair command: an offer under a random name, then it blocks until the words file the offer names arrives; twice.
const PAIR = `import { randomBytes } from 'node:crypto';
import { takeInbox, writeOutbox } from '@byokit/cloud/unit';
for (const n of [1, 2]) {
  const words = 'words-' + n;
  await writeOutbox(process.cwd(), 'lab-pair-' + randomBytes(4).toString('hex') + '.json', JSON.stringify({ words }));
  let got;
  while ((got = await takeInbox(process.cwd(), words)) === null) await new Promise((r) => setTimeout(r, 200));
  console.log(words + ':' + Buffer.from(got.bytes).toString());
  await got.done();
}
`;
const workDir = '/home/user/byokit-handoff-lab';
const chunks = readFileSync(tgz).toString('base64').match(/.{1,30000}/g);
const recipe = {
  name: 'handofflab', workDir,
  node: { version: '22.22.3', sha256: {
    'linux-x64': '2e5d13569282d016861fae7c8f935e741693c269101a5bebcf761a5376d1f99f',
    'linux-arm64': '1c4a9933a5e45bc88f54f70b5f91232c127ec49f1a5989d23fb85824c7adf9b7' } },
  install: [
    ...chunks.map((c, i) => ['node', '-e', `require('node:fs').${i === 0 ? 'writeFileSync' : 'appendFileSync'}('cloud.b64', ${JSON.stringify(c)})`]),
    ['node', '-e', `const fs = require('node:fs'); fs.writeFileSync('cloud.tgz', Buffer.from(fs.readFileSync('cloud.b64', 'utf8'), 'base64'))`],
    ['npm', 'install', '--no-audit', '--no-fund', '--save-exact', './cloud.tgz'],
    ['node', '-e', `require('node:fs').writeFileSync('pair.mjs', ${JSON.stringify(PAIR)}, {mode:384})`],
  ],
  run: { argv: ['node', '-e', 'setInterval(() => {}, 60000)'], env: { LAB_NAME: 'Umer' } },
};

// Drop Boat's first successful create answer after Boat made the machine, keeping its id for the check and cleanup.
let lose = 1;
const lostIds = new Set();
const lossy = async (url, init) => {
  const res = await fetch(url, init);
  if (lose > 0 && res.ok && init?.method === 'POST' && new URL(url).pathname.endsWith('/sandboxes')) {
    lose -= 1;
    const id = (await res.json().catch(() => null))?.sandbox?.id;
    if (typeof id === 'string') lostIds.add(id);
    throw new TypeError('the answer was lost');
  }
  return res;
};
const provider = boat({ baseUrl: 'https://boat.dev/api/v1', label: 'Boat', prices: [], key: async () => key, fetch: lossy });
const store = memoryStore();
const before = new Set((await provider.list()).map((r) => r.id));
let ref = null;
const seen = { offers: [], view: null, unitNodeDir: null, done: null, stale: null };
const pair = async (_ref, ctx) => {
  // `command -v node` is the node PATH picks (process.execPath would resolve a symlink such as /usr/local/bin/node).
  const view = await ctx.run(['sh', '-c', 'NODE_ON_PATH=$(command -v node) exec node -e \'console.log(JSON.stringify({ nodeOnPath: process.env.NODE_ON_PATH, node: process.version, cwd: process.cwd(), lab: process.env.LAB_NAME, user: require("node:os").userInfo().username }))\'']);
  seen.view = view.code === 0 ? JSON.parse(view.stdout) : view;
  // The node the unit runs with: its Environment PATH's first entry (a machine node in range, or the kit's pinned one).
  const unit = await provider.exec(_ref, ['sh', '-c', 'grep -h "^Environment=\\"PATH=" "$HOME/.config/systemd/user/byokit-handofflab.service" /etc/systemd/system/byokit-handofflab.service 2>/dev/null'], { timeoutMs: 30_000 });
  seen.unitNodeDir = unit.stdout.match(/PATH=([^:"]+)/)?.[1] ?? null;
  // An interrupted run's offer, left in the outbox: the handoff must never yield it.
  seen.stale = await ctx.run(['node', '--input-type=module', '-e',
    `import { writeOutbox } from '@byokit/cloud/unit'; await writeOutbox(process.cwd(), 'lab-pair-stale.json', JSON.stringify({ words: 'stale' }))`]);
  const h = await ctx.handoff(['node', 'pair.mjs'], { prefix: 'lab-pair-', timeoutMs: 120_000 });
  for await (const offer of h.offer) {
    const { words } = JSON.parse(offer.text);
    seen.offers.push({ file: offer.file.replace(/[0-9a-f]{8}/, '<random>'), words });
    if (words !== 'stale') await h.deliver(words, new TextEncoder().encode('two words'));
  }
  seen.done = await h.done;
};
let result = 'FAIL';
try {
  const steps = [];
  for await (const s of setup({ provider, store, recipe, create: { size: 'small', keepCopies: false }, pair })) {
    if (s.step === 'creating') ref = s.ref;
    steps.push(s.step === 'failed' ? `failed:${s.at}:${s.cause}:retryable=${s.retryable}` : s.step);
  }
  ref ??= (await store.load())?.ref ?? null;
  out('setup', steps);
  out('run-view', seen.view);
  out('unit-node-dir', seen.unitNodeDir);
  out('stale-offer-written', seen.stale?.code === 0);
  out('offers', seen.offers);
  out('handoff-done', seen.done);
  const fresh = (await provider.list()).map((r) => r.id).filter((id) => !before.has(id));
  out('new-machines', fresh.length);
  out('lost-answer-made-this-machine', lostIds.size === 1 && lostIds.has(ref?.id));
  const v = seen.view;
  if (JSON.stringify(steps) === JSON.stringify(['checking-access', 'creating', 'installing', 'pairing', 'ready'])
    && seen.unitNodeDir !== null && v?.nodeOnPath === `${seen.unitNodeDir}/node` && v.cwd === workDir && v.lab === 'Umer'
    && seen.stale?.code === 0
    && JSON.stringify(seen.offers.map((o) => o.words)) === JSON.stringify(['words-1', 'words-2'])
    && seen.done?.code === 0 && seen.done.stdout === 'words-1:two words\nwords-2:two words\n'
    && fresh.length === 1 && fresh[0] === ref?.id && lostIds.size === 1 && lostIds.has(ref.id)) result = 'PASS';
} finally {
  // Every id here came from this run's own create answers, so each is a machine this run made.
  const made = [...new Set([...(ref === null ? [] : [ref.id]), ...lostIds])];
  for (const id of made) {
    const r = { ...(ref ?? { provider: 'sandbox-api', account: await provider.account(), name: recipe.name, keepCopies: false }), id };
    await provider.remove(r, id);
    for (let i = 0; i < 30 && (await provider.status(r)) !== 'gone'; i++) await sleep(2000);
    out(`removed-${made.indexOf(id) + 1}`, await provider.status(r));
  }
}
out('result', result);
if (result !== 'PASS') process.exitCode = 1;
