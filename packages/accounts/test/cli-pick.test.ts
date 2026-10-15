// A pool owner asks one function which managed CLI account a run should start on, and reads the same rows a list
// would show. The roster lives in a throwaway state root, the CLIs are scripted stubs, and room comes from the real
// `@byokit/usage` reader over a scripted transport (Claude folder + headers) and a fake Codex app-server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cliAccounts, type CliAccount } from '../src/cli.ts';
import { usage } from '@byokit/usage';
import { fakeCodex, fakeFetch } from '@byokit/usage/testing';
import { scratchDir } from '../../test-support.ts';

const HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'byokit-test/1' };
const claudeRoom = (left: number) => ({ five_hour: { used_percentage: 100 - left } });
const codexRaw = (usedPercent: number) => ({ account: { email: 'umer@example.test', planType: 'plus' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_788_616_800 } } } });

/** A Claude stub: `auth status` is signed in unless the managed folder holds a `signed-out` file. */
function fakeClaude(dir: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const out = fs.existsSync(process.env.CLAUDE_CONFIG_DIR + '/signed-out');
if (process.argv[2] === 'auth' && process.argv[3] === 'status') console.log(JSON.stringify({ loggedIn: !out, email: 'umer@example.test', subscriptionType: 'max' }));
`, { mode: 0o755 });
  return bin;
}

test('pick ranks ready CLI rows by room, honors prefer, skips resting and signed-out rows, and returns readings', async () => {
  const root = scratchDir('cli-pick'); const stateDir = join(root, 'plans');
  const home = join(root, 'home'); mkdirSync(home);
  const claude = fakeClaude(join(root, 'bin'));
  const codex = fakeCodex({ dir: join(root, 'codex'), raw: codexRaw(90) });
  const http = fakeFetch([{ body: claudeRoom(20) }, { body: claudeRoom(80) }, { body: claudeRoom(40) }]);
  const kit = cliAccounts({ stateDir, bins: { claude, codex: codex.bin }, env: { HOME: home, PATH: '/unused' },
    claudeHeaders: HEADERS, usage: usage({ stateDir, fetch: http.fetch }) });

  /** Add one signed-in managed account; `credentials` also gives the Claude folder a readable usage credential. */
  const ready = async (provider: 'claude' | 'codex', credentials = true): Promise<CliAccount> => {
    const { account } = await kit.add(provider);
    const folder = kit.launchEnv(account.id).set[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME']!;
    writeFileSync(join(folder, '.byokit-signin-complete'), '');
    if (provider === 'claude' && credentials) writeFileSync(join(folder, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token', expiresAt: Date.now() + 3_600_000 } }));
    return account;
  };

  const [thin, roomy, middle] = [await ready('claude'), await ready('claude'), await ready('claude')];
  const chatgpt = await ready('codex');

  // Most room wins, every row carries its reading, and the two tools never mix.
  const picked = await kit.pick('claude');
  assert.ok(picked.ok);
  assert.equal(picked.account.id, roomy.id);
  assert.equal(picked.room.left, 80);
  assert.deepEqual(picked.rows.map((r) => r.account.id), [thin.id, roomy.id, middle.id]);
  assert.deepEqual(picked.rows.map((r) => r.room.left), [20, 80, 40]);
  assert.deepEqual(picked.rows[1].windows, [{ provider: 'claude', kind: 'session', usedPercent: 20, minutes: 300 }]);
  for (const row of picked.rows) assert.ok(row.readAt && Date.now() - row.readAt < 60_000);
  assert.doesNotMatch(JSON.stringify(picked), /fake-token|accessToken/);
  assert.equal(http.calls.length, 3, 'one usage request per signed-in account');
  assert.equal(http.calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal((http.calls[0].init?.headers as Record<string, string>)['anthropic-beta'], HEADERS['anthropic-beta']);
  assert.equal((http.calls[0].init?.headers as Record<string, string>)['User-Agent'], HEADERS['User-Agent']);
  const codexPick = await kit.pick('codex');
  assert.ok(codexPick.ok);
  assert.deepEqual(codexPick.rows.map((r) => [r.account.id, r.room.left]), [[chatgpt.id, 10]]);

  // `prefer` wins while that account is ready, even against a roomier one; one reading serves repeated picks.
  const preferred = await kit.pick('claude', { prefer: thin.id });
  assert.ok(preferred.ok);
  assert.equal(preferred.account.id, thin.id);
  assert.equal(http.calls.length, 3, 'a reading inside the freshness floor is not requested twice');

  // A resting account is skipped; `prefer` does not resurrect it, and its row is still listed.
  await kit.rest(roomy.id, { until: Date.now() + 3_600_000, why: 'limit' });
  const rested = await kit.pick('claude', { prefer: roomy.id });
  assert.ok(rested.ok);
  assert.equal(rested.account.id, middle.id);
  assert.equal(rested.rows.find((r) => r.account.id === roomy.id)!.account.state, 'resting');

  // A signed-out account is skipped the same way.
  writeFileSync(join(kit.folderOf(thin.id), 'signed-out'), '');
  const signedOut = await kit.pick('claude', { prefer: thin.id });
  assert.ok(signedOut.ok);
  assert.equal(signedOut.account.id, middle.id);
  assert.equal(signedOut.rows.find((r) => r.account.id === thin.id)!.account.state, 'signed_out');

  // A known room outranks a row with no readable credential, which sends no request.
  const roomless = await ready('claude', false);
  const withRoomless = await kit.pick('claude');
  assert.ok(withRoomless.ok);
  assert.equal(withRoomless.account.id, middle.id);
  assert.deepEqual(withRoomless.rows.map((r) => [r.account.id, r.room.left]), [[thin.id, 'unknown'], [roomy.id, 'unknown'], [middle.id, 40], [roomless.id, 'unknown']]);
  assert.equal(http.calls.length, 3);
  await kit.rest(middle.id, { until: Date.now() + 3_600_000, why: 'limit' });

  // No candidate at all is a clear none result that still lists every row.
  await kit.rest(roomless.id, { until: Date.now() + 3_600_000, why: 'limit' });
  const none = await kit.pick('claude');
  assert.ok(!none.ok);
  assert.equal(none.code, 'none');
  assert.equal(none.reason, 'No claude account can take a run right now.');
  assert.deepEqual(none.rows.map((r) => r.account.id), [thin.id, roomy.id, middle.id, roomless.id]);
});
