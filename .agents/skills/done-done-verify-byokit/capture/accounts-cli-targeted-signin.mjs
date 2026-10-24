// Built public SDK, real isolated native subprocesses; no real account, provider or credential.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { cliAccounts, remoteCliHost } from '@byokit/accounts/cli';
const require = createRequire(import.meta.url);
assert.match(require.resolve('@byokit/accounts/cli'), /packages\/accounts\/dist\/cli\.js$/);
const evidence = process.env.DONE_DONE_EVIDENCE_ROOT;
assert.ok(evidence, 'run through done-done');
const root = mkdtempSync(join(tmpdir(), 'byk-native-target-'));
const log = [];
const note = text => { log.push(text); console.log(text); };
const steps = [];
let host;
try {
  const stateDir = join(root, 'pool'), home = join(root, 'home');
  mkdirSync(stateDir); mkdirSync(home);
  const calls = join(root, 'calls.jsonl'); writeFileSync(calls, '');
  const bin = join(root, 'native-fixture');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const folder = process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ folder, argv: process.argv.slice(2) }) + '\\n');
const granted = folder + '/granted';
if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  if (fs.existsSync(folder + '/unknown')) console.log('unreadable synthetic status');
  else console.log(JSON.stringify({ loggedIn: fs.existsSync(granted), authMethod: 'claude.ai' }));
} else if (process.argv[2] === 'app-server') {
  let buf = '';
  process.stdin.on('data', chunk => {
    buf += chunk;
    while (buf.includes('\\n')) {
      const end = buf.indexOf('\\n'), r = JSON.parse(buf.slice(0, end)); buf = buf.slice(end + 1);
      console.log(JSON.stringify({ id: r.id, result: r.id === 1 ? {} : { account: fs.existsSync(granted) ? { type: 'chatgpt', email: 'umer@example.test', planType: 'plus' } : null } }));
    }
  });
} else {
  const codex = process.argv[2] === 'login';
  console.log(codex ? 'https://codex.example.test/device ABCD-EFGHI expires in 300 seconds' : 'visit: https://claude.example.test/authorize');
  if (codex) setTimeout(() => { fs.writeFileSync(granted, 'synthetic'); process.exit(0); }, 150);
  else process.stdin.once('data', () => { fs.writeFileSync(granted, 'synthetic'); process.exit(0); });
}
`, { mode: 0o755 });
  const bins = { claude: bin, codex: bin };
  const env = { HOME: home, PATH: '/unused' };
  let cli = cliAccounts({ stateDir, bins, env });
  host = remoteCliHost({ cli, bins });
  const history = () => readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  for (const provider of ['claude', 'codex']) {
    const a = (await cli.add(provider)).account.id, b = (await cli.add(provider)).account.id;
    const folders = [cli.folderOf(a), cli.folderOf(b)];
    assert.notEqual(...folders);
    const login = async id => {
      const start = await host.start(provider, { account: id }); assert.ok(start.ok);
      assert.equal(start.signIn.id, id);
      if (provider === 'claude') await host.paste(id, 'synthetic-code');
      assert.equal((await host.wait(id)).ok, true);
    };
    await login(a);
    const before = history().length;
    await login(b);
    assert.ok(history().slice(before).every(c => c.folder === folders[1]));
    assert.equal((await cli.status(a)).state, 'ready');
    assert.equal((await cli.status(b)).state, 'ready');
    const variable = provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME';
    assert.equal(cli.launchEnv(b).set[variable], folders[1]);
    assert.ok(!cli.launchEnv(b).unset.includes(variable));
    note(`${provider}: A and B signed in directly at distinct final stores; B login/status never selected A; launch descriptor preserves selected store`);
    steps.push(`Allocate two ${provider} rows, sign in A then B by exact id, check both and their launch descriptors`);
    await assert.rejects(host.start(provider, { account: 'missing' }), { code: 'unknown-account' });
    const beforeInstalled = history().length;
    await assert.rejects(host.start(provider, { account: `installed-${provider}` }), { code: 'unknown-account' });
    assert.equal(history().length, beforeInstalled, 'installed targets never launch a probe');
    await assert.rejects(host.start(provider === 'claude' ? 'codex' : 'claude', { account: b }), { code: 'kind-mismatch' });
    if (provider === 'claude') {
      writeFileSync(join(folders[0], 'unknown'), '');
      assert.equal((await cli.status(a)).state, 'unknown');
      const beforeUnknown = history().length;
      const pending = await host.start(provider, { account: b }); assert.ok(pending.ok);
      const busy = await host.start(provider, { account: a }); assert.equal(busy.error, 'busy');
      await host.cancel(b); assert.equal((await host.wait(b)).ok, false);
      assert.ok(history().slice(beforeUnknown).every(c => c.folder === folders[1]));
      assert.equal(cli.folderOf(b), folders[1]);
      assert.ok(existsSync(join(folders[1], 'granted')));
      note('claude: unknown A did not affect B; overlapping re-auth refused busy; cancelling B preserved its id, folder and native data');
      steps.push('Make A status unknown, re-auth B, refuse overlapping A, cancel B without dropping its allocated row');
      rmSync(join(folders[0], 'unknown'));
      await host.close();
      cli = cliAccounts({ stateDir, bins, env }); host = remoteCliHost({ cli, bins });
      await login(b); assert.equal(cli.folderOf(b), folders[1]);
      assert.equal((await cli.status(a)).state, 'ready');
      const legacy = await host.start(provider); assert.equal(legacy.error, 'already');
      note('claude: after restart re-auth kept the same B binding; A stayed ready; legacy provider start still answers already');
      steps.push('Restart the host and native roster, re-auth B at its original store, check A remains ready');
    }
    note(`${provider}: unknown id, installed id and wrong-provider target refused without fallback; installed target not probed`);
  }
  note('PASS: host-only exact managed sign-in prerequisite; no engine routing, principal deduplication, keyring or live-account claim');
  writeFileSync(join(evidence, 'targeted-signin.log'), log.join('\n') + '\n');
  writeFileSync(join(evidence, 'steps.json'), JSON.stringify({ target: { version: require(join(process.cwd(), 'packages/accounts/package.json')).version }, start: 'Empty isolated native roster; deterministic subprocess fixtures; no real credentials', steps, result: log.at(-1) }, null, 2));
} finally {
  await host?.close();
  rmSync(root, { recursive: true, force: true });
}
