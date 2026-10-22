// D19 real-Gateway controls: a bare inherited model is not an existing credential; actual local/global keys are.
// Synthetic keys and a loopback provider only. No consent is injected and no native reply is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OpenClawKit } from '@byokit/openclaw';
import { startModelStub } from '@byokit/openclaw/testing';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';
import { untilListed } from '../../src/members.ts';

test('native key replacement: inherited model permits a new account; real local and global credentials still require confirmation', { timeout: 900_000 }, async (t) => {
  const dir = scratchDir('kr');
  const stub = await startModelStub();
  t.after(() => stub.close());
  const config = { plugins: { allow: ['openai'] }, models: { providers: { openai: {
    baseUrl: stub.url, api: 'openai-completions', models: [{ id: 'gpt-5.6-sol', name: 'Test', api: 'openai-completions',
      reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 2048 }],
  } } } };
  const localState = join(dir, 'local');
  const kit = new OpenClawKit({ stateDir: localState, engineDir: sharedEngineDir(), config });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    const root = join(localState, 'openclaw');
    const agentId = 'm1--aaaaaa';
    await kit.call('agents.create', { name: agentId, workspace: join(root, 'workspaces', 'm1') });
    await untilListed(() => kit.call('agents.list', {}), agentId);
    const cfg = () => JSON.parse(readFileSync(join(root, 'openclaw.json'), 'utf8'));
    const key = 'stub-key-new-openai-account';
    const fresh = await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId, authChoice: 'openai-api-key', apiKey: key }, { timeoutMs: 180_000 });
    assert.equal(fresh.ok, true, 'a new OpenAI account is not a credential replacement just because it inherits a model');
    assert.ok(stub.calls.some(c => c.authorization === `Bearer ${key}`), 'the owned live probe used the supplied new-account key');
    const activeModel = cfg().agents.entries[agentId].model;
    const activeRef = typeof activeModel === 'string' ? activeModel : activeModel.primary;
    assert.ok(activeRef.includes('@'), 'the verified model is pinned to its credential');
    const profileId = activeRef.slice(activeRef.lastIndexOf('@') + 1);
    const local = await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId,
      authChoice: 'openai-api-key', apiKey: 'stub-key-local-replacement' }, { timeoutMs: 180_000 });
    assert.equal(local.ok, false, 'an existing local credential is not silently replaced');
    assert.equal(local.status, 'unavailable');
    assert.ok(local.error?.includes('Activation declined.'), 'native local replacement confirmation remains required');
    assert.deepEqual(cfg().agents.entries[agentId].model, activeModel);
    const db = new DatabaseSync(join(root, 'state', 'agents', agentId, 'agent', 'openclaw-agent.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT store_json FROM auth_profile_store').get() as { store_json: string };
      assert.ok(JSON.parse(row.store_json).profiles[profileId]?.key === key, 'the original local key remains intact');
    } finally { db.close(); }
    console.log('PASS new OpenAI account; existing local credential still requires confirmation');
  } finally { await kit.stop(); }

  // Sequential second app, not a second concurrently running Gateway.
  const globalState = join(dir, 'global');
  const globalKit = new OpenClawKit({ stateDir: globalState, engineDir: sharedEngineDir(), config: {
    ...config, models: { providers: { openai: { ...config.models.providers.openai, apiKey: 'stub-global-existing-key' } } },
  } });
  try {
    await globalKit.start();
    const { agentId } = await globalKit.ensureMember('control');
    const cfg = () => JSON.parse(readFileSync(join(globalState, 'openclaw', 'openclaw.json'), 'utf8'));
    const baselineKey = cfg().models.providers.openai.apiKey;
    assert.ok(baselineKey, 'the control starts with a global credential source');
    const global = await globalKit.call('openclaw.setup.activate', { kind: 'api-key', agentId,
      authChoice: 'openai-api-key', apiKey: 'stub-global-replacement-key' }, { timeoutMs: 180_000 });
    assert.equal(global.ok, false, 'an existing global key is not silently replaced');
    assert.equal(global.status, 'unavailable');
    assert.ok(global.error?.includes('Activation declined.'), 'global-key replacement still requires native confirmation');
    assert.ok(JSON.stringify(cfg().models.providers.openai.apiKey) === JSON.stringify(baselineKey), 'the original global key source remains intact');
    console.log('PASS existing global credential still requires confirmation');
  } finally { await globalKit.stop(); }
});
