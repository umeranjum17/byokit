import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
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

test('typed call passes options through unchanged', async () => {
  const stateDir = scratchDir('o4-options');
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
  assert.equal(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: canary }), 'ok');
  assert.deepEqual(await kit.providers('m1'), []);
  assert.deepEqual(await kit.providers('m2'), []);
  const activation = fake.calls.find((c) => c.method === 'openclaw.setup.activate')?.params as Record<string, unknown>;
  assert.equal(activation.kind, 'api-key');
  assert.equal(activation.agentId, 'byokit-key-m1');
  assert.equal(activation.apiKey, '[redacted]');
  const end = await kit.run({ member: 'm1', sessionKey: 'agent:m1:chat', auth: 'apiKey', message: 'Hello' });
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
  assert.equal(fake.calls.filter((c) => c.method === 'agent').length, count);
  fake.failNext('agent', '429 rate limit: Try again in 30 minutes');
  const resting = await kit.run({ member: 'm1', sessionKey: 'agent:m1:normal', message: 'Hello' });
  assert.ok(!resting.ok && 'kind' in resting && resting.kind === 'resting');
  assert.equal((fake.calls.findLast((c) => c.method === 'agent')?.params as Record<string, unknown>).agentId, 'm1');
  assert.equal(JSON.stringify([end, other, views, fake.calls]).includes(canary), false);
  off();
}));

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
    await kit.signOut('umer', 'claude-cli');
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
  assert.equal(await kit.addKey('m1', { authChoice: 'openai', apiKey: key }), 'not_included');
  assert.equal(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: ' ' }), 'invalid');
  fake.handle('openclaw.setup.activate', () => { throw new Error(key); });
  const end = await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: key });
  assert.equal(end, 'invalid');
  assert.equal(JSON.stringify([end, fake.calls]).includes(key), false);
  await assert.rejects(kit.ensureMember('byokit-key-m1'), /invalid member/);
}));

test('schema validation precedes explicit API-key readiness and keeps its snapshot across that await', async () => withKit(async (kit, fake) => {
  const before = fake.calls.length;
  await assert.rejects(kit.run({ member: 'm1', sessionKey: 'agent:m1:json', auth: 'apiKey', message: 'Report',
    schema: { format: 'email' } as never }), /invalid or unsupported output schema/);
  assert.equal(fake.calls.length, before);
  assert.equal(await kit.addKey('m1', { authChoice: 'openai-api-key', apiKey: 'CANARY-SCHEMA-KEY' }), 'ok');
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
