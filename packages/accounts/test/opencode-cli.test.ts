// OpenCode as a managed CLI: add/saveKey/logout/launch plus the plan-key route seam.
// Fakes only: a Map-backed secrets store and a never-spawned binary; no live Go call, no real key.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Keystore } from '@byokit/secrets';
import { cliAccounts, CliAccountError } from '../src/cli.ts';
import { OPENCODE_GO_PLAN_ROUTE, openCodeGoPlanAccount, openCodePlanKeyEntry, readOpenCodePlanKey, saveOpenCodePlanKey } from '../src/opencode-go.ts';
import { remoteCliHost, remoteCliState } from '../src/remote-cli-host.ts';
import { scratchDir } from '../../test-support.ts';

const CANARY = 'canary-opencode-plan-key-7d31';

function memoryKeys() {
  const saved = new Map<string, string>();
  const store: Keystore = {
    get: async (name) => saved.get(name) ?? null,
    set: async (name, secret) => { saved.set(name, secret); },
    delete: async (name) => saved.delete(name),
  };
  return { store, saved };
}

function fakeBin(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(bin, '#!/bin/sh\necho never-spawned\n', { mode: 0o755 });
  return bin;
}

function stateFiles(stateDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, name.name);
      if (name.isDirectory() && !name.isSymbolicLink()) walk(path);
      else if (name.isFile()) out.push(path);
    }
  };
  walk(stateDir);
  return out;
}

test('opencode managed account: add, hidden saveKey, launch, route access, logout', async () => {
  const root = scratchDir('opencode-cli');
  const stateDir = join(root, 'plans');
  const { store, saved } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake') }, env, keyStore: store });

  const { account, signIn } = await kit.add('opencode');
  assert.equal(account.provider, 'opencode');
  assert.equal(account.state, 'signing');
  // Nothing to spawn: the app collects the plan key with hidden typing instead.
  assert.deepEqual(signIn.argv, []);
  assert.equal(signIn.instruction?.words, 'cli.opencodeKey');
  assert.equal((await kit.status(account.id)).state, 'signing');
  const refused = await kit.launch(account.id);
  assert.equal(refused.ok, false);
  assert.equal(openCodePlanKeyEntry(), `accounts.${OPENCODE_GO_PLAN_ROUTE}`);
  assert.equal(openCodePlanKeyEntry(OPENCODE_GO_PLAN_ROUTE, account.id), `accounts.${OPENCODE_GO_PLAN_ROUTE}:${account.id}`);

  // The portable route finds no saved key, and says so in words without key material.
  const go = openCodeGoPlanAccount(store);
  assert.equal(go.provider, 'opencode-go');
  assert.equal(go.billing, 'subscription');
  await assert.rejects(go.access(new AbortController().signal), /Add the OpenCode plan key first\./);

  const ready = await kit.saveKey(account.id, CANARY);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.name, 'OpenCode');
  assert.deepEqual([...saved], [[`accounts.${OPENCODE_GO_PLAN_ROUTE}:${account.id}`, CANARY]], 'one entry per managed account');
  assert.equal(await readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', account.id), CANARY);
  // Portable route stays on its own entry (Accounts.add / openCodeGoPlanAccount), not the managed CLI id.
  await assert.rejects(go.access(new AbortController().signal), /Add the OpenCode plan key first\./);
  await saveOpenCodePlanKey(store, 'portable-canary');
  assert.equal(await go.access(new AbortController().signal), 'portable-canary');

  const launch = await kit.launch(account.id);
  assert.equal(launch.ok, true);
  if (launch.ok) {
    const folder = join(stateDir, 'opencode');
    assert.ok(launch.set.OPENCODE_CONFIG_DIR.startsWith(folder), 'launch points at the managed folder');
    assert.ok(launch.unset.includes('OPENCODE_API_KEY'));
    assert.ok(!JSON.stringify({ ...launch, env: signIn.env, shell: signIn.shell }).includes(CANARY), 'no key in launch, env or sign-in text');
  }
  for (const file of stateFiles(stateDir)) {
    if (file.endsWith('/go.key') || file.endsWith('/opencode.json')) continue; // the folder delivery copies
    assert.ok(!readFileSync(file, 'utf8').includes(CANARY), `no key in state file ${file}`);
  }

  const out = await kit.logout(account.id);
  assert.equal(saved.has(`accounts.${OPENCODE_GO_PLAN_ROUTE}:${account.id}`), false, 'logout deletes this account\'s key');
  assert.equal(out.state, 'signed_out');
  await assert.rejects(go.access(new AbortController().signal), /Add the OpenCode plan key first\./);
  assert.equal((await kit.status(account.id)).state, 'signed_out');
  await assert.rejects(readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', account.id), (e: unknown) => {
    assert.ok(e instanceof Error && e.message === 'Add the OpenCode plan key first.');
    assert.ok(!e.message.includes(CANARY));
    return true;
  });
  await kit.remove(account.id);
  await assert.rejects(kit.status(account.id), CliAccountError);
});

test('opencode two accounts: isolated keys, folders, resume, and remove', async () => {
  const root = scratchDir('opencode-cli-two');
  const stateDir = join(root, 'plans');
  const { store, saved } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake') }, env, keyStore: store });
  const canaryA = 'canary-A-oc-two-accounts';
  const canaryB = 'canary-B-oc-two-accounts';

  const { account: a } = await kit.add('opencode');
  await kit.saveKey(a.id, canaryA);
  const { account: b } = await kit.add('opencode');
  await kit.saveKey(b.id, canaryB);

  assert.equal((await kit.status(a.id)).state, 'ready');
  assert.equal((await kit.status(b.id)).state, 'ready');
  assert.equal(await readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', a.id), canaryA);
  assert.equal(await readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', b.id), canaryB);
  assert.equal(saved.size, 2);
  assert.notEqual(openCodePlanKeyEntry(OPENCODE_GO_PLAN_ROUTE, a.id), openCodePlanKeyEntry(OPENCODE_GO_PLAN_ROUTE, b.id));

  const launchA = await kit.launch(a.id);
  const launchB = await kit.launch(b.id);
  assert.equal(launchA.ok, true);
  assert.equal(launchB.ok, true);
  if (launchA.ok && launchB.ok) {
    assert.notEqual(launchA.set.OPENCODE_CONFIG_DIR, launchB.set.OPENCODE_CONFIG_DIR);
    assert.ok(!JSON.stringify(launchA).includes(canaryA) && !JSON.stringify(launchA).includes(canaryB));
    assert.ok(!JSON.stringify(launchB).includes(canaryA) && !JSON.stringify(launchB).includes(canaryB));
  }

  assert.deepEqual(kit.resumeArgs('opencode', { kind: 'id', value: 'ses_1' }), ['--session', 'ses_1']);
  assert.throws(() => kit.resumeArgs('opencode', { kind: 'id', value: '-sneaky' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.deepEqual(kit.launchArgs(a.id), []);

  await kit.remove(a.id);
  assert.equal((await kit.status(b.id)).state, 'ready');
  assert.equal(await readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', b.id), canaryB);
  assert.equal(saved.has(openCodePlanKeyEntry(OPENCODE_GO_PLAN_ROUTE, a.id)), false);
  assert.equal(saved.size, 1);
  for (const file of stateFiles(stateDir)) {
    assert.ok(!readFileSync(file, 'utf8').includes(canaryA), `no canary-A in state file ${file}`);
  }
  const still = await kit.launch(b.id);
  assert.equal(still.ok, true);
  if (still.ok) assert.ok(!JSON.stringify(still).includes(canaryA));
  await assert.rejects(readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', a.id), (e: unknown) => {
    assert.ok(e instanceof Error && !e.message.includes(canaryA));
    return true;
  });
  await kit.remove(b.id);
});

test('opencode launch delivers the key through folder files; logout/remove delete the copies', async () => {
  const root = scratchDir('opencode-cli-files');
  const stateDir = join(root, 'plans');
  const { store, saved } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake') }, env, keyStore: store });
  const canary = 'canary-oc-file-delivery-9z';
  const legacy = 'legacy-route-canary-4q';

  const { account } = await kit.add('opencode');
  await kit.saveKey(account.id, canary);
  // No key yet: usage has no source to offer.
  const { account: bare } = await kit.add('opencode');
  assert.equal(await kit.usageSource(bare.id), undefined);
  const folder = kit.folderOf(account.id);
  const keyPath = join(folder, 'go.key');
  const configPath = join(folder, 'opencode.json');

  const launched = await kit.launch(account.id);
  assert.equal(launched.ok, true);
  if (!launched.ok) throw new Error('opencode launch was not ready');
  assert.equal(launched.set.OPENCODE_CONFIG, configPath);
  assert.ok(!launched.unset.includes('OPENCODE_CONFIG'));
  assert.equal(readFileSync(keyPath, 'utf8'), canary);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.provider.opencode.options.apiKey, `{file:${keyPath}}`);
  assert.ok(!JSON.stringify({ set: launched.set, unset: launched.unset }).includes(canary), 'no key bytes in the launch result');
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: canary });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
    const ref = config.provider.opencode.options.apiKey;
    const key = readFileSync(ref.slice(6, -1), 'utf8');
    assert.ok(key.length > 0);
    assert.ok(!JSON.stringify({argv:process.argv, env:process.env}).includes(key));
    console.log('delivery ok');
  `], { env: { ...env, ...launched.set }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'delivery ok');
  assert.equal(existsSync(join(folder, 'auth.json')), false, 'no console login in the launch store');
  // launchEnv stays folder-only: no key read, no delivery config.
  const envOnly = kit.launchEnv(account.id);
  assert.equal(envOnly.set.OPENCODE_CONFIG, undefined);
  assert.ok(!JSON.stringify(envOnly).includes(canary));

  await kit.logout(account.id);
  assert.equal(existsSync(keyPath), false, 'logout deletes the key copy');
  assert.equal(existsSync(configPath), false, 'logout deletes the config copy');

  // The old route entry is claimed by the first row only, never a second unsigned row.
  await saveOpenCodePlanKey(store, legacy);
  assert.equal(await kit.usageSource(bare.id), undefined);
  assert.equal((await kit.status(account.id)).state, 'ready');
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: legacy });
  const relaunch = await kit.launch(account.id);
  assert.equal(relaunch.ok, true);
  assert.equal(readFileSync(keyPath, 'utf8'), legacy);
  await kit.saveKey(account.id, canary);
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: canary }, 'the account entry wins over the legacy route entry');

  await kit.remove(account.id);
  assert.equal(existsSync(keyPath), false, 'remove deletes the key copy');
  assert.equal(existsSync(configPath), false, 'remove deletes the config copy');
  assert.equal(await kit.usageSource(bare.id), undefined, 'removal never reassigns the legacy key');
  assert.equal(await kit.usageSource(bare.id), undefined);
  // Already-published dot-separated account entries stay readable, then logout deletes them.
  saved.set(`accounts.${OPENCODE_GO_PLAN_ROUTE}.${bare.id}`, canary);
  assert.equal((await kit.status(bare.id)).state, 'ready');
  assert.equal((await kit.logout(bare.id)).state, 'signed_out');
  assert.equal(saved.size, 0);
  await kit.remove(bare.id);
});

test('opencode saveKey/logout refuse the wrong shape, and remote stays read-only', async () => {
  const root = scratchDir('opencode-cli-guards');
  const stateDir = join(root, 'plans');
  const { store } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const bins = { opencode: fakeBin(join(root, 'bins'), 'opencode-fake'), claude: fakeBin(join(root, 'bins'), 'claude-fake') };
  const kit = cliAccounts({ stateDir, bins, env, keyStore: store });

  await assert.rejects(cliAccounts({ stateDir: join(root, 'other'), bins: {}, env }).add('opencode'), (e: unknown) => e instanceof CliAccountError && e.code === 'bad-option');
  const { account: claude } = await kit.add('claude');
  await assert.rejects(kit.saveKey(claude.id, CANARY), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  await assert.rejects(kit.logout(claude.id), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  const { account } = await kit.add('opencode');
  await assert.rejects(kit.saveKey('no-such-id', CANARY), (e: unknown) => e instanceof CliAccountError && e.code === 'unknown-account');
  await assert.rejects(kit.saveKey(account.id, '   '), (e: unknown) => e instanceof CliAccountError && e.code === 'bad-option');
  await assert.rejects(cliAccounts({ stateDir, bins, env }).saveKey(account.id, CANARY), (e: unknown) => e instanceof CliAccountError && e.code === 'bad-option');
  assert.deepEqual(kit.launchArgs(account.id), []);
  assert.deepEqual(kit.resumeArgs('opencode', { kind: 'id', value: 'abc' }), ['--session', 'abc']);
  assert.throws(() => kit.resumeArgs('opencode', { kind: 'path', value: 'abc' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => kit.resumeArgs('opencode', { kind: 'id', value: '--flag' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => openCodePlanKeyEntry(''), /invalid account options/);
  assert.throws(() => openCodePlanKeyEntry(OPENCODE_GO_PLAN_ROUTE, ''), /invalid account options/);

  const states = await remoteCliState(kit, bins);
  const row = states.find((s) => s.provider === 'opencode');
  assert.deepEqual(row, { provider: 'opencode', billing: 'subscription', installed: true, signedIn: false, supported: false });
  const host = remoteCliHost({ cli: kit, bins });
  assert.deepEqual(await host.start('opencode'), { ok: false, error: 'unsupported',
    words: "OpenCode can't sign in from your phone. Sign in on the computer itself." });
  await kit.remove(claude.id);
  await kit.remove(account.id);
});
