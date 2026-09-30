// O11 run proof: Crewhouse `openclaw-run.test.ts` ported to the kit. A real tool call crosses the
// fail-closed gate on the pinned engine, keyword-only memory never requests embeddings, and no
// `/v1/embeddings` call is ever made. Runs only in the engine job (npm run test:engine), never in npm test.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenClawKit } from '../../src/kit.ts';
import { Engine } from '../../src/engine.ts';
import { scratchDir } from '../../../test-support.ts';
import { STUB_USAGE, startModelStub, useModelStub, type ModelStub } from '../../src/testing/model-stub.ts';
import type { RunEvent } from '../../src/types.ts';

const REPORT = { name: 'report', description: 'record progress', parameters: { type: 'object' } };
const FETCH = { name: 'webfetch', description: 'fenced web read', parameters: { type: 'object' } };

const install = scratchDir('o11-engine-run');
const engineDir = join(install, 'engine');
let stub: ModelStub;

before(async () => {
  // Install the pin once; the case reuses it with a fresh state dir (the O6 signin.test.ts pattern).
  const bootstrap = new Engine({ stateDir: join(install, 'bootstrap'), engineDir, pluginId: 'byokit',
    tools: [], spawnEngine: true, onState: () => {}, onExit: () => {} });
  await bootstrap.prepare();
  stub = await startModelStub();
}, { timeout: 600_000 });

after(async () => {
  await stub?.close();
});

test('real tool calls cross the fail-closed gate; keyword memory stays free', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('o11-run');
  const gated: string[] = [];
  let called = 0;
  const kit = new OpenClawKit({ stateDir, engineDir, approvalTimeoutMs: 30_000, tools: [REPORT, FETCH],
    host: {
      gate: async (_run, tool) => {
        gated.push(tool);
        // Engine builtins cross the same gate; keyword memory stays free, everything else fails closed.
        return tool === 'report' || tool === 'webfetch' || tool === 'memory_search' || tool === 'memory_get'
          ? { allow: true }
          : { allow: false, reason: 'Unknown tool' };
      },
      call: async (_run, tool, input) => {
        called++;
        return tool === 'report' ? `Progress: ${String((input as { text?: string }).text ?? '')}` : 'Safe page';
      },
    },
  });
  const kits: OpenClawKit[] = [kit];
  try {
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await useModelStub(kit, stub);
    const { workspace } = await kit.ensureMember('m1');
    writeFileSync(join(workspace, 'MEMORY.md'), 'The blue lantern marks the kitchen door.');
    assert.equal(JSON.parse(readFileSync(join(stateDir, 'openclaw', 'openclaw.json'), 'utf8')).memory.search.provider, 'none');
    await assert.rejects(kit.call('agent', { agentId: 'm1', sessionKey: 'agent:m1:o11:cwd-probe',
      message: 'hello', cwd: join(stateDir, 'bot'), idempotencyKey: 'cwd-probe' } as never), /cwd is reserved for plugin-owned subagent runs/);
    const tools: string[] = [];
    const toolEvents: RunEvent[] = [];
    const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:chief:1', message: '[tool report {"text":"Working"}]' },
      (e) => { if (e.type === 'tool') { tools.push(`${e.name}:${e.phase}`); toolEvents.push(e); } });
    assert.ok(end.ok, JSON.stringify(end));
    // L-OC-RUN: the pin's tool events pair by id, start carries the model's own arguments (no bridge params), end the
    // result the kit's tool returned.
    const start = toolEvents.find((e) => e.type === 'tool' && e.name === 'report' && e.phase === 'start');
    const done = toolEvents.find((e) => e.type === 'tool' && e.name === 'report' && e.phase === 'end');
    assert.ok(start?.type === 'tool' && typeof start.id === 'string' && start.id.length > 0, JSON.stringify(toolEvents));
    assert.deepEqual(start.input, { text: 'Working' });
    assert.ok(done?.type === 'tool' && done.id === start.id && done.error === false, JSON.stringify(toolEvents));
    assert.ok(JSON.stringify(done.output).includes('Progress: Working'), JSON.stringify(done.output));
    // Usage is the engine's run total off the `agent` final frame (the stub reports STUB_USAGE per model call, two
    // calls here); the stub's api-key provider has no plan window, and none is made up.
    assert.ok(end.usage && (end.usage.output ?? 0) >= STUB_USAGE.completion_tokens && (end.usage.input ?? 0) > 0,
      JSON.stringify(end.usage));
    assert.equal('planWindow' in end, false, JSON.stringify(end));
    // A run's tool subset: an app tool outside it is refused before host.gate, and nothing runs.
    const gatedBefore = gated.length;
    const subsetEvents: RunEvent[] = [];
    const narrowed = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:chief:subset', tools: ['webfetch'],
      message: '[tool report {"text":"Not in this run"}]' }, (e) => subsetEvents.push(e));
    assert.ok(narrowed.ok, JSON.stringify(narrowed));
    assert.deepEqual(gated.slice(gatedBefore), [], 'a tool outside the subset reached the gate');
    assert.equal(called, 1, 'a tool outside the subset ran');
    const refusedEnd = subsetEvents.find((e) => e.type === 'tool' && e.name === 'report' && e.phase === 'end');
    assert.ok(refusedEnd?.type === 'tool' && refusedEnd.error === true, JSON.stringify(subsetEvents));
    assert.ok(gated.includes('report'), `the hook was skipped: ${JSON.stringify(end)} ${JSON.stringify(tools)}`);
    assert.equal(called, 1, 'tool bypassed the gate or failed to execute');
    assert.ok(tools.includes('report:start'), JSON.stringify(tools));
    assert.ok(stub.calls.length > 0);
    // Keyword memory recall: free, never a paid embedding request. The recall runs inside a registered run:
    // a bare tools.invoke carries a session the bridge never registered, so the gate fails it closed.
    const recall = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:chief:memory',
      message: '[tool memory_search {"query":"blue lantern"}]' }, () => {});
    assert.ok(recall.ok, JSON.stringify(recall));
    assert.ok(recall.ok && recall.text.includes('blue lantern'), JSON.stringify(recall).slice(0, 600));
    assert.ok(stub.calls.every((c) => !/embeddings/.test(c.path)), 'keyword-only memory attempted a paid embedding request');
    const read = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:scout:3',
      message: '[tool webfetch {"url":"https://example.test/"}]' }, () => {});
    assert.ok(read.ok, JSON.stringify(read));
    assert.equal(called, 2, 'fenced web read did not use the kit copy');
    // Every tool the engine runs crosses the gate, its own builtins included.
    const before = gated.length;
    await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:scout:5',
      message: '[tool web_fetch {"url":"https://example.test/"}]' }, () => {});
    assert.deepEqual(gated.slice(before), ['web_fetch'], 'an engine builtin ran without the gate');

    // A second member's agent carries its own credential; no request of its session ever uses member 1's key.
    await kit.ensureMember('m2');
    // The engine gates entry-level models through agents.defaults.modelPolicy.allow (it normalizes the list
    // to the signed-in routes, here openai/*): the new provider must be allowed or m2 falls back to openai.
    await kit.patchConfig({ models: { providers: { 'byokit-stub-two': { baseUrl: stub.url, apiKey: 'stub-m2',
      api: 'openai-completions', models: [{ id: 'test', name: 'Test', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }] } } },
      agents: { defaults: { modelPolicy: { allow: ['byokit-stub-two/*'] } },
        entries: { m2: { model: { primary: 'byokit-stub-two/test' } } } } });
    const stubCallsBefore = stub.calls.length;
    const m2end = await kit.run({ member: 'm2', sessionKey: 'agent:m2:o11:scout:9', message: 'hello from member two' }, () => {});
    assert.ok(m2end.ok, JSON.stringify(m2end));
    const m2Keys = stub.calls.slice(stubCallsBefore).map((c) => c.authorization);
    assert.ok(m2Keys.length > 0, "member two's run reached the stub provider");
    assert.ok(m2Keys.every((k) => k === 'Bearer stub-m2'), `member two's session only ever used its own key: ${m2Keys.join()}`);

    // A picked account is the one called and billed: member one names the second provider for one run, the stub
    // sees only its key, and a provider nobody signed in to ends signed-out before the engine is asked.
    const pickedBefore = stub.calls.length;
    const picked = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:pick:1', message: 'hello picked',
      model: 'byokit-stub-two/test' }, () => {});
    assert.ok(picked.ok, JSON.stringify(picked));
    const pickedKeys = stub.calls.slice(pickedBefore).map((c) => c.authorization);
    assert.ok(pickedKeys.length > 0 && pickedKeys.every((k) => k === 'Bearer stub-m2'), `picked run used: ${pickedKeys.join()}`);
    const unsigned = await kit.run({ member: 'm1', sessionKey: 'agent:m1:o11:pick:2', message: 'hello', model: 'xai/grok-4' }, () => {});
    assert.deepEqual(unsigned, { ok: false, kind: 'signed-out', message: 'xai is not signed in for m1' });

    await kit.patchConfig({ memory: { search: { provider: 'ollama', model: 'local-test',
      remote: { baseUrl: stub.url.replace(/\/v1$/, '') } } } });
    await kit.stop();
    kits.splice(0);
    const kit2 = new OpenClawKit({ stateDir, engineDir, approvalTimeoutMs: 30_000, tools: [],
      host: { gate: async (_run, tool) => (tool === 'memory_search' || tool === 'memory_get'
        ? { allow: true } : { allow: false, reason: 'no runs here' }), call: async () => 'no calls here' } });
    kits.push(kit2);
    try {
      await kit2.start();
      await useModelStub(kit2, stub);
      const { workspace: ws3 } = await kit2.ensureMember('m3');
      writeFileSync(join(ws3, 'MEMORY.md'), 'A green umbrella is by the door.');
      const local = await kit2.run({ member: 'm3', sessionKey: 'agent:m3:o11:scout:local',
        message: '[tool memory_search {"query":"green umbrella"}]' }, () => {});
      assert.ok(local.ok, JSON.stringify(local).slice(0, 500));
      assert.ok(local.ok && local.text.includes('green umbrella'), JSON.stringify(local).slice(0, 600));
      assert.ok(stub.calls.some((c) => c.path === '/api/embed'), 'configured local embedding route was not used');
      assert.ok(stub.calls.every((c) => !/\/v1\/embeddings/.test(c.path)), 'API-billed embeddings were requested');

      // A session the kit never registered: the gate refuses before any tool runs.
      const denied = await kit2.call('agent', { agentId: 'm1', sessionKey: 'agent:m1:o11:chief:2',
        message: '[tool report {"text":"Not authorized"}]', idempotencyKey: 'test-2' } as never) as { runId: string };
      const stopped = await kit2.call('agent.wait', { runId: denied.runId, timeoutMs: 240_000 }) as any;
      assert.deepEqual(stopped.terminalReceipt?.successfulToolNames ?? [], []);
      assert.equal(called, 2);
    } finally {
      await kit2.stop();
    }
  } finally {
    for (const k of kits.splice(0)) await k.stop().catch(() => {});
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('API-key activation seals a sibling store; normal selection and stores remain unchanged', { timeout: 600_000 }, async () => {
  const stateDir = scratchDir('key-engine');
  const canary = 'CANARY-ENGINE-PAID-KEY-82823';
  const logs: string[] = [];
  const events: unknown[] = [];
  const kit = new OpenClawKit({ stateDir, engineDir, log: (line) => logs.push(line),
    config: { plugins: { allow: ['openai'] }, models: { providers: { openai: {
      baseUrl: stub.url, api: 'openai-completions',
      models: [{ id: 'gpt-5.6-sol', name: 'Test', api: 'openai-completions', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 2048 }],
    } } } } });
  try {
    await kit.start();
    await useModelStub(kit, stub);
    await kit.ensureMember('m1');
    await kit.ensureMember('m2');
    const off = kit.onEvent('*', (e) => events.push(e));
    const before = await kit.call('config.get', {}) as any;
    const added = await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: canary });
    assert.equal(added, 'ok', JSON.stringify({ added, logs: logs.slice(-10) }));
    const after = await kit.call('config.get', {}) as any;
    assert.deepEqual(after.config.agents.entries.m1, before.config.agents.entries.m1);
    assert.deepEqual(after.config.agents.defaults.model, before.config.agents.defaults.model);
    assert.deepEqual(after.config.auth?.order, before.config.auth?.order, 'global order never changes');
    const { execFileSync } = await import('node:child_process');
    const { pathToFileURL } = await import('node:url');
    const sdk = pathToFileURL(join(engineDir, 'node_modules/openclaw/dist/plugin-sdk/provider-auth.js')).href;
    // A read-only transaction on each exact agent store; report metadata only, never credential values.
    const code = `const {updateAuthProfileStoreWithLock}=await import(${JSON.stringify(sdk)});
      const result={};for(const id of ['m1','m2','byokit-key-m1']) {
        await updateAuthProfileStoreWithLock({agentDir:process.env.OPENCLAW_STATE_DIR+'/agents/'+id+'/agent',
          updater(store){result[id]={order:store.order,profiles:Object.entries(store.profiles).map(([id,p])=>({id,type:p.type,provider:p.provider,copyToAgents:p.copyToAgents}))};return false;}});
      }process.stdout.write(JSON.stringify(result));`;
    const stores = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code],
      { env: kit.doctorContext().env, encoding: 'utf8' }));
    assert.equal(stores.m1.profiles.length, 0);
    assert.equal(stores.m2.profiles.length, 0);
    assert.deepEqual(stores.m1.order?.openai ?? [], [], "no normal-agent order admits a key");
    assert.equal(stores['byokit-key-m1'].profiles.length, 1);
    const profile = stores['byokit-key-m1'].profiles[0];
    assert.equal(profile.type, 'api_key');
    assert.equal(profile.copyToAgents, false);
    assert.deepEqual(stores['byokit-key-m1'].order.openai, [profile.id]);
    const callsBefore = stub.calls.length;
    const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:key', auth: 'apiKey', message: 'hello key' });
    assert.ok(end.ok, JSON.stringify(end));
    assert.ok(stub.calls.slice(callsBefore).length > 0);
    assert.ok(stub.calls.slice(callsBefore).every((c) => c.authorization === `Bearer ${canary}`));
    const other = await kit.run({ member: 'm2', sessionKey: 'agent:m2:key', auth: 'apiKey', message: 'hello' });
    assert.ok(!other.ok && 'kind' in other && other.kind === 'signed-out');
    await kit.call('models.authLogout', { agentId: 'byokit-key-m1', provider: 'openai' });
    const removedBefore = stub.calls.length;
    const removed = await kit.run({ member: 'm1', sessionKey: 'agent:m1:key', auth: 'apiKey', message: 'hello' });
    assert.ok(!removed.ok && 'kind' in removed && removed.kind === 'signed-out');
    assert.equal(stub.calls.length, removedBefore, 'a removed key never reaches another account');
    assert.equal(JSON.stringify([added, end, other, removed, logs, events]).includes(canary), false);
    const engineLogs = readFileSync(join(stateDir, 'logs/openclaw-events.log'), 'utf8');
    assert.equal(engineLogs.includes(canary), false);
    off();
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});
