// Built public entries, task-owned CLI processes and the existing socket Herdr stand-in.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(join(process.cwd(), 'package.json'));
const { cliAccounts } = await import(require.resolve('@byokit/accounts/cli'));
const { launchEnv } = await import(require.resolve('@byokit/accounts/isolate'));
const { HerdrKit } = await import(require.resolve('@byokit/herdr'));
const { startFakeHerdr } = await import(require.resolve('@byokit/herdr/testing'));
const root = mkdtempSync('/tmp/byk-p12-');
const bin = join(root, 'claude'), log = join(root, 'calls.jsonl');
const home = join(root, 'home'); mkdirSync(home);
writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const folder = process.env.CLAUDE_CONFIG_DIR;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({args:process.argv.slice(2),folder,home:process.env.HOME,key:!!process.env.ANTHROPIC_API_KEY})+'\\n');
const loggedIn = !!folder && fs.existsSync(folder+'/ready');
if (folder && fs.existsSync(folder+'/race')) fs.rmSync(folder+'/ready', {force:true});
console.log(JSON.stringify({loggedIn}));
`, { mode: 0o700 });
const oldPath = process.env.PATH; process.env.PATH = root;
const fake = await startFakeHerdr({ dir: join(root, 'herdr'), world: { kinds: ['claude'] } });
const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
try {
  await kit.start();
  const accounts = cliAccounts({ stateDir: join(root, 'accounts'), bins: { claude: bin }, env: { HOME: home, PATH: root, ANTHROPIC_API_KEY: 'fixture-only' } });
  const { account, signIn } = await accounts.add('claude');
  const folder = signIn.env.CLAUDE_CONFIG_DIR;
  writeFileSync(signIn.completion, 'complete');
  await accounts.rename(account.id, 'Umer');
  const source = structuredClone(fake.world.agents.find(a => a.pane_id === 'w1:p2'));
  const panes = structuredClone(fake.world.panes);
  if (process.argv.includes('--baseline')) {
    console.log('baseline launch API:', typeof accounts.launch);
    console.log('baseline signed-out move:', await kit.moveToAccount({ paneId: source.pane_id }, { provider: 'claude', folder, name: 'Umer', timeoutMs: 500 }));
    assert.equal(typeof accounts.launch, 'function', 'MS-S3 launch missing');
  }
  const refused = await accounts.launch(account.id);
  console.log('launch refusal:', JSON.stringify(refused));
  assert.equal(refused.ok, false); assert.equal(refused.code, 'signed_out');
  assert.equal(refused.message, 'Sign in to Umer first.');
  assert.ok(!('set' in refused) && !('unset' in refused));
  const missing = await cliAccounts({ stateDir: join(root, 'accounts'), bins: {}, env: { HOME: home, PATH: root } }).launch(account.id);
  assert.equal(missing.code, 'not_included'); assert.equal(missing.message, "Umer can't start on this computer yet.");
  console.log('missing binary:', missing.code, missing.message);
  const moved = await kit.moveToAccount({ paneId: source.pane_id }, { provider: 'claude', folder, name: 'Umer', timeoutMs: 500 });
  console.log('move refusal:', JSON.stringify(moved));
  assert.deepEqual(moved, { ok: false, code: 'signed_out', message: 'Sign in to Umer first.', live: source.pane_id });
  assert.deepEqual(fake.world.panes, panes); assert.deepEqual(fake.world.agents.find(a => a.pane_id === source.pane_id), source);
  console.log('zero pane creates; original unchanged');
  writeFileSync(join(folder, 'ready'), 'fixture');
  const ready = await accounts.launch(account.id); assert.equal(ready.ok, true);
  rmSync(join(folder, 'ready'));
  const child = spawnSync(bin, [], { encoding: 'utf8', env: launchEnv({ base: { HOME: home, PATH: root, ANTHROPIC_API_KEY: 'fixture-only' }, account: ready }).env });
  assert.equal(child.status, 0); assert.equal(JSON.parse(child.stdout).loggedIn, false);
  assert.equal(existsSync(join(folder, 'ready')), false);
  console.log('check/start race: signed out in selected managed folder');
  writeFileSync(join(folder, 'ready'), 'fixture'); writeFileSync(join(folder, 'race'), 'fixture');
  fake.agentStartFaults.push({ code: 'fixture_signed_out' });
  const raced = await kit.moveToAccount({ paneId: source.pane_id }, { provider: 'claude', folder, timeoutMs: 500 });
  assert.equal(raced.code, 'start_failed'); assert.equal(existsSync(join(folder, 'ready')), false);
  assert.deepEqual(fake.world.panes, panes); assert.deepEqual(fake.world.agents.find(a => a.pane_id === source.pane_id), source);
  console.log('move check/start race:', JSON.stringify(raced), 'replacement cleaned; source unchanged');
  const probes = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(probes.every(p => p.folder === folder && !p.key));
  assert.ok(probes.some(p => p.args.includes('status') && p.home === folder));
  console.log('no default-login probe; provider override absent; managed-folder isolation: OK');
} finally {
  await kit.stop(); await fake.stop(); process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true });
}
