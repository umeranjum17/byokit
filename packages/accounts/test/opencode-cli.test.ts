// OpenCode as a managed CLI: add/saveKey/logout/launch plus the plan-key route seam.
// Fakes only: a Map-backed secrets store and a never-spawned binary; no live Go call, no real key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  assert.equal(openCodePlanKeyEntry(OPENCODE_GO_PLAN_ROUTE, account.id), `accounts.${OPENCODE_GO_PLAN_ROUTE}.${account.id}`);

  // The portable route finds no saved key, and says so in words without key material.
  const go = openCodeGoPlanAccount(store);
  assert.equal(go.provider, 'opencode-go');
  assert.equal(go.billing, 'subscription');
  await assert.rejects(go.access(new AbortController().signal), /Add the OpenCode plan key first\./);

  const ready = await kit.saveKey(account.id, CANARY);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.name, 'OpenCode');
  assert.deepEqual([...saved], [[`accounts.${OPENCODE_GO_PLAN_ROUTE}.${account.id}`, CANARY]], 'one entry per managed account');
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
    assert.ok(!readFileSync(file, 'utf8').includes(CANARY), `no key in state file ${file}`);
  }

  const out = await kit.logout(account.id);
  assert.equal(out.state, 'signed_out');
  assert.equal(saved.has(`accounts.${OPENCODE_GO_PLAN_ROUTE}.${account.id}`), false, 'logout deletes this account\'s key');
  assert.equal(await go.access(new AbortController().signal), 'portable-canary', 'portable route entry untouched');
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
