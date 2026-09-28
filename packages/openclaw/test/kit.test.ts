import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';

async function withKit(fn: (kit: OpenClawKit, fake: ReturnType<typeof fakeGateway>) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o4-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  try { await kit.start(); await fn(kit, fake); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}

test('typed pass-through, dynamic refusal, events and hello', async () => withKit(async (kit, fake) => {
  assert.equal(kit.state.phase, 'ready');
  assert.equal(kit.hello?.protocol, 4);
  const options = { timeoutMs: 500 };
  fake.handle('models.authStatus', () => ({ providers: [] }));
  await kit.call('models.authStatus', { agentId: 'm1' }, options);
  assert.deepEqual(fake.calls.at(-1), { method: 'models.authStatus', params: { agentId: 'm1' } });
  await assert.rejects(kit.callDynamic('health'), /use typed call/);
  await assert.rejects(kit.callDynamic('node.invoke.result'), /use typed call/);
  fake.handle('plugin.custom', () => 42);
  assert.equal(await kit.callDynamic('plugin.custom'), 42);
  const heard: string[] = [];
  const offAll = kit.onEvent('*', (_payload, name) => heard.push(`all:${name}`));
  const offAgent = kit.onEvent('agent', () => heard.push('agent'));
  fake.emit('agent', { runId: 'r1' }); fake.emit('tick', {});
  offAgent(); offAll(); fake.emit('agent', {});
  assert.deepEqual(heard, ['all:agent', 'agent', 'all:tick']);
}));

test('dynamic refusal stays in sync with every generated method', async () => withKit(async (kit) => {
  const generated = readFileSync(new URL('../src/generated/methods.ts', import.meta.url), 'utf8');
  const names = [...generated.matchAll(/^  '([^']+)': .*role: '(?:operator|node)'/gm)].map((match) => match[1]!);
  assert.equal(names.length, 393);
  for (const name of names) await assert.rejects(kit.callDynamic(name), /use typed call/);
}));

test('members validate and cache concurrent creation', async () => withKit(async (kit, fake) => {
  await assert.rejects(kit.ensureMember('M1'), /invalid member/);
  await assert.rejects(kit.ensureMember('a'.repeat(33)), /invalid member/);
  const [one, two] = await Promise.all([kit.ensureMember('m1'), kit.ensureMember('m1')]);
  assert.deepEqual(one, two);
  assert.equal(one.agentId, 'm1');
  assert.equal(fake.calls.filter(({ method }) => method === 'agents.create').length, 1);
  assert.deepEqual(await kit.ensureMember('m1'), one);
}));

test('close and bad protocol fail closed', async () => {
  await withKit(async (kit, fake) => {
    fake.drop('test');
    assert.deepEqual(kit.state, { phase: 'failed', why: 'handshake' });
    assert.equal(kit.hello, undefined);
  });
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o4-version-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: (ctx) => ({ ...fake.factory(ctx), start: async () => ({ protocol: 3, server: { version: 'old' }, methods: [], events: [] }) }) });
  try { await assert.rejects(kit.start(), /gateway protocol/); assert.equal(kit.state.phase, 'needs-update'); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('config patch keeps memory search disabled', async () => withKit(async (kit, fake) => {
  await kit.patchConfig({ memory: { search: { provider: 'openai', fallback: 'openai' } } });
  const patch = fake.calls.find(({ method }) => method === 'config.patch')?.params as { raw: string; baseHash: string };
  assert.equal(patch.baseHash, 'hash-1');
  assert.deepEqual(JSON.parse(patch.raw).memory.search, { provider: 'none', fallback: 'none' });
  assert.equal(typeof kit.memoryLimited('m1'), 'boolean');
  assert.ok(kit.doctorContext().entry.endsWith('openclaw.mjs'));
}));
