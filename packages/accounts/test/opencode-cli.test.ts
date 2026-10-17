// OpenCode as a managed CLI: add/saveKey/logout/launch plus the plan-key route seam.
// Fakes only: a Map-backed secrets store and a binary that only answers `--version`; no live Go call, no real key.
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Keystore } from '@byokit/secrets';
import { cliAccounts, CliAccountError } from '@byokit/accounts/cli';
import { KeyRouteError } from '@byokit/accounts';
import { OPENCODE_GO_PLAN_ROUTE, openCodeGoPlanAccount, openCodePlanKeyEntry, openCodeWorkspaceEntry, readOpenCodePlanKey, saveOpenCodePlanKey } from '@byokit/accounts/opencode-go';
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

// `version` is what the binary prints for `--version` (1.x: `1.19.3`, 2.x: `opencode v2.0.32`); empty fails it.
function fakeBin(dir: string, name: string, version = '1.19.3') {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, name);
  writeFileSync(`${bin}.version`, version);
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && [ -s '${bin}.version' ] && { /bin/cat '${bin}.version'; exit 0; }\necho 'opencode: not a version' >&2\nexit 64\n`, { mode: 0o755 });
  return bin;
}
const XDG = [['XDG_DATA_HOME', 'data'], ['XDG_STATE_HOME', 'state'], ['XDG_CACHE_HOME', 'cache']] as const;

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

  assert.equal((await kit.status(account.id)).state, 'ready');
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: CANARY });
  assert.equal(await go.access(new AbortController().signal), 'portable-canary');
  const out = await kit.logout(account.id);
  assert.equal(saved.has(`accounts.${OPENCODE_GO_PLAN_ROUTE}:${account.id}`), false, 'logout deletes this account\'s key');
  assert.equal(out.state, 'signed_out');
  assert.equal(await go.access(new AbortController().signal), 'portable-canary');
  const reopened = cliAccounts({ stateDir, bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake') }, env, keyStore: store });
  reopened.signInAgain(account.id);
  assert.equal((await reopened.status(account.id)).state, 'signing');
  assert.equal(await reopened.usageSource(account.id), undefined);
  assert.equal((await reopened.launch(account.id)).ok, false);
  assert.equal((await kit.status(account.id)).state, 'signing');
  await assert.rejects(readOpenCodePlanKey(store, OPENCODE_GO_PLAN_ROUTE, 'OpenCode', account.id), (e: unknown) => {
    assert.ok(e instanceof Error && e.message === 'Add the OpenCode plan key first.');
    assert.ok(!e.message.includes(CANARY));
    return true;
  });
  await kit.remove(account.id);
  await assert.rejects(kit.status(account.id), CliAccountError);
  const { account: next } = await reopened.add('opencode');
  assert.equal(await reopened.usageSource(next.id), undefined);
  await reopened.remove(next.id);
  assert.equal(await go.access(new AbortController().signal), 'portable-canary');
});

test('opencode existing account keys preserve portable credentials across reads and deletion', async () => {
  for (const separator of [':', '.']) {
    for (const action of ['status', 'launch', 'usageSource', 'logout', 'remove'] as const) {
      const root = scratchDir('opencode-cli-portable');
      const { store, saved } = memoryKeys();
      const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake') },
        env: { HOME: join(root, 'home'), PATH: '/unused' }, keyStore: store });
      const { account } = await kit.add('opencode');
      saved.set(`accounts.${OPENCODE_GO_PLAN_ROUTE}${separator}${account.id}`, CANARY);
      await saveOpenCodePlanKey(store, 'portable-canary');
      await kit[action](account.id);
      assert.equal(await openCodeGoPlanAccount(store).access(new AbortController().signal), 'portable-canary');
      if (action !== 'remove') {
        if (action !== 'logout') {
          assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: CANARY });
          await kit.logout(account.id);
        }
        assert.equal((await kit.status(account.id)).state, 'signed_out');
        await kit.remove(account.id);
      }
      const { account: next } = await kit.add('opencode');
      assert.equal(await kit.usageSource(next.id), undefined);
      assert.equal(await openCodeGoPlanAccount(store).access(new AbortController().signal), 'portable-canary');
      assert.equal(saved.size, 1);
      await kit.remove(next.id);
    }
  }
});

test('opencode two accounts: isolated keys, folders, resume, and remove', async () => {
  const root = scratchDir('opencode-cli-two');
  const stateDir = join(root, 'plans');
  const { store, saved } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const kit = cliAccounts({ stateDir, bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake', 'opencode v2.0.32') }, env, keyStore: store });
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
    // 2.x shares one background server on a fixed port; each account runs its own instead.
    assert.deepEqual(launchA.args, ['--standalone']);
    assert.deepEqual(launchB.args, ['--standalone']);
    for (const [name] of XDG) assert.notEqual(launchA.set[name], launchB.set[name], `${name} differs per account`);
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
  await saveOpenCodePlanKey(store, legacy);
  assert.equal((await kit.status(account.id)).state, 'ready');
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: legacy });
  assert.equal(saved.has(openCodePlanKeyEntry()), false);
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
  // OpenCode keeps its sign-in store and database in the XDG roots (1.x auth.json, 2.x opencode.db),
  // so each account's start uses its own, never the person's ~/.local/share/opencode.
  for (const [name, sub] of XDG) assert.equal(launched.set[name], join(folder, sub), `launch sets ${name}`);
  assert.ok(launched.unset.includes('OPENCODE_DB'), 'a host OPENCODE_DB cannot point the account at another database');
  assert.deepEqual(launched.args, [], '1.x refuses --standalone');
  assert.equal(readFileSync(keyPath, 'utf8'), canary);
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.equal(statSync(folder).mode & 0o777, 0o700);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(config.provider['opencode-go'].options.apiKey, `{file:${keyPath}}`);
  assert.ok(!JSON.stringify({ set: launched.set, unset: launched.unset }).includes(canary), 'no key bytes in the launch result');
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: canary });
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'; import {readFileSync} from 'node:fs';
    const config = JSON.parse(readFileSync(process.env.OPENCODE_CONFIG, 'utf8'));
    const model = 'opencode-go/test-model';
    const ref = config.provider[model.split('/')[0]].options.apiKey;
    assert.ok(ref.startsWith('{file:') && ref.endsWith('}'));
    const key = readFileSync(ref.slice(6, -1), 'utf8');
    assert.ok(key.length > 0);
    assert.ok(!JSON.stringify({argv:process.argv, env:process.env}).includes(key));
    const {mkdirSync, writeFileSync} = await import('node:fs');
    mkdirSync(process.env.XDG_DATA_HOME + '/opencode', {recursive: true});
    writeFileSync(process.env.XDG_DATA_HOME + '/opencode/opencode.db', 'sessions');
    console.log('delivery ok');
  `], { env: { ...env, ...launched.set }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'delivery ok');
  assert.equal(existsSync(join(folder, 'auth.json')), false, 'no console login in the launch store');
  // launchEnv stays folder-only: no key read, no delivery config.
  const envOnly = kit.launchEnv(account.id);
  assert.equal(envOnly.set.OPENCODE_CONFIG, undefined);
  for (const [name, sub] of XDG) assert.equal(envOnly.set[name], join(folder, sub), `launchEnv sets ${name}`);
  assert.equal(existsSync(join(folder, 'data', 'opencode', 'opencode.db')), true, 'the run wrote into the account data root');
  assert.equal(existsSync(join(env.HOME, '.local')), false, 'nothing in the person\'s data root');
  assert.ok(!JSON.stringify(envOnly).includes(canary));

  await kit.logout(account.id);
  assert.equal(existsSync(keyPath), false, 'logout deletes the key copy');
  assert.equal(existsSync(configPath), false, 'logout deletes the config copy');

  await saveOpenCodePlanKey(store, legacy);
  assert.equal(await kit.usageSource(bare.id), undefined);
  assert.equal((await kit.status(account.id)).state, 'signed_out');
  await kit.saveKey(account.id, canary);
  const relaunch = await kit.launch(account.id);
  assert.equal(relaunch.ok, true);
  assert.equal(readFileSync(keyPath, 'utf8'), canary);
  assert.deepEqual(await kit.usageSource(account.id), { provider: 'opencode', key: canary });

  await kit.remove(account.id);
  assert.equal(existsSync(keyPath), false, 'remove deletes the key copy');
  assert.equal(existsSync(configPath), false, 'remove deletes the config copy');
  for (const [, sub] of XDG) assert.equal(existsSync(join(folder, sub)), false, `remove deletes the ${sub} root`);
  assert.equal(await kit.usageSource(bare.id), undefined, 'removal never reassigns the legacy key');
  assert.equal(await kit.usageSource(bare.id), undefined);
  // Already-published dot-separated account entries stay readable, then logout deletes them.
  saved.set(`accounts.${OPENCODE_GO_PLAN_ROUTE}.${bare.id}`, canary);
  assert.equal((await kit.status(bare.id)).state, 'ready');
  assert.equal((await kit.logout(bare.id)).state, 'signed_out');
  assert.equal(await openCodeGoPlanAccount(store).access(new AbortController().signal), legacy);
  assert.equal(saved.size, 1);
  await kit.remove(bare.id);
});

test('opencode version is the first version token on the first line: a trailing 2.x mention keeps 1.x', async () => {
  const root = scratchDir('opencode-cli-banner');
  const { store } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const bin = fakeBin(join(root, 'bins'), 'opencode-banner', '1.19.3 → 2.0.1 available');
  const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { opencode: bin }, env, keyStore: store });
  const { account } = await kit.add('opencode');
  await kit.saveKey(account.id, CANARY, { workspace: 'org_BANNER' });
  const launched = await kit.launch(account.id);
  if (!launched.ok) throw new Error('opencode launch was not ready');
  assert.deepEqual(launched.args, [], '1.x refuses --standalone even when the banner names 2.x');
  await kit.remove(account.id);
});

test('opencode prerelease 2.x still gets --standalone', async () => {
  const root = scratchDir('opencode-cli-prerelease');
  const { store } = memoryKeys();
  const env = { HOME: join(root, 'home'), PATH: '/unused' };
  const bin = fakeBin(join(root, 'bins'), 'opencode-beta', 'opencode v2.0.0-beta.1');
  const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { opencode: bin }, env, keyStore: store });
  const { account } = await kit.add('opencode');
  await kit.saveKey(account.id, CANARY, { workspace: 'org_BETA' });
  const launched = await kit.launch(account.id);
  if (!launched.ok) throw new Error('opencode launch was not ready');
  assert.deepEqual(launched.args, ['--standalone']);
  await kit.remove(account.id);
});

for (const [label, banner] of [['leading newline', '\n2.0.32'], ['ANSI-coloured', '\x1b[1m2.0.32\x1b[0m'], ['parenthesised', 'opencode (2.0.32)']] as const) {
  test(`opencode 2.x version on a ${label} first line still gets --standalone`, async () => {
    const root = scratchDir('opencode-cli-banner-shape');
    const { store } = memoryKeys();
    const env = { HOME: join(root, 'home'), PATH: '/unused' };
    const bin = fakeBin(join(root, 'bins'), 'opencode-shape', banner);
    const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { opencode: bin }, env, keyStore: store });
    const { account } = await kit.add('opencode');
    await kit.saveKey(account.id, CANARY, { workspace: 'org_SHAPE' });
    const launched = await kit.launch(account.id);
    if (!launched.ok) throw new Error('opencode launch was not ready');
    assert.deepEqual(launched.args, ['--standalone']);
    await kit.remove(account.id);
  });
}

test('opencode launch of a key saved without a workspace: one is written and stored, several ask for the pick', async () => {
  const root = scratchDir('opencode-cli-workspace');
  const { store, saved } = memoryKeys();
  let orgs: { id: string; name: string }[] = [{ id: 'org_WORKING2', name: 'Working2' }];
  let listed = 0;
  const fetch = async (input: unknown) => {
    if (String(input) !== 'https://opencode.ai/console/api/orgs') throw new Error(`unexpected fetch: ${String(input)}`);
    listed++;
    return new Response(JSON.stringify(orgs), { status: 200 });
  };
  const kit = cliAccounts({ stateDir: join(root, 'plans'), bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-fake') },
    env: { HOME: join(root, 'home'), PATH: '/unused' }, keyStore: store, fetch });
  const { account } = await kit.add('opencode');
  await kit.saveKey(account.id, CANARY);
  assert.equal((await kit.launch(account.id)).ok, true);
  const config = JSON.parse(readFileSync(join(kit.folderOf(account.id), 'opencode.json'), 'utf8'));
  assert.equal(config.provider['opencode-go'].options.headers['x-opencode-org-id'], 'org_WORKING2');
  assert.equal(saved.get(openCodeWorkspaceEntry(OPENCODE_GO_PLAN_ROUTE, account.id)), 'org_WORKING2', 'stored with the key');
  await kit.launch(account.id);
  assert.equal(listed, 1, 'a later launch uses the stored workspace');

  orgs = [{ id: 'org_A', name: 'Working' }, { id: 'org_WORKING2', name: 'Working2' }];
  await kit.saveKey(account.id, CANARY); // a new key drops the stored workspace
  await assert.rejects(kit.launch(account.id), (e) => e instanceof KeyRouteError && e.code === 'needs_workspace');
  await kit.remove(account.id);
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
  const broken = cliAccounts({ stateDir: join(root, 'broken'), bins: { opencode: fakeBin(join(root, 'bins'), 'opencode-broken', '') }, env, keyStore: store });
  const { account: unread } = await broken.add('opencode');
  await broken.saveKey(unread.id, CANARY, { workspace: 'org_UNREAD' });
  const unreadStart = await broken.launch(unread.id);
  assert.equal(unreadStart.ok, true);
  if (unreadStart.ok) assert.deepEqual(unreadStart.args, [], 'an unreadable version starts without --standalone');
  await broken.remove(unread.id);
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
