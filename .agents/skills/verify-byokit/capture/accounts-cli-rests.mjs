// Built public entry: rest → status resting → launch refused; expiry and corrupt rewrite.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const require = createRequire(join(process.cwd(), 'package.json'));
const { cliAccounts } = await import(require.resolve('@byokit/accounts/cli'));
const { say, clock } = await import(require.resolve('@byokit/accounts'));
const root = mkdtempSync(join(tmpdir(), 'byk-cli-rests-'));
const bin = join(root, 'claude');
const home = join(root, 'home'); mkdirSync(home);
writeFileSync(bin, `#!${process.execPath}
console.log(JSON.stringify({loggedIn:true,email:'umer.work@example.test',subscriptionType:'pro'}));
`, { mode: 0o700 });
try {
  const accounts = cliAccounts({ stateDir: join(root, 'accounts'), bins: { claude: bin }, env: { HOME: home, PATH: root } });
  const { account, signIn } = await accounts.add('claude');
  writeFileSync(signIn.completion, 'complete', { mode: 0o600 });
  await accounts.rename(account.id, 'Umer');
  const until = Date.now() + 3_600_000;
  const resting = await accounts.rest(account.id, { until, why: 'rate_limit' });
  assert.equal(resting.state, 'resting');
  assert.equal(resting.until, until);
  console.log('cli-rest-status:', resting.state, resting.until);
  const restsPath = join(root, 'accounts', 'rests-v1.json');
  assert.equal(statSync(restsPath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(restsPath, 'utf8')), { version: 1, rests: [{ id: account.id, until, why: 'rate_limit' }] });
  console.log('cli-rest-file: 0600 ok');
  const refused = await accounts.launch(account.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'resting');
  assert.equal(refused.message, say('status.resting', { name: 'Umer', until: clock(until) }));
  assert.ok(!('set' in refused) && !('unset' in refused));
  console.log('cli-rest-launch:', JSON.stringify(refused));
  writeFileSync(restsPath, JSON.stringify({ version: 1, rests: [{ id: account.id, until: Date.now() - 1, why: 'rate_limit' }] }), { mode: 0o600 });
  assert.equal((await accounts.status(account.id)).state, 'ready');
  assert.equal((await accounts.launch(account.id)).ok, true);
  await accounts.rest(account.id, { until: Date.now() + 60_000, why: 'rate_limit' });
  assert.deepEqual(JSON.parse(readFileSync(restsPath, 'utf8')).rests.map((r) => r.id), [account.id]);
  console.log('cli-rest-expiry: ready after until; pruned on write');
  await accounts.unrest(account.id);
  writeFileSync(restsPath, '{not-json', { mode: 0o600 });
  assert.equal((await accounts.status(account.id)).state, 'ready');
  assert.deepEqual(JSON.parse(readFileSync(restsPath, 'utf8')), { version: 1, rests: [] });
  assert.equal(statSync(restsPath).mode & 0o777, 0o600);
  console.log('cli-rest-corrupt: rewritten empty 0600');
} finally {
  rmSync(root, { recursive: true, force: true });
}
