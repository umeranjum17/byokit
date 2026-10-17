// Real OpenCode 1.x and 2.x binaries through the built `@byokit/accounts/cli`, in a decoy HOME whose own
// OpenCode sign-in (auth.json) and database (opencode.db) hold canaries, against a loopback stand-in for Go.
// Usage, from the worktree root, inside a loopback-only namespace that dies with the run:
//   unshare -rn --pid --fork --mount-proc sh -c 'ip link set lo up && exec node .agents/skills/verify-byokit/capture/accounts-cli-opencode-live.mjs <opencode-1.x> <opencode-2.x>'
// Fake keys only (sk-umer-test-A/-B); every request this run makes lands on 127.0.0.1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
const require = createRequire(join(process.cwd(), 'package.json'));
const { cliAccounts } = await import(require.resolve('@byokit/accounts/cli'));
const { launchEnv } = await import(require.resolve('@byokit/accounts/isolate'));

const [oc1, oc2] = process.argv.slice(2);
if (!oc1 || !oc2) { console.error('usage: accounts-cli-opencode-live.mjs <opencode-1.x> <opencode-2.x>'); process.exit(2); }
const KEYS = { A: 'sk-umer-test-A', B: 'sk-umer-test-B' };
const CANARY_KEY = 'sk-canary-decoy-go-auth';
const WORKSPACE = 'org_umer_test';

// No route off the machine: a Go call cannot happen even by mistake.
const egress = await new Promise((done) => {
  const s = connect({ host: '1.1.1.1', port: 443, timeout: 3000 });
  s.once('connect', () => { s.destroy(); done('open'); });
  s.once('timeout', () => { s.destroy(); done('timeout'); });
  s.once('error', (e) => done(e.code));
});
assert.notEqual(egress, 'open', 'run this inside the loopback-only namespace');
console.log(`egress: blocked (${egress})`);

// Go stand-in: one streamed "pong"; each request waits until both accounts are talking (or 20 s), so a pass means both ran at once.
const requests = []; const seen = new Set(); const waiting = [];
const fake = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const key = auth === `Bearer ${KEYS.A}` ? 'A' : auth === `Bearer ${KEYS.B}` ? 'B' : auth.includes(CANARY_KEY) ? 'canary' : auth ? 'other' : 'none';
    requests.push({ path: req.url, key, workspace: req.headers['x-opencode-org-id'] ?? null, leg: fake.leg });
    seen.add(key);
    const answer = () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'fake-model' };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    };
    if (!fake.barrier || (seen.has('A') && seen.has('B'))) { waiting.splice(0).forEach((f) => f()); answer(); return; }
    const t = setTimeout(() => { fake.timedOut = true; waiting.splice(waiting.indexOf(go), 1); answer(); }, 20_000);
    const go = () => { clearTimeout(t); answer(); };
    waiting.push(go);
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const port = fake.address().port;

const files = (dir) => existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => relative(dir, join(d.parentPath, d.name))).sort() : [];
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const store = () => { const m = new Map(); return { get: async (k) => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); }, delete: async (k) => m.delete(k) }; };
function run(argv, env, cwd) {
  return new Promise((done) => {
    const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { out += c; });
    const t = setTimeout(() => child.kill('SIGKILL'), 90_000);
    child.once('close', (code) => { clearTimeout(t); done({ code, out }); });
  });
}

const root = mkdtempSync(join(tmpdir(), 'byk-oc-live-'));
let failed = false;
try {
  for (const [label, bin] of [['1.x', oc1], ['2.x', oc2]]) {
    const leg = join(root, label); const home = join(leg, 'home'); const project = join(leg, 'project');
    // The person's own OpenCode: a Go sign-in and a database, both canaries.
    const own = join(home, '.local', 'share', 'opencode'); mkdirSync(own, { recursive: true }); mkdirSync(project);
    writeFileSync(join(own, 'auth.json'), JSON.stringify({ 'opencode-go': { type: 'api', key: CANARY_KEY } }));
    writeFileSync(join(own, 'opencode.db'), 'canary-decoy-opencode-db');
    const before = { auth: sha(join(own, 'auth.json')), db: sha(join(own, 'opencode.db')), tree: files(home) };
    // The app's project points the Go provider at the stand-in; the kit's own config brings the key.
    writeFileSync(join(project, 'opencode.json'), JSON.stringify({ autoupdate: false, share: 'disabled', model: 'opencode-go/fake-model', small_model: 'opencode-go/fake-model',
      provider: { 'opencode-go': { npm: '@ai-sdk/openai-compatible', name: 'Go stand-in', options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { 'fake-model': { name: 'fake' } } } } }));

    const kit = cliAccounts({ stateDir: join(leg, 'plans'), bins: { opencode: bin }, env: { HOME: home, PATH: '/usr/bin:/bin' }, keyStore: store(),
      fetch: async (u) => { throw new Error(`no console call expected: ${u}`); } });
    const ids = {};
    for (const who of ['A', 'B']) {
      const { account } = await kit.add('opencode');
      await kit.saveKey(account.id, KEYS[who], { workspace: WORKSPACE });
      ids[who] = account.id;
    }
    const launched = {};
    for (const who of ['A', 'B']) {
      const l = await kit.launch(ids[who]); assert.equal(l.ok, true); launched[who] = l;
      const folder = kit.folderOf(ids[who]);
      for (const [name, sub] of [['XDG_DATA_HOME', 'data'], ['XDG_STATE_HOME', 'state'], ['XDG_CACHE_HOME', 'cache']]) assert.equal(l.set[name], join(folder, sub));
    }
    // The app passes --standalone itself on 2.x, as the kit's README tells it to.
    const standalone = label === '2.x' ? ['--standalone'] : [];
    // Both accounts at once, the way an app starts them: the launch env over the app's own, argv `bin run ...args`.
    fake.leg = label; fake.barrier = true; fake.timedOut = false; seen.clear();
    const start = (who, args) => run([bin, 'run', ...args, '-m', 'opencode-go/fake-model', `say pong from account ${who}`],
      launchEnv({ base: { PATH: '/usr/bin:/bin', HOME: home, TERM: 'dumb' }, account: launched[who] }).env, project);
    const [a, b] = await Promise.all([start('A', standalone), start('B', standalone)]);
    fake.barrier = false;
    for (const [who, r] of [['A', a], ['B', b]]) {
      assert.equal(r.code, 0, `${label} account ${who} run: ${r.out.slice(-400)}`);
      assert.match(r.out, /pong/);
    }
    assert.equal(fake.timedOut, false, `${label}: both accounts reached the stand-in at the same time`);
    const legRequests = requests.filter((r) => r.leg === label);
    for (const r of legRequests) {
      assert.ok(r.key === 'A' || r.key === 'B', `${label}: a request carried ${r.key}, not one of the two account keys`);
      assert.equal(r.workspace, WORKSPACE);
    }
    assert.ok(legRequests.some((r) => r.key === 'A') && legRequests.some((r) => r.key === 'B'));
    console.log(`${label}: both accounts ran at once; ${legRequests.length} requests, each with its own key and workspace, none with the decoy key`);
    const after = { auth: sha(join(own, 'auth.json')), db: sha(join(own, 'opencode.db')), tree: files(home) };
    assert.equal(after.auth, before.auth, `${label}: decoy auth.json changed`);
    assert.equal(after.db, before.db, `${label}: decoy opencode.db changed`);
    const added = after.tree.filter((f) => !before.tree.includes(f));
    assert.ok(!added.some((f) => /^\.local\/(share|state)\/opencode\/|^\.cache\/opencode\//.test(f)), `${label}: wrote into the person's OpenCode roots: ${added}`);
    console.log(`${label}: decoy auth.json and opencode.db hashes unchanged; new decoy files outside the OpenCode data roots: ${JSON.stringify(added)}`);

    // Extreme case: remove leaves no data root behind.
    for (const who of ['A', 'B']) {
      const folder = kit.folderOf(ids[who]);
      await kit.remove(ids[who]);
      assert.equal(existsSync(folder), false, `${label}: remove left ${folder}`);
    }
    assert.deepEqual(files(join(leg, 'plans', 'opencode')), [], `${label}: remove left account files`);
    console.log(`${label}: remove deleted both accounts' data, state and cache roots`);
  }
  console.log(`requests: ${requests.length}, all on 127.0.0.1:${port}; decoy key seen: ${requests.some((r) => r.key === 'canary')}`);
  console.log('PASS');
} catch (e) { failed = true; console.error('FAIL', e.message); }
finally { fake.close(); rmSync(root, { recursive: true, force: true }); }
process.exit(failed ? 1 : 0);
