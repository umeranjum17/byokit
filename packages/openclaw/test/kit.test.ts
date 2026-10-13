import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { test } from 'node:test';
import { AuthStoreUnreadableError } from '../src/auth-store.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { RunRef } from '../src/types.ts';
import { hostKeySeal, osKeyringSeal, type KeyringBackend } from '../../secrets/src/index.ts';
import { stateWords } from '../src/words.ts';

async function withKit(fn: (kit: OpenClawKit, fake: ReturnType<typeof fakeGateway>) => Promise<void>) {
  const stateDir = scratchDir('o4');
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  try { await kit.start(); await fn(kit, fake); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
}

test('locked saved credentials resolve prepare/start, preserve the store and recover after unlock', async () => {
  const stateDir = scratchDir('o4-locked');
  const data = new Map<string, string>();
  let locked = false;
  const ring: KeyringBackend = {
    get(name) { if (locked) throw new Error('locked'); return data.get(name) ?? null; },
    set(name, value) { data.set(name, value); }, delete: name => data.delete(name),
  };
  const sealOptions = { service: 'o4-locked', stateDir, keyring: ring };
  const seal = osKeyringSeal(sealOptions);
  const root = join(stateDir, 'openclaw');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'auth.json'), 'saved-sign-in');
  const initial = new OpenClawKit({ stateDir, authSeal: seal, spawnEngine: false });
  await initial.prepare();
  const file = join(root, 'auth-store.sealed');
  const bytes = readFileSync(file);
  locked = true;
  let connected = 0;
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, authSeal: osKeyringSeal(sealOptions), spawnEngine: false,
    transport: ctx => { connected++; return fake.factory(ctx); } });
  await kit.prepare();
  assert.deepEqual(kit.state, { phase: 'locked' });
  assert.match(stateWords(kit.state), /saved sign-in is locked/);
  await Promise.all([kit.start(), kit.start()]);
  assert.deepEqual(kit.state, { phase: 'locked' });
  assert.equal(connected, 0);
  assert.deepEqual(readFileSync(file), bytes);
  await kit.stop();
  assert.deepEqual(readFileSync(file), bytes);
  locked = false;
  await kit.start();
  assert.equal(kit.state.phase, 'ready');
  assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'saved-sign-in');
  await kit.stop();
  // The next unlocked read also upgrades an existing engine snapshot under its lock.
  const dualKit = new OpenClawKit({ stateDir, authSeal: osKeyringSeal({ ...sealOptions, dualWrap: true }), spawnEngine: false, transport: fake.factory });
  await dualKit.prepare();
  assert.equal(readFileSync(file)[4], 3);
  locked = true;
  await dualKit.start();
  assert.equal(dualKit.state.phase, 'ready');
  assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'saved-sign-in');
  await dualKit.stop();
  assert.equal(readFileSync(file)[4], 3, 'locked stop keeps both wraps');
  locked = false;
});

test('wrong seal refuses prepare/start without changing sign-in; restoring the seal retries the same store', async () => {
  const stateDir = scratchDir('o4-unreadable');
  const root = join(stateDir, 'openclaw');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', 'auth.json'), 'saved-sign-in');
  const seal = hostKeySeal({ key: randomBytes(32), service: 'o4' });
  await new OpenClawKit({ stateDir, authSeal: seal, spawnEngine: false }).prepare();
  const file = join(root, 'auth-store.sealed');
  const bytes = readFileSync(file);
  const fake = fakeGateway();
  let currentSeal = hostKeySeal({ key: randomBytes(32), service: 'o4' });
  let connected = 0;
  const kit = new OpenClawKit({ stateDir, authSeal: {
    encryptString: text => currentSeal.encryptString(text),
    decryptString: data => currentSeal.decryptString(data),
  }, spawnEngine: false, transport: ctx => { connected++; return fake.factory(ctx); } });
  try {
    await assert.rejects(kit.prepare(), AuthStoreUnreadableError);
    await assert.rejects(kit.start(), { code: 'auth-store-unreadable', reason: 'auth-failed' });
    assert.deepEqual(kit.state, { phase: 'failed', why: 'auth-store-unreadable' });
    assert.match(stateWords(kit.state), /unchanged.*original key.*retry/);
    assert.equal(connected, 0);
    assert.equal(existsSync(join(root, 'state', 'auth.json')), false);
    assert.equal(readdirSync(root).some(name => name.includes('.unreadable-')), false);
    assert.deepEqual(readFileSync(file), bytes);
    await kit.stop();
    assert.deepEqual(readFileSync(file), bytes);
    currentSeal = seal;
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    assert.equal(connected, 1);
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'saved-sign-in');
    await kit.stop();
    await kit.start();
    assert.equal(readFileSync(join(root, 'state', 'auth.json'), 'utf8'), 'saved-sign-in');
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('call before start rejects instead of throwing synchronously', async () => {
  const stateDir = scratchDir('o4-notready');
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fakeGateway().factory });
  try { await assert.rejects(kit.call('models.authStatus', { agentId: 'm1' }), /gateway not ready/); }
  finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('a consumer that offers OpenRouter boots with its plugin allowed; defaults-only does not', async () => {
  const defaultsDir = scratchDir('o4-offered-defaults');
  const offeredDir = scratchDir('o4-offered');
  const allow = (dir: string) => (JSON.parse(readFileSync(join(dir, 'openclaw', 'openclaw.json'), 'utf8')) as
    { plugins: { allow: string[] } }).plugins.allow;
  const defaults = new OpenClawKit({ stateDir: defaultsDir, spawnEngine: false, transport: fakeGateway().factory });
  const offered = new OpenClawKit({ stateDir: offeredDir, spawnEngine: false, transport: fakeGateway().factory,
    offered: ['chatgpt', 'grok', 'copilot', 'openrouter'] });
  try {
    await defaults.start();
    await offered.start();
    assert.equal(defaults.state.phase, 'ready');
    assert.equal(offered.state.phase, 'ready');
    assert.ok(!allow(defaultsDir).includes('openrouter'), 'a defaults-only consumer never allows OpenRouter');
    assert.ok(allow(offeredDir).includes('openrouter'), 'the offered OpenRouter sign-in is allowed at boot');
  } finally {
    await defaults.stop(); await offered.stop();
    rmSync(defaultsDir, { recursive: true, force: true }); rmSync(offeredDir, { recursive: true, force: true });
  }
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
  const stateDir = scratchDir('o4-version');
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
  const stateDir = scratchDir('o5-gateall');
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
  const stateDir = scratchDir('o5-oldplugin');
  try {
    mkdirSync(join(stateDir, 'openclaw', 'plugin'), { recursive: true });
    writeFileSync(join(stateDir, 'openclaw', 'plugin', 'index.js'), '// an older, ungated plugin\n');
    await new OpenClawKit({ stateDir, spawnEngine: false, transport: fakeGateway().factory }).prepare();
    assert.equal(readFileSync(join(stateDir, 'openclaw', 'plugin', 'index.js'), 'utf8'),
      readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8'));
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});

test('API key is explicit, member-local, secret-free, and removed without fallback', async () => withKit(async (kit, fake) => {
  const canary = 'CANARY-PAID-KEY-928374';
  const views: unknown[] = [];
  const off = kit.onEvent('*', (e) => views.push(e));
  assert.equal(await kit.signedIn('m1', 'openai'), false);
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: canary }), { status: 'ok' });
  assert.deepEqual(await kit.providers('m1'), [], 'providers stays the member sign-ins');
  assert.deepEqual(await kit.providers('m2'), []);
  assert.equal(await kit.signedIn('m1', 'openai'), true, 'a ready key counts for its provider');
  assert.equal(await kit.signedIn('m1', 'anthropic'), false);
  assert.equal(await kit.signedIn('m2', 'openai'), false);
  const activation = fake.calls.find((c) => c.method === 'openclaw.setup.activate')?.params as Record<string, unknown>;
  assert.equal(activation.kind, 'api-key');
  assert.equal(activation.agentId, 'byokit-key-m1');
  assert.equal(activation.apiKey, '[redacted]');
  const createdKey = fake.calls.findIndex((c) => c.method === 'agents.create' && (c.params as { name?: string }).name === 'byokit-key-m1');
  const activatedKey = fake.calls.findIndex((c) => c.method === 'openclaw.setup.activate');
  assert.ok(fake.calls.slice(createdKey + 1, activatedKey).some((c) => c.method === 'agents.list'),
    'key creation awaits the published roster/owner boundary, exactly as member creation does');
  // The key override already uses explicit-model admission on its own agent, including deferred-owner refresh.
  fake.handle('models.authStatus', (p) => p.agentId === 'byokit-key-m1' ? p.refresh
    ? { providers: [{ provider: 'openai', profiles: [{ status: 'static' }] }] }
    : { providers: [], unavailable: { code: 'PREPARED_MODEL_AUTH_UNAVAILABLE', message: 'owner not prepared' } }
    : { providers: [] });
  const admissionAt = fake.calls.length;
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat', auth: 'apiKey', message: 'Hello' });
  assert.deepEqual(fake.calls.slice(admissionAt, fake.calls.findIndex((c) => c.method === 'agent'))
    .filter((c) => c.method === 'models.authStatus')
    .map((c) => { const p = c.params as { agentId: string; refresh?: boolean }; return [p.agentId, p.refresh === true]; }),
    [['byokit-key-m1', false], ['byokit-key-m1', true]]);
  assert.equal(end.ok, true);
  const request = fake.calls.find((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.equal(request.agentId, 'byokit-key-m1');
  assert.equal(request.sessionKey, 'agent:byokit-key-m1:chat');
  assert.equal(request.model, 'fake-key-model');
  const count = fake.calls.filter((c) => c.method === 'agent').length;
  const other = await kit.run({ member: 'm2', sessionKey: 'agent:m2:chat', auth: 'apiKey', message: 'Hello' });
  assert.deepEqual(other, { ok: false, kind: 'signed-out', message: 'Add an API key to use this option.' });
  await kit.call('models.authLogout', { agentId: 'byokit-key-m1', provider: 'openai' });
  assert.deepEqual(await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat', auth: 'apiKey', message: 'Hello' }), other);
  assert.equal(await kit.signedIn('m1', 'openai'), false, 'a cleared key no longer counts');
  assert.equal(fake.calls.filter((c) => c.method === 'agent').length, count);
  fake.failNext('agent', '429 rate limit: Try again in 30 minutes');
  const resting = await kit.run({ member: 'm1', sessionKey: 'agent:m1:normal', message: 'Hello' });
  assert.ok(!resting.ok && 'kind' in resting && resting.kind === 'resting');
  assert.equal((fake.calls.findLast((c) => c.method === 'agent')?.params as Record<string, unknown>).agentId, 'm1');
  assert.equal(JSON.stringify([end, other, views, fake.calls]).includes(canary), false);
  off();
}));

test('a Go plan key registers the live catalog once and runs any Go model', async () => withKit(async (kit, fake) => {
  const patches = () => fake.calls.filter((c) => c.method === 'config.patch').length;
  const goModels = async () => ((await kit.call('config.get', {}) as { config: { models?: { providers?: Record<string,
    { models?: { id: string; api?: string }[] }> } } }).config.models?.providers?.['opencode-go']?.models);
  const settled = async (n: number) => { for (let i = 0; i < 100 && fake.calls.filter((c) => c.method === 'byokit.catalog').length < n; i++) await delay(10); await delay(20); };
  await settled(1);
  assert.equal(await goModels(), undefined, 'no key, nothing registered');
  const before = patches();
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-GO-KEY', model: 'opencode-go/fake-live-model' }), { status: 'ok' });
  assert.deepEqual((await kit.models('m1', { authChoice: 'opencode-go' })).map((m) => m.id),
    ['opencode-go/fake-key-model', 'opencode-go/fake-live-model']);
  assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }),
    { ok: true, model: 'opencode-go/fake-live-model' });
  const ownerAt = fake.calls.findLastIndex((c) => c.method === 'models.authStatus'
    && (c.params as { agentId?: string; refresh?: boolean }).agentId === 'byokit-key-m1'
    && (c.params as { refresh?: boolean }).refresh === true);
  assert.ok(ownerAt > fake.calls.findLastIndex((c) => c.method === 'config.patch'), 'owner is prepared after catalog registration before addKey returns');
  assert.equal(fake.calls.slice(0, ownerAt + 1).filter((c) => c.method === 'models.authStatus'
    && (c.params as { refresh?: boolean }).refresh === true).length, 1, 'prepared once, not on ordinary runs');
  assert.deepEqual((await goModels())?.map((m) => [m.id, m.api]),
    [['fake-key-model', 'openai-completions'], ['fake-live-model', 'openai-responses']]);
  assert.equal(patches(), before + 1);
  assert.deepEqual(await kit.addKey('m2', { authChoice: 'opencode-go', apiKey: 'CANARY-GO-KEY' }), { status: 'ok' });
  await settled(3);
  assert.equal(patches(), before + 1, 'an unchanged catalog is never rewritten');
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:muse', auth: 'apiKey', message: 'Hi' });
  assert.equal(end.ok, true);
  assert.equal((fake.calls.findLast((c) => c.method === 'agent')?.params as Record<string, unknown>).model, 'fake-live-model');
  assert.deepEqual(await kit.run({ member: 'm1', sessionKey: 'agent:m1:muse', auth: 'apiKey', model: 'openai/gpt-5.1', message: 'Hi' }),
    { ok: false, kind: 'plan', message: 'Choose a model of the provider saved with this key.' });
  const rejected = await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-GO-KEY', model: 'opencode-go/not-a-model' });
  assert.deepEqual(rejected, { status: 'not_included', reason: 'model' });
  assert.equal(JSON.stringify([rejected, fake.calls]).includes('CANARY-GO-KEY'), false);
  assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
}));

test('Go discovery without a live catalog uses only the key agent and refuses its unavailable models', async () => withKit(async (kit, fake) => {
  fake.handle('byokit.catalog', () => ({ ok: false, reason: 'no-key' }));
  await kit.patchConfig({ models: { providers: { 'opencode-go': { models: [{ id: 'default' }] } } } });
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-GO-FALLBACK',
    model: 'opencode-go/default' }), { status: 'ok' });
  assert.deepEqual(await kit.models('m1', { authChoice: 'opencode-go' }),
    [{ id: 'opencode-go/default', name: 'Default', available: true }]);
  assert.ok(fake.calls.filter((c) => c.method === 'models.list').every((c) =>
    (c.params as { agentId?: string }).agentId === 'byokit-key-m1'), 'the ordinary member cannot supply key models');
  fake.handle('models.list', () => ({ models: [{ id: 'opencode-go/default', provider: 'opencode-go',
    name: 'Default', available: false, unavailableReason: 'missing-auth' }] }));
  const before = fake.calls.length;
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-GO-FALLBACK',
    model: 'opencode-go/default' }), { status: 'not_included', reason: 'model' });
  assert.ok(!fake.calls.slice(before).some((c) => c.method === 'byokit.keys'
    && (c.params as { action?: string }).action === 'seal'), 'an unavailable discovery row is never saved');
  assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
}));

test('a catalog failure is logged without the key, no key is silent, and signedIn probes the key once', async () => {
  const stateDir = scratchDir('o4-catalog-log');
  const fake = fakeGateway();
  const lines: string[] = [];
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, log: (line) => lines.push(line) });
  const catalogLines = () => lines.filter((line) => line.startsWith('catalog sync'));
  const until = async (ok: () => boolean) => { for (let i = 0; i < 100 && !ok(); i++) await delay(10); await delay(20); };
  const calls = (method: string) => fake.calls.filter((c) => c.method === method).length;
  try {
    await kit.start();
    await until(() => calls('byokit.catalog') >= 1);
    assert.deepEqual(catalogLines(), [], 'no key is not a failure');
    fake.handle('byokit.catalog', () => ({ ok: false, reason: 'failed' }));
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-LOG-KEY' }), { status: 'ok' });
    await until(() => catalogLines().length > 0);
    assert.deepEqual(catalogLines(), ['catalog sync opencode-go: failed']);
    assert.equal(lines.join('\n').includes('CANARY-LOG-KEY'), false);
    fake.handle('byokit.catalog', () => { throw new Error('gateway restarting ENGINE-ECHO-TEXT'); });
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-LOG-KEY' }), { status: 'ok' });
    await until(() => catalogLines().length > 1);
    assert.deepEqual(catalogLines(), ['catalog sync opencode-go: failed', 'catalog sync opencode-go: failed']);
    assert.equal(lines.join('\n').includes('ENGINE-ECHO-TEXT'), false);
    fake.handle('byokit.keys', (p) => {
      if (p.action === 'ready') throw Object.assign(new Error('gateway restarting'), { code: 'UNAVAILABLE', retryable: true });
      return { ok: false };
    });
    const before = calls('byokit.keys');
    assert.equal(await kit.signedIn('m2', 'opencode-go'), false);
    assert.equal(calls('byokit.keys') - before, 1, 'one ready probe, no retry while the gateway restarts');
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a catalog sync that races a restart fails key preparation without logging diagnostics', async () => {
  const stateDir = scratchDir('o4-catalog-restart');
  const fake = fakeGateway();
  const lines: string[] = [];
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false, log: (line) => lines.push(line) });
  let raced = false;
  try {
    await kit.start();
    fake.handle('byokit.catalog', () => { raced = true; fake.drop('gateway restarting'); throw new Error('transport closed'); });
    assert.deepEqual(await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: 'CANARY-RACE-KEY' }), { status: 'retry', reason: 'engine' });
    assert.equal(fake.calls.some((c) => c.method === 'byokit.keys' && (c.params as { action?: string }).action === 'seal'), false,
      'a dropped preparation never publishes a ready replacement');
    for (let i = 0; i < 100 && !raced; i++) await delay(10);
    await delay(20);
    assert.equal(raced, true);
    assert.deepEqual(lines.filter((line) => line.startsWith('catalog sync')), []);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('ready runs reuse only witnessed, bounded member auth; mutations, expiry and disconnect recheck', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const stateDir = scratchDir('run-admission');
  const fake = fakeGateway();
  let loggedIn = true;
  fake.handle('models.authStatus', () => ({ providers: [] }));
  fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', credentials: loggedIn }] }));
  fake.handle('models.authLogout', () => { loggedIn = false; return {}; });
  fake.handle('openclaw.setup.activate', () => { loggedIn = true; return { ok: true }; });
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  const spec = { member: 'umer', sessionKey: 'agent:umer:chat', message: 'Hello', model: 'claude-cli/claude-sonnet-5' };
  const detects = () => fake.calls.filter(c => c.method === 'openclaw.setup.detect').length;
  const run = () => kit.run(spec);
  try {
    await kit.start();
    assert.ok(await kit.signedIn('umer', 'claude-cli'));
    assert.ok((await run()).ok);
    assert.ok((await run()).ok);
    assert.equal(detects(), 1, 'the prepared check is reused before both runs');
    t.mock.timers.tick(30_001);
    assert.ok((await run()).ok);
    assert.equal(detects(), 2, 'warm snapshots have a hard lifetime');
    await kit.ensureMember('scout');
    assert.ok((await run()).ok); // agent creation invalidates shared auth state
    const count = detects();
    assert.ok((await kit.run({ ...spec, member: 'scout', sessionKey: 'agent:scout:chat' })).ok);
    assert.equal(detects(), count + 1, 'no cross-member reuse');
    const credentials = join(stateDir, 'openclaw/home/.claude/.credentials.json');
    mkdirSync(join(stateDir, 'openclaw/home/.claude'), { recursive: true });
    writeFileSync(credentials, 'task-owned synthetic credential change');
    loggedIn = false;
    const agentCalls = fake.calls.filter(c => c.method === 'agent').length;
    const out = await run();
    assert.ok(!out.ok && 'kind' in out && out.kind === 'signed-out');
    assert.equal(fake.calls.filter(c => c.method === 'agent').length, agentCalls);
    await kit.call('openclaw.setup.activate', { agentId: 'umer', kind: 'claude-cli' });
    assert.ok((await run()).ok);
    fake.failNext('agent', '401 Unauthorized: your sign-in has expired');
    const revoked = await run();
    assert.ok(!revoked.ok && 'kind' in revoked && revoked.kind === 'signed-out', JSON.stringify(revoked));
    await kit.call('models.authLogout', { agentId: 'umer', provider: 'claude-cli' }); // an auth mutation through the kit
    assert.ok(!(await run()).ok);
    await kit.stop();
    await assert.rejects(run(), /gateway not ready/);
    loggedIn = true;
    await kit.start();
    const restarted = detects();
    assert.ok((await run()).ok);
    assert.equal(detects(), restarted + 1);
    // A reported OAuth expiry caps reuse even inside the 30s lifetime.
    const expiresAt = Date.now() + 1_000;
    fake.handle('models.authStatus', () => ({ providers: [{ provider: 'openai', profiles: [
      { status: Date.now() < expiresAt ? 'ok' : 'expired', expiresAt },
    ] }] }));
    const oauth = { ...spec, model: 'openai/gpt-5.1' };
    assert.ok((await kit.run(oauth)).ok);
    t.mock.timers.tick(1_001);
    const expired = await kit.run(oauth);
    assert.ok(!expired.ok && 'kind' in expired && expired.kind === 'signed-out');
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('readiness warms profile admission with or without native auth despite unusable expiries', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  for (const native of [false, true]) await withKit(async (kit, fake) => {
    const expiresAt = Date.now() + 1_000;
    fake.handle('models.authStatus', () => ({ providers: [
      { provider: 'openai', status: 'expired', profiles: [
        { status: 'expired', expiresAt: Date.now() - 1_000 },
        { status: Date.now() < expiresAt ? 'ok' : 'expired', expiresAt },
      ] },
      { provider: 'anthropic', profiles: [{ status: 'expired', expiresAt: Date.now() - 1_000 }] },
      { provider: 'claude-cli', profiles: [{ status: 'expired', expiresAt: Date.now() - 1_000 }] },
    ] }));
    fake.handle('openclaw.setup.detect', () => ({ candidates: [{ kind: 'claude-cli', credentials: native }] }));
    assert.ok(await kit.signedIn('umer', 'openai'));
    const spec = { member: 'umer', sessionKey: 'agent:umer:chat', message: 'Hello', model: 'openai/gpt-5.1' };
    const warmRun = async (model: string) => {
      const before = fake.calls.length;
      assert.ok((await kit.run({ ...spec, model })).ok);
      const calls = fake.calls.slice(before);
      const agentAt = calls.findIndex(c => c.method === 'agent');
      assert.ok(agentAt >= 0);
      assert.equal(calls.slice(0, agentAt).some(c => c.method === 'models.authStatus'), false);
      assert.equal(calls.some(c => c.method === 'openclaw.setup.detect'), false);
    };
    await warmRun(spec.model);
    await warmRun(spec.model);
    if (native) await warmRun('claude-cli/claude-sonnet-5');
    else {
      const out = await kit.run({ ...spec, model: 'claude-cli/claude-sonnet-5' });
      assert.ok(!out.ok && 'kind' in out && out.kind === 'signed-out');
    }
    t.mock.timers.tick(1_001);
    const before = fake.calls.length;
    const expired = await kit.run(spec);
    assert.ok(!expired.ok && 'kind' in expired && expired.kind === 'signed-out');
    assert.equal(fake.calls.slice(before).filter(c => c.method === 'models.authStatus').length, 1);
    if (native) {
      assert.ok(await kit.signedIn('umer', 'claude-cli'));
      await warmRun('claude-cli/claude-sonnet-5');
    }
  });
});

test('key entry refuses unavailable routes and hides even an engine error that echoes the secret', async () => withKit(async (kit, fake) => {
  const key = 'CANARY-ERROR-KEY-12345';
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai', apiKey: key }), { status: 'not_included', reason: 'model' });
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: ' ' }), { status: 'invalid', reason: 'empty' });
  assert.equal(fake.calls.some((c) => c.method === 'openclaw.setup.activate'), false, 'a blank key never reaches the provider');
  for (const throws of [true, false]) {
    fake.handle('models.authStatus', () => {
      if (throws) throw Object.assign(new Error(key), { code: 'ECONNRESET' });
      return { unavailable: { message: key } };
    });
    const prepared = await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: key });
    assert.deepEqual(prepared, { status: 'retry', reason: 'engine' }, 'owner preparation is an engine failure, never a bad key');
    assert.equal(JSON.stringify([prepared, fake.calls]).includes(key), false);
    assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
    assert.equal((await kit.run({ member: 'm1', sessionKey: 'agent:m1:failed-owner', auth: 'apiKey', message: 'Hello' })).ok, false);
    assert.equal(fake.calls.some((c) => c.method === 'agent'), false, 'failed prepared replacement cannot fall back');
  }
  fake.handle('openclaw.setup.activate', () => { throw new Error(key); });
  const end = await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: key });
  // The engine may have taken a key whose activation threw after it was sent: the key is cleared and the add is retry.
  assert.deepEqual(end, { status: 'retry', reason: 'engine' });
  assert.equal(JSON.stringify([end, fake.calls]).includes(key), false);
  // The typed probe result, not its diagnostic text, decides the public reason. Only a refused key is invalid.
  for (const [status, expected, reason] of [['auth', 'invalid', 'auth'], ['timeout', 'retry', 'network'],
    ['format', 'retry', 'inference'], ['unknown', 'retry', 'inference'], ['billing', 'invalid', 'billing'], ['rate_limit', 'retry', 'busy'],
    ['unavailable', 'not_included', 'model']] as const) {
    fake.handle('openclaw.setup.activate', () => ({ ok: false, status, error: key, lines: [key] }));
    const result = await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key });
    assert.deepEqual(result, { status: expected, reason });
    assert.equal(JSON.stringify([result, fake.calls]).includes(key), false);
    assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
  }
  for (const [code, retryable, reason] of [['CLIENT_TIMEOUT', false, 'network'], ['ECONNRESET', false, 'network'],
    ['UNAVAILABLE', true, 'busy'], ['INVALID_REQUEST', false, 'inference']] as const) {
    fake.handle('openclaw.setup.activate', () => { throw Object.assign(new Error(key), { code, retryable }); });
    const result = await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key });
    assert.deepEqual(result, { status: 'retry', reason });
    assert.equal(JSON.stringify([result, fake.calls]).includes(key), false);
  }
  await assert.rejects(kit.ensureMember('byokit-key-m1'), /invalid member/);
}));

test('a chosen live model the engine did not register is a retry and nothing is sealed', async () => withKit(async (kit, fake) => {
  const key = 'CANARY-UNREGISTERED-KEY-306';
  fake.handle('config.patch', () => { throw new Error('config write refused'); });
  const result = await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key, model: 'opencode-go/fake-live-model' });
  assert.deepEqual(result, { status: 'retry', reason: 'model' });
  assert.equal(JSON.stringify([result, fake.calls]).includes(key), false);
  assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
}));

test('a model is listed and saved only for the Go live-catalog route; other routes refuse it before activation', async () => withKit(async (kit, fake) => {
  const key = 'CANARY-NONLIVE-MODEL-204';
  assert.deepEqual(await kit.models('m1', { authChoice: 'openai-api-key' }), []);
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: key, model: 'openai/gpt-5.1' }),
    { status: 'not_included', reason: 'model' });
  assert.equal(fake.calls.some((c) => c.method === 'openclaw.setup.activate' || c.method === 'agents.create'), false);
  assert.equal(JSON.stringify(fake.calls).includes(key), false);
}));

test('a typed timeout reply is a retry, never a claim that the key is invalid', async () => withKit(async (kit, fake) => {
  const key = 'CANARY-TIMEOUT-KEY-881';
  fake.handle('openclaw.setup.activate', () => ({ ok: false, status: 'timeout', error: key }));
  const result = await kit.addKey('m1', { authChoice: 'opencode-go', apiKey: key });
  assert.deepEqual(result, { status: 'retry', reason: 'network' });
  assert.equal(JSON.stringify([result, fake.calls]).includes(key), false);
  assert.deepEqual(await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }), { ok: false, absent: true });
}));

async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('kit start clears an unsealed key agent and keeps a ready one', async () => {
  const stateDir = scratchDir('o4-key-sweep');
  const fake = fakeGateway();
  const clears = () => fake.calls.filter((c) => c.method === 'byokit.keys'
    && (c.params as { action?: string }).action === 'clear');
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  try {
    await kit.start();
    // A failed gateway restart after activation: the engine took the key but the seal never ran, and the abandon
    // clear was refused while the gateway was down. Drive that state directly: activation without a seal.
    await kit.ensureMember('m1');
    await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'byokit-key-m1',
      authChoice: 'openai-api-key', apiKey: 'CANARY-UNSEALED-KEY-517' });
    assert.deepEqual(await kit.addKey('m2', { authChoice: 'openai-api-key', apiKey: 'CANARY-SEALED-KEY-642' }), { status: 'ok' });
    await kit.stop();
    const restarted = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
    try {
      await restarted.start();
      await until(() => clears().length === 1);
      assert.deepEqual(clears().at(-1)?.params, { member: 'm1', action: 'clear' });
      assert.deepEqual(await restarted.run({ member: 'm1', sessionKey: 'agent:m1:chat', auth: 'apiKey', message: 'Hello' }),
        { ok: false, kind: 'signed-out', message: 'Add an API key to use this option.' });
      assert.ok((await restarted.run({ member: 'm2', sessionKey: 'agent:m2:chat', auth: 'apiKey', message: 'Hello' })).ok);
      assert.equal(JSON.stringify(fake.calls).includes('CANARY-UNSEALED-KEY-517'), false);
      assert.equal(JSON.stringify(fake.calls).includes('CANARY-SEALED-KEY-642'), false);
    } finally { await restarted.stop(); }
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('an add that seals during the start sweep keeps its key', async () => {
  const stateDir = scratchDir('o4-key-sweep-add');
  const fake = fakeGateway();
  const first = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  await first.start();
  await first.ensureMember('m1');
  await first.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'byokit-key-m1',
    authChoice: 'openai-api-key', apiKey: 'CANARY-SWEEP-UNSEALED-771' });
  await first.stop();
  // Hold the sweep between its ready read (unsealed) and its clear, the window where a seal would be wiped.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const gated = (ctx: Parameters<typeof fake.factory>[0]) => {
    const transport = fake.factory(ctx);
    const request: typeof transport.request = async (method, params, options) => {
      const reply = await transport.request(method, params, options);
      const p = params as { member?: string; action?: string } | undefined;
      if (method === 'byokit.keys' && p?.member === 'm1' && p.action === 'ready' && !held) { held = true; await gate; }
      return reply;
    };
    return { ...transport, request };
  };
  const second = new OpenClawKit({ stateDir, spawnEngine: false, transport: gated });
  try {
    await second.start();
    await until(() => held);
    const added = second.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'CANARY-SWEEP-SEALED-772' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    assert.deepEqual(await added, { status: 'ok' });
    assert.equal((await fake.transport.request('byokit.keys', { member: 'm1', action: 'ready' }) as { ok: boolean }).ok, true);
    assert.ok((await second.run({ member: 'm1', sessionKey: 'agent:m1:chat', auth: 'apiKey', message: 'Hello' })).ok);
  } finally { release(); await second.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('an interrupted start sweep runs again on the next ready and a key with its marker survives', async () => {
  const stateDir = scratchDir('o4-key-sweep-retry');
  const fake = fakeGateway();
  const clears = () => fake.calls.filter((c) => c.method === 'byokit.keys'
    && (c.params as { action?: string }).action === 'clear');
  const first = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  await first.start();
  await first.ensureMember('m1');
  await first.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'byokit-key-m1',
    authChoice: 'openai-api-key', apiKey: 'CANARY-RETRY-UNSEALED-994' });
  assert.deepEqual(await first.addKey('m2', { authChoice: 'openai-api-key', apiKey: 'CANARY-RETRY-SEALED-995' }), { status: 'ok' });
  await first.stop();
  // The first sweep reads m1 (absent marker) and is held there while the gateway drops, so its clear is refused.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let held = false;
  const gated = (ctx: Parameters<typeof fake.factory>[0]) => {
    const transport = fake.factory(ctx);
    const request: typeof transport.request = async (method, params, options) => {
      const p = params as { member?: string; action?: string } | undefined;
      // m2's marker is present but its store no longer matches: the engine replies not ready without the absent flag.
      if (method === 'byokit.keys' && p?.member === 'm2' && p.action === 'ready') return { ok: false };
      const reply = await transport.request(method, params, options);
      if (method === 'byokit.keys' && p?.member === 'm1' && p.action === 'ready' && !held) { held = true; await gate; }
      return reply;
    };
    return { ...transport, request };
  };
  const second = new OpenClawKit({ stateDir, spawnEngine: false, transport: gated });
  try {
    await second.start();
    await until(() => held);
    fake.drop('test');
    assert.equal(second.state.phase, 'failed');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(clears().length, 0);
    await second.start();
    await until(() => clears().length === 1);
    assert.deepEqual(clears().at(-1)?.params, { member: 'm1', action: 'clear' });
    assert.equal(second.state.phase, 'ready');
  } finally { await second.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('a start sweep whose clear the engine refuses runs again on the next connect', async () => {
  const stateDir = scratchDir('o4-key-sweep-refused');
  const fake = fakeGateway();
  const clears = () => fake.calls.filter((c) => c.method === 'byokit.keys'
    && (c.params as { action?: string }).action === 'clear');
  const first = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  await first.start();
  await first.ensureMember('m1');
  await first.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'byokit-key-m1',
    authChoice: 'openai-api-key', apiKey: 'CANARY-REFUSED-UNSEALED-436' });
  await first.stop();
  let refused = false;
  const refusing = (ctx: Parameters<typeof fake.factory>[0]) => {
    const transport = fake.factory(ctx);
    const request: typeof transport.request = async (method, params, options) => {
      const reply = await transport.request(method, params, options);
      const p = params as { member?: string; action?: string } | undefined;
      if (method === 'byokit.keys' && p?.member === 'm1' && p.action === 'clear' && !refused) {
        refused = true;
        return { ok: false };
      }
      return reply;
    };
    return { ...transport, request };
  };
  const second = new OpenClawKit({ stateDir, spawnEngine: false, transport: refusing });
  try {
    await second.start();
    await until(() => refused);
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.drop('test');
    await second.start();
    await until(() => clears().length === 2);
    assert.deepEqual(clears().at(-1)?.params, { member: 'm1', action: 'clear' });
    assert.equal(second.state.phase, 'ready');
  } finally { await second.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('a start sweep that cannot check a key runs again on the next connect', async () => {
  const stateDir = scratchDir('o4-key-sweep-unchecked');
  const fake = fakeGateway();
  const clears = () => fake.calls.filter((c) => c.method === 'byokit.keys'
    && (c.params as { action?: string }).action === 'clear');
  const first = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  await first.start();
  await first.ensureMember('m1');
  await first.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'byokit-key-m1',
    authChoice: 'openai-api-key', apiKey: 'CANARY-UNCHECKED-UNSEALED-518' });
  await first.stop();
  let unchecked = false;
  const failing = (ctx: Parameters<typeof fake.factory>[0]) => {
    const transport = fake.factory(ctx);
    const request: typeof transport.request = async (method, params, options) => {
      const reply = await transport.request(method, params, options);
      const p = params as { member?: string; action?: string } | undefined;
      if (method === 'byokit.keys' && p?.member === 'm1' && p.action === 'ready' && !unchecked) {
        unchecked = true;
        return { ok: false };
      }
      return reply;
    };
    return { ...transport, request };
  };
  const second = new OpenClawKit({ stateDir, spawnEngine: false, transport: failing });
  try {
    await second.start();
    await until(() => unchecked);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(clears().length, 0);
    fake.drop('test');
    await second.start();
    await until(() => clears().length === 1);
    assert.deepEqual(clears().at(-1)?.params, { member: 'm1', action: 'clear' });
    assert.equal(second.state.phase, 'ready');
  } finally { await second.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('a reconnect after a gateway drop does not clear an unsealed key', async () => {
  const stateDir = scratchDir('o4-key-reconnect');
  const fake = fakeGateway();
  const clears = () => fake.calls.filter((c) => c.method === 'byokit.keys'
    && (c.params as { action?: string }).action === 'clear');
  const kit = new OpenClawKit({ stateDir, spawnEngine: false, transport: fake.factory });
  try {
    await kit.start();
    await kit.ensureMember('m1');
    await kit.call('openclaw.setup.activate', { kind: 'api-key', agentId: 'byokit-key-m1',
      authChoice: 'openai-api-key', apiKey: 'CANARY-RECONNECT-UNSEALED-883' });
    const before = clears().length;
    fake.drop('test');
    await kit.start();
    assert.equal(kit.state.phase, 'ready');
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(clears().length, before);
  } finally { await kit.stop(); rmSync(stateDir, { recursive: true, force: true }); }
});

test('schema validation precedes explicit API-key readiness and keeps its snapshot across that await', async () => withKit(async (kit, fake) => {
  const before = fake.calls.length;
  await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1:json', auth: 'apiKey', message: 'Report',
    schema: { format: 'email' } as never }), /invalid or unsupported output schema/);
  assert.equal(fake.calls.length, before);
  assert.deepEqual(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'CANARY-SCHEMA-KEY' }), { status: 'ok' });
  const schema = { type: 'string', enum: ['before'] } as const;
  fake.handle('byokit.keys', () => {
    (schema.enum as unknown as string[])[0] = 'after';
    return { ok: true, model: 'openai/fake-key-model' };
  });
  fake.handle('agent', () => ({ runId: 'schema', status: 'ok', result: { payloads: [{ text: '"before"' }] } }));
  fake.handle('agent.wait', () => ({ status: 'ok', terminalReply: { text: '"before"' } }));
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:json', auth: 'apiKey', message: 'Report', schema });
  assert.ok(end.ok);
  const data: 'before' | undefined = end.data;
  assert.equal(data, 'before');
  const request = fake.calls.findLast((c) => c.method === 'agent')?.params as Record<string, unknown>;
  assert.equal(request.agentId, 'byokit-key-m1');
  assert.equal(request.sessionKey, 'agent:byokit-key-m1:json');
  assert.ok(String(request.extraSystemPrompt).includes('"enum":["before"]'));
}));
