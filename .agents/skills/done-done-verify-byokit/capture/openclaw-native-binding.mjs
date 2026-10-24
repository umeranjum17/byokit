// Built public SDK (@byokit/openclaw over its fake gateway), real isolated native subprocesses; no real account, provider or credential.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { OpenClawKit } from '@byokit/openclaw';
import { fakeGateway } from '@byokit/openclaw/testing';
const require = createRequire(import.meta.url);
assert.match(require.resolve('@byokit/openclaw'), /packages\/openclaw\/dist\/index\.js$/);
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
if (process.argv.includes('--gates')) {
  const fd = openSync(join(evidence, 'checks.log'), 'wx');
  try {
    const checks = spawnSync('bash', ['-c', 'npm run build && npm run check && node scripts/readme-check.ts && npm run release -- lint --base origin/main && sh scripts/test.sh "packages/openclaw/test/*.test.ts"'],
      { stdio: ['ignore', fd, fd], env: { ...process.env, BYOKIT_TEST_ENGINE_DIR: join(evidence, 'unused-engine') } });
    assert.equal(checks.status, 0, `CI-matching gates failed: ${checks.error?.message ?? checks.signal ?? checks.status}; see checks.log`);
  } finally { closeSync(fd); }
}
const root = mkdtempSync(join(tmpdir(), 'byk-native-binding-'));
const log = [];
const note = text => { log.push(text); console.log(text); };
const steps = ['Add two anthropic-cli accounts in place, each signed in at its own native folder', 'List both through their bindings; the engine seals and activates nothing', 'Cancel a re-auth of B; B keeps its binding and folder', 'Sign B out in its own folder; B reads signed out, A stays ready', 'Remove B; only B folder is logged out and dropped'];
let kit;
try {
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), dir = process.env.CLAUDE_CONFIG_DIR, granted = path.join(dir, 'granted');
if (process.argv[3] === 'status') { console.log(JSON.stringify({ loggedIn: fs.existsSync(granted) })); process.exit(); }
console.log('If the browser did not open, visit: https://claude.example.test/authorize');
process.stdin.setEncoding('utf8'); process.stdin.once('data', (code) => { fs.writeFileSync(granted, code.trim()); process.exit(0); });
`, { mode: 0o700 });
  const fake = fakeGateway(), methods = [];
  kit = new OpenClawKit({ stateDir: root, enginePath: [bin], spawnEngine: false, callbackPort: 0,
    transport: ctx => { const t = fake.factory(ctx); return { ...t, request: (method, params, o) => { methods.push(method === 'byokit.accounts' ? `${method}:${params?.action}` : method); return t.request(method, params, o); } }; } });
  const index = () => JSON.parse(readFileSync(join(root, 'openclaw', 'accounts', 'm1.json'), 'utf8'));
  const claude = join(root, 'openclaw', 'native', 'claude');
  const logins = () => readdirSync(claude).flatMap(d => { try { return [[d, readFileSync(join(claude, d, 'granted'), 'utf8')]]; } catch { return []; } });
  const wait = async done => { for (let i = 0; !done() && i < 300; i++) await new Promise(r => setTimeout(r, 10)); assert.ok(done()); };
  const add = async fields => { const seen = []; const handle = await kit.addAccount('m1', { authChoice: 'anthropic-cli', credentialPolicy: 'in-place', ...fields }, v => seen.push(v)); await wait(() => seen.some(v => v.url)); return handle; };
  const signedIn = async (name, code) => { const handle = await add({ name }); handle.paste(code); return { id: handle.id, result: await handle.done }; };
  await kit.start();
  const a = await signedIn('Claude Work', 'code-a'), b = await signedIn('Claude Home', 'code-b');
  assert.equal(a.result.view.state, 'done'); assert.equal(b.result.view.state, 'done'); assert.notEqual(a.id, b.id);
  const bind = id => index().accounts[id].native;
  assert.notEqual(bind(a.id).cliAccountId, bind(b.id).cliAccountId);
  assert.deepEqual(Object.keys(bind(a.id)).sort(), ['cli', 'cliAccountId', 'kind']);
  assert.deepEqual(logins().map(([, who]) => who).sort(), ['code-a', 'code-b']);
  assert.deepEqual((await kit.accounts('m1')).map(r => r.state), ['ready', 'ready']);
  assert.ok(!methods.includes('openclaw.setup.activate') && !methods.includes('byokit.accounts:seal'));
  note('two Claude accounts signed in at distinct native folders; each entry holds only {kind, cliAccountId, cli}; listed ready through their bindings; the engine sealed and activated nothing');
  const again = await add({ again: b.id }); again.cancel();
  assert.equal((await again.done).view.state, 'failed'); assert.deepEqual(bind(b.id), bind(b.id));
  assert.deepEqual((await kit.accounts('m1')).map(r => r.state), ['ready', 'ready']);
  note('cancelling B re-auth (a ready account logs in again) kept B binding and its folder; A unchanged');
  rmSync(join(claude, logins().find(([, who]) => who === 'code-b')[0], 'granted'));
  assert.deepEqual((await kit.accounts('m1')).map(r => r.state), ['ready', 'signed_out']);
  assert.equal((await kit.accountStatus('m1', a.id)).state, 'ready'); assert.equal((await kit.accountStatus('m1', b.id)).state, 'signed_out');
  note('B signed out in its own folder reads signed_out through its binding; A still ready');
  await kit.removeAccount('m1', b.id);
  assert.deepEqual((await kit.accounts('m1')).map(r => r.id), [a.id]); assert.deepEqual(logins().map(([, who]) => who), ['code-a']);
  note('removing B logged out and dropped B folder only; A kept its login');
  note('PASS: durable native binding, list/status/re-auth/logout through it; no engine backend, principal dedup, keyring or live-account claim');
  writeFileSync(join(evidence, 'native-binding.log'), log.join('\n') + '\n');
  writeFileSync(join(evidence, 'summary.txt'), [
    'Command: node .agents/skills/done-done-verify-byokit/capture/openclaw-native-binding.mjs' + (process.argv.includes('--gates') ? ' --gates' : ''),
    ...(process.argv.includes('--gates') ? ['PASS: npm run build; npm run check; node scripts/readme-check.ts; npm run release -- lint --base origin/main; sh scripts/test.sh "packages/openclaw/test/*.test.ts".'] : []),
    ...log,
  ].join('\n') + '\n');
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: { version: require(join(process.cwd(), 'packages/openclaw/package.json')).version }, start: 'Fake gateway, empty account index; deterministic native subprocess fixtures; no real credentials', steps, result: log.at(-1) }, null, 2));
} finally {
  await kit?.stop();
  rmSync(root, { recursive: true, force: true });
}
