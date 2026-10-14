// Managed Vibe CLI: two app-owned accounts, each with its own VIBE_HOME and API key.
// Fake binary only; never a real login or the owner's ~/.vibe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Keystore } from '@byokit/secrets';
import { cliAccounts, CliAccountError, VIBE_API_KEY_ROUTE } from '../src/cli.ts';
import { openCodePlanKeyEntry, readOpenCodePlanKey } from '../src/opencode-go.ts';
import { scratchDir } from '../../test-support.ts';

const CANARY_A = 'canary-A-vibe-two-accounts';
const CANARY_B = 'canary-B-vibe-two-accounts';

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

test('vibe two accounts: isolated keys, folders, resume, remove, default-login guard', async () => {
  const root = scratchDir('vibe-cli-two');
  const stateDir = join(root, 'plans');
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const { store, saved } = memoryKeys();
  const parent = join(stateDir, 'vibe');
  const env = { HOME: home, PATH: '/unused', MISTRAL_API_KEY: 'owner-key-override' };
  const kit = cliAccounts({ stateDir, bins: { vibe: fakeBin(join(root, 'bins'), 'vibe-fake') }, env, keyStore: store });

  const { account: a, signIn: signA } = await kit.add('vibe');
  assert.equal(a.provider, 'vibe');
  assert.equal(a.state, 'signing');
  assert.deepEqual(signA.argv, []);
  assert.equal(signA.instruction?.words, 'cli.vibeKey');
  assert.ok(signA.env.VIBE_HOME.startsWith(parent + '/'));
  assert.equal(signA.env.MISTRAL_API_KEY, undefined, 'owner key override is unset at sign-in');
  await kit.saveKey(a.id, CANARY_A);

  const { account: b, signIn: signB } = await kit.add('vibe');
  assert.ok(signB.env.VIBE_HOME.startsWith(parent + '/'));
  assert.notEqual(signA.env.VIBE_HOME, signB.env.VIBE_HOME);
  await kit.saveKey(b.id, CANARY_B);

  assert.equal((await kit.status(a.id)).state, 'ready');
  assert.equal((await kit.status(b.id)).state, 'ready');
  assert.equal(await readOpenCodePlanKey(store, VIBE_API_KEY_ROUTE, 'Vibe', a.id), CANARY_A);
  assert.equal(await readOpenCodePlanKey(store, VIBE_API_KEY_ROUTE, 'Vibe', b.id), CANARY_B);
  assert.equal(saved.size, 2);
  assert.notEqual(openCodePlanKeyEntry(VIBE_API_KEY_ROUTE, a.id), openCodePlanKeyEntry(VIBE_API_KEY_ROUTE, b.id));

  const launchA = await kit.launch(a.id);
  const launchB = await kit.launch(b.id);
  assert.equal(launchA.ok, true);
  assert.equal(launchB.ok, true);
  if (launchA.ok && launchB.ok) {
    assert.notEqual(launchA.set.VIBE_HOME, launchB.set.VIBE_HOME);
    assert.equal(launchA.set.VIBE_HOME, signA.env.VIBE_HOME);
    assert.equal(launchB.set.VIBE_HOME, signB.env.VIBE_HOME);
    assert.ok(launchA.unset.includes('MISTRAL_API_KEY'));
    assert.ok(!JSON.stringify(launchA).includes(CANARY_A) && !JSON.stringify(launchA).includes(CANARY_B));
    assert.ok(!JSON.stringify(launchB).includes(CANARY_A) && !JSON.stringify(launchB).includes(CANARY_B));
  }

  assert.deepEqual(kit.resumeArgs('vibe', { kind: 'id', value: 'ses_1' }), ['--resume', 'ses_1']);
  assert.throws(() => kit.resumeArgs('vibe', { kind: 'id', value: '-sneaky' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => kit.resumeArgs('vibe', { kind: 'id', value: '' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.throws(() => kit.resumeArgs('vibe', { kind: 'path', value: 'ses_1' }), (e: unknown) => e instanceof CliAccountError && e.code === 'kind-mismatch');
  assert.deepEqual(kit.launchArgs(a.id), []);

  await kit.remove(a.id);
  assert.equal((await kit.status(b.id)).state, 'ready');
  assert.equal(await readOpenCodePlanKey(store, VIBE_API_KEY_ROUTE, 'Vibe', b.id), CANARY_B);
  assert.equal(saved.has(openCodePlanKeyEntry(VIBE_API_KEY_ROUTE, a.id)), false);
  assert.equal(saved.size, 1);
  for (const file of stateFiles(stateDir)) {
    assert.ok(!readFileSync(file, 'utf8').includes(CANARY_A), `no canary-A in state file ${file}`);
  }
  assert.equal((await kit.launch(b.id)).ok, true);
  await assert.rejects(kit.status(a.id), CliAccountError);

  assert.throws(() => cliAccounts({ stateDir: join(home, '.vibe'), bins: { vibe: fakeBin(join(root, 'bins'), 'vibe-guard') }, env: { HOME: home, PATH: '/unused' } }),
    (e: unknown) => e instanceof CliAccountError && e.code === 'bad-option');
  await kit.remove(b.id);
});
