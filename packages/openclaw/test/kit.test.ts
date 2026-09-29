import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { RunRef } from '../src/types.ts';

async function withKit(fn: (kit: OpenClawKit, fake: ReturnType<typeof fakeGateway>) => Promise<void>) {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o4-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  try { await kit.start(); await fn(kit, fake); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}

test('call before start rejects instead of throwing synchronously', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o4-notready-'));
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fakeGateway().factory });
  try { await assert.rejects(kit.call('models.authStatus', { agentId: 'm1' }), /gateway not ready/); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

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

test('typed call passes options through unchanged', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o4-options-'));
  const fake = fakeGateway();
  let seen: unknown;
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: (ctx) => {
    const transport = fake.factory(ctx);
    return { ...transport, request: (method, params, options) => { seen = options; return transport.request(method, params, options); } };
  } });
  try {
    await kit.start();
    const options = { timeoutMs: 987, signal: new AbortController().signal };
    await kit.call('models.authStatus', { agentId: 'm1' }, options);
    assert.equal(seen, options);
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

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

/** A kit with the app tool crew_x whose gate records every call and denies it. */
async function withDenyingKit(
  o: { gateBuiltins?: boolean },
  fn: (kit: OpenClawKit, seen: { gated: [string, unknown][]; called: string[] }) => Promise<void>,
) {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o5-gateall-'));
  const seen = { gated: [] as [string, unknown][], called: [] as string[] };
  const kit = new OpenClawKit({
    stateDir, spawnEngine: false, transport: fakeGateway().factory, ...o,
    tools: [{ name: 'crew_x', description: 'An app tool.', parameters: { type: 'object' } }],
    host: {
      gate: async (_run: RunRef, tool: string, _input: Record<string, unknown>, info: { builtin: boolean }) =>
        (seen.gated.push([tool, info]), { allow: false, reason: 'no' }),
      call: async (_run: RunRef, tool: string) => (seen.called.push(tool), 'ran'),
    },
  });
  try { await kit.start(); await kit.ensureMember('m1'); await fn(kit, seen); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}

test('a builtin the model calls reaches host.gate by default and is denied', async () => withDenyingKit({}, async (kit, seen) => {
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:gate:1', message: '[tool web_fetch {"url":"https://example.invalid"}]' });
  assert.ok(end.ok, JSON.stringify(end));
  assert.deepEqual(seen.gated, [['web_fetch', { builtin: true }]]);
  assert.deepEqual(seen.called, []);
}));

test('gateBuiltins false gates only the app tools', async () => withDenyingKit({ gateBuiltins: false }, async (kit, seen) => {
  await kit.run({ member: 'm1', sessionKey: 'agent:m1:gate:2', message: '[tool web_fetch {}] [tool crew_x {}]' });
  assert.deepEqual(seen.gated, [['crew_x', { builtin: false }]]);
}));

test('a tool name the engine would rewrite before the gate is refused', () => {
  const host = { gate: async () => ({ allow: true as const }), call: async () => '' };
  for (const name of ['crewNote', 'apply-patch', 'bash', 'cron', '9x']) {
    assert.throws(() => new OpenClawKit({ stateDir: '.', spawnEngine: false, host,
      tools: [{ name, description: 'x', parameters: { type: 'object' } }] }), /invalid tool name/);
  }
});

test('prepare replaces a plugin left by an older kit', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o5-oldplugin-'));
  try {
    mkdirSync(join(stateDir, 'openclaw', 'plugin'), { recursive: true });
    writeFileSync(join(stateDir, 'openclaw', 'plugin', 'index.js'), '// an older, ungated plugin\n');
    await new OpenClawKit({ stateDir, spawnEngine: false, transport: fakeGateway().factory }).prepare();
    assert.equal(readFileSync(join(stateDir, 'openclaw', 'plugin', 'index.js'), 'utf8'),
      readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8'));
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
