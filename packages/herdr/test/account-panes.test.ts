// WP11 fake ports: shell-effective env, resume ordering and rollback, never a real Herdr.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratchDir } from '../../test-support.ts';
import { startFakeHerdr } from '../src/testing/index.ts';
import { HerdrKit } from '../src/kit.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import type { HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';

// Fixture moves see only a task-owned PATH of silent probe stubs: moveToAccount's sign-in
// check appends the host's fixed install dirs past PATH, so an empty PATH alone would still
// reach the owner's native CLIs.
const probePath = scratchDir('account-panes-path');
process.env.PATH = probePath;
for (const kind of ['claude', 'codex']) writeFileSync(join(probePath, kind), '#!/bin/sh\n', { mode: 0o700 });
type Raw = Record<string, any>;
function harness(t: TestContext) {
  const calls: { method: string; params: Raw }[] = [];
  const agents = new Map<string, Raw>([['old', { agent: 'claude', agent_status: 'idle',
    terminal_id: 'original-terminal', state_change_seq: 1, name: 'original',
    cwd: '/repo', agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'conversation' } }]]);
  const panes = new Map<string, Raw>([['old', {}]]);
  const state = { failStart: false, failClose: new Set<string>(),
    paneEnv: 'recorded' as 'recorded' | 'wrong-value' | 'leaked-unset' | 'missing' | 'unreadable',
    waitReady: true, generation: 'conversation', splitGate: undefined as Promise<void> | undefined,
    interactive: true, publish: true,
    waitSource: undefined as (() => void) | undefined, beforeSourceRead: undefined as (() => void) | undefined,
    unreachable: new Set<string>(), beforeClose: undefined as ((id: string) => void) | undefined, afterClose: undefined as ((id: string) => void) | undefined };
  let next = 0;
  const transport: HerdrTransport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') return { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } };
      if (method === 'agent.get') {
        if (params.target === 'old') state.beforeSourceRead?.();
        if (state.unreachable.has(String(params.target))) throw new Error('fixture transport unavailable');
        const agent = agents.get(String(params.target));
        if (!agent) throw new Error('missing agent');
        return { agent: structuredClone(agent) };
      }
      if (method === 'pane.split' || method === 'tab.create') {
        await state.splitGate;
        const id = `new${++next}`;
        panes.set(id, { env: params.env });
        return { pane: { pane_id: id, tab_id: `t${id}`, workspace_id: 'w1' }, root_pane: { pane_id: id, tab_id: `t${id}`, workspace_id: 'w1' } };
      }
      // Real Herdr 0.9.1 applies the split env to the new shell but never reports it: `pane.get`
      // has no `env`. Only the shell itself can say what it holds, so the fixture runs the
      // sourced private file in a real sh whose env is the pane's, like the fake server does.
      if (method === 'pane.process_info') return { process_info: { shell_pid: 1, foreground_processes: [{ pid: 1, name: 'zsh' }] } };
      if (method === 'pane.send_text') {
        if (state.paneEnv === 'unreadable') throw new Error('secret-canary');
        const pane = panes.get(String(params.pane_id));
        if (!pane) throw new Error('missing pane');
        const env: Raw = state.paneEnv === 'missing' ? {} : { ...pane.env };
        if (state.paneEnv === 'wrong-value') {
          const key = Object.keys(env).find((k) => k.endsWith('CONFIG_DIR') || k.endsWith('_HOME')) ?? Object.keys(env)[0];
          if (key) env[key] = '/wrong';
        }
        if (state.paneEnv === 'leaked-unset') env.ANTHROPIC_API_KEY = 'leak';
        pane.text = spawnSync('/bin/sh', ['-c', String(params.text)], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' }).stdout;
        return {};
      }
      if (method === 'pane.read') return { read: { text: panes.get(String(params.pane_id))?.text ?? '' } };
      if (method === 'pane.get') {
        const id = String(params.pane_id);
        if (!panes.has(id)) throw new Error('missing pane');
        return { pane: { pane_id: id, tab_id: `t${id}`, workspace_id: 'w1' } };
      }
      if (method === 'agent.start') {
        if (state.failStart) throw new Error('secret-canary');
        const kind = params.kind;
        agents.set(String(params.pane_id), { agent: kind, agent_status: state.waitReady ? 'idle' : 'working',
          terminal_id: `terminal-${params.pane_id}`, name: params.name,
          interactive_ready: state.interactive, agent_session: state.publish ? { source: 'herdr', agent: kind, kind: kind === 'pi' ? 'path' : 'id', value: state.generation } : undefined });
        return {};
      }
      if (method === 'agent.wait' && params.target === 'old') { state.waitSource?.(); return {}; }
      if (method === 'agent.rename') {
        const agent = agents.get(String(params.target));
        if (!agent) throw new Error('missing agent');
        agent.name = params.name;
        return { agent: structuredClone(agent) };
      }
      if (method === 'pane.close') {
        state.beforeClose?.(String(params.pane_id));
        if (state.failClose.has(String(params.pane_id))) throw new Error('secret-canary');
        panes.delete(String(params.pane_id));
        agents.delete(String(params.pane_id));
        state.afterClose?.(String(params.pane_id));
        return {};
      }
      return {};
    },
    subscribe: () => (() => {}) as HerdrSubscribeStop,
    close() {},
  };
  const kit = new HerdrKit({ mode: 'adopt', bin: '/never-used', socketPath: '/never-used', transport });
  const ready = kit.start();
  t.after(() => kit.stop());
  const move = async () => { await ready; return kit.moveToAccount({ paneId: 'old' }, { provider: 'claude', folder: '/new/claude', timeoutMs: 250 }); };
  return { kit, ready, move, calls, state, agents, panes };
}

test('MS-S3: native target status refuses before waiting or splitting; generic move stays caller-gated', async (t) => {
  const root = scratchDir('move-signed-out'); const folder = join(root, 'account'); mkdirSync(folder);
  const log = join(root, 'probes.jsonl'); const bin = join(root, 'claude');
  writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({home:process.env.HOME,folder:process.env.CLAUDE_CONFIG_DIR})+'\\n');
console.log('{"loggedIn":false}');
`, { mode: 0o700 });
  const path = process.env.PATH; process.env.PATH = root;
  t.after(() => { process.env.PATH = path; });
  const fake = await startFakeHerdr({ dir: join(root, 'fake'), world: { kinds: ['claude'] } });
  const kit = new HerdrKit({ mode: 'adopt', bin: fake.bin, socketPath: fake.socketPath });
  t.after(async () => { await kit.stop(); await fake.stop(); }); await kit.start();
  const source = fake.world.agents.find(a => a.pane_id === 'w1:p2')!;
  const panes = structuredClone(fake.world.panes);
  for (const working of [false, true]) {
    source.agent_status = working ? 'working' : 'idle';
    Object.assign(source, { state_change_seq: 1 });
    const before = structuredClone(source);
    const result = await kit.moveToAccount({ paneId: source.pane_id }, { provider: 'claude', folder, name: 'Umer',
      ...(working ? { whenBusy: { busy: 'wait', waitMs: 500, confirmed: { session: source.agent_session.value, terminalId: source.terminal_id } } } : {}) });
    assert.deepEqual(result, { ok: false, code: 'signed_out', message: 'Sign in to Umer first.', live: source.pane_id });
    assert.deepEqual(fake.world.panes, panes); assert.deepEqual(source, before);
  }
  const probes = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(probes, [{ home: folder, folder }, { home: folder, folder }]);
  source.agent_status = 'idle';
  const result = await kit.move({ paneId: source.pane_id, kind: 'claude', args: ['--resume', source.agent_session.value], set: { CLAUDE_CONFIG_DIR: folder }, timeoutMs: 500 });
  assert.equal(result.ok, true); assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 2);
});

test('B9: new managed kind uses pinned folder and resume args under the existing move transaction', async (t) => {
  for (const callerArgs of [false, true]) {
    const h = harness(t); await h.ready;
    h.agents.set('old', { agent: 'kimi', agent_status: 'idle', cwd: '/repo',
      agent_session: { source: 'fixture-only', agent: 'kimi', kind: 'id', value: 'kimi-conversation' } });
    const result = callerArgs
      ? await h.kit.move({ paneId: 'old', kind: 'kimi', args: ['--session', 'kimi-conversation'],
          set: { KIMI_CODE_HOME: '/managed/kimi' }, unset: ['API_KEY'], timeoutMs: 250 })
      : await h.kit.moveToAccount({ paneId: 'old' }, { provider: 'kimi', folder: '/managed/kimi', timeoutMs: 250 });
    assert.equal(result.ok, true, 'fake transport qualification only');
    assert.deepEqual(h.calls.find((c) => c.method === 'pane.split')?.params.env, { KIMI_CODE_HOME: '/managed/kimi' });
    assert.deepEqual(h.calls.find((c) => c.method === 'agent.start')?.params.args, ['--session', 'kimi-conversation']);
    assert.equal(h.agents.has('old'), false);
  }
});

test('B9: no-folder kinds stay tab-only even when upstream has a resume planner', async (t) => {
  for (const kind of ['maki', 'letta', 'opencode', 'gemini']) {
    const h = harness(t); await h.ready;
    h.agents.set('old', { agent: kind, agent_status: 'idle',
      agent_session: { source: 'fixture-only', agent: kind, kind: 'id', value: 'conversation' } });
    const result = await h.kit.move({ paneId: 'old', kind, args: ['--resume', 'conversation'], set: { HOME: '/guessed' } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'unsupported');
    assert.ok(!h.calls.some((c) => c.method === 'pane.split'));
  }
});

test('WP11: start and wait precede source close; a resumed new generation is followed', async (t) => {
  const h = harness(t); h.state.generation = 'new-generation';
  await h.ready;
  try {
    assert.deepEqual(await h.move(), { ok: true, session: 'new1' });
    const methods = h.calls.map((c) => c.method);
    assert.ok(methods.indexOf('agent.start') < methods.indexOf('agent.wait'));
    assert.ok(methods.indexOf('agent.wait') < methods.indexOf('pane.close'));
    assert.deepEqual(h.calls.find((c) => c.method === 'agent.start')?.params.args, ['--resume', 'conversation']);
    assert.equal(h.calls.find((c) => c.method === 'pane.split')?.params.cwd, '/repo');
    // The new shell confirms the env through one private sourcing line (pane.get has no env).
    assert.equal(h.calls.filter((c) => c.method === 'pane.send_text' && c.params.pane_id === 'new1' && /byokit-env-/.test(String(c.params.text))).length, 1);
    // User-meaningful name: a unique start while the source lives, then the session name.
    assert.match(String(h.calls.find((c) => c.method === 'agent.start')?.params.name), /^original-[0-9a-f]{6}$/);
    assert.deepEqual(h.calls.find((c) => c.method === 'agent.rename')?.params, { target: 'new1', name: 'original' });
    assert.equal(h.agents.get('new1')?.name, 'original');
    assert.equal(h.agents.get('new1')?.agent_session.value, 'new-generation');
    assert.ok(!h.panes.has('old'));
  } finally { await h.kit.stop(); }
});

test('WP11: failed start or readiness rolls back the new pane, preserving the original', async (t) => {
  for (const failure of ['start', 'wait']) {
    const h = harness(t); h.state.failStart = failure === 'start'; h.state.waitReady = failure !== 'wait';
    const result = await h.move();
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, 'start_failed'); assert.equal(result.live, 'old'); }
    assert.deepEqual([...h.agents.keys()], ['old']);
    assert.deepEqual([...h.panes.keys()], ['old']);
    assert.ok(!h.calls.some((c) => c.method === 'pane.close' && c.params.pane_id === 'old'));
    assert.ok(!JSON.stringify(result).includes('secret-canary'));
  }
});

test('WP11: a failed source close rolls back; a failed rollback names the remaining new pane', async (t) => {
  for (const rollbackFails of [false, true]) {
    const h = harness(t); h.state.failClose.add('old');
    if (rollbackFails) h.state.failClose.add('new1');
    const result = await h.move();
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.code, 'close_failed'); assert.equal(result.live, rollbackFails ? 'new1' : 'old'); }
    assert.ok(h.agents.has('old'));
    assert.equal(h.agents.has('new1'), rollbackFails);
    const closes = h.calls.filter((c) => c.method === 'pane.close').map((c) => c.params.pane_id);
    assert.deepEqual(closes, ['old', 'new1']);
  }
});

test('WP11: env mismatch is exact and unreadable panes fail before starting', async (t) => {
  for (const paneEnv of ['wrong-value', 'missing', 'unreadable'] as const) {
    const h = harness(t); h.state.paneEnv = paneEnv;
    const result = await h.move();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'env_mismatch');
    assert.deepEqual([...h.panes.keys()], ['old']);
    assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
  }
  // A credential leaked into the launch env refuses the generic move: the split call
  // cannot express removals, so unsetting in the shell is no longer an option.
  const h = harness(t); h.state.paneEnv = 'leaked-unset';
  await h.ready;
  const leaked = await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'conversation'],
    set: { CLAUDE_CONFIG_DIR: '/new/claude' }, unset: ['ANTHROPIC_API_KEY'], timeoutMs: 250 });
  assert.equal(leaked.ok, false);
  if (!leaked.ok) assert.equal(leaked.code, 'env_mismatch');
  assert.deepEqual([...h.panes.keys()], ['old']);
  assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
});

test('WP11: the new shell confirms the placement env; no value reaches the terminal', async (t) => {
  for (const api of ['move', 'moveToAccount'] as const) {
    const h = harness(t); await h.ready;
    const result = api === 'moveToAccount' ? await h.move()
      : await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'conversation'],
          set: { CLAUDE_CONFIG_DIR: '/new/claude' }, unset: ['ANTHROPIC_API_KEY'], timeoutMs: 250 });
    assert.equal(result.ok, true);
    // pane.get reports no env (as on real Herdr), so the move rests on the shell's own answer.
    const typed = h.calls.filter((c) => c.method === 'pane.send_text' && /byokit-env-/.test(String(c.params.text)));
    assert.equal(typed.length, 1);
    assert.match(String(typed[0]!.params.text), /^set \+x \+v; \. '\/.*\/prepare\.sh'\n$/);
    assert.ok(!h.calls.some((c) => (c.method === 'pane.send_text' || c.method === 'pane.read') && JSON.stringify(c.params).includes('/new/claude')));
  }
});

test('WP11: a pane that never received the env refuses fast, not at the deadline', async (t) => {
  const h = harness(t); h.state.paneEnv = 'missing'; await h.ready;
  const started = Date.now();
  const result = await h.kit.moveToAccount({ paneId: 'old' }, { provider: 'claude', folder: '/new/claude', timeoutMs: 20_000 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'env_mismatch');
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual([...h.panes.keys()], ['old']);
});

test('WP11: unsupported, too-early and busy agents never split, including concurrent moves', async (t) => {
  for (const [patch, code] of [
    [{ agent: 'other' }, 'unsupported'], [{ agent: 'pi' }, 'unsupported'], [{ agent_session: undefined }, 'too_early'],
    [{ launch_pending: true }, 'too_early'], [{ agent_session: { agent: 'claude', kind: 'path', value: 'conversation' } }, 'unsupported'], [{ agent_status: 'working' }, 'busy'],
    [{ agent_status: 'blocked' }, 'busy'],
  ] as const) {
    const h = harness(t); Object.assign(h.agents.get('old')!, patch);
    const result = await h.move();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, code);
    assert.ok(!h.calls.some((c) => c.method === 'pane.split'));
  }
  const h = harness(t); let release!: () => void;
  h.state.splitGate = new Promise<void>((r) => { release = r; });
  await h.ready;
  const pending = h.move();
  const concurrent = await h.move();
  if (concurrent.ok) assert.fail('second move must refuse');
  assert.equal(concurrent.code, 'busy');
  release(); await pending;
});

test('WP11: Codex resume args and account env; sign-in opens an explicit-env tab', async (t) => {
  for (const kind of ['codex']) {
    const h = harness(t); h.agents.set('old', { agent: kind, agent_status: 'idle', cwd: '/repo',
      agent_session: { source: 'herdr', agent: kind, kind: kind === 'pi' ? 'path' : 'id', value: 'conversation' } });
    await h.ready;
    const result = await h.kit.moveToAccount({ paneId: 'old' }, { provider: 'codex', folder: '/codex', env: { CODEX_HOME: '/wrong', DISPLAY: ':fake' } });
    assert.equal(result.ok, true);
    assert.deepEqual(h.calls.find((c) => c.method === 'pane.split')?.params.env, { CODEX_HOME: '/codex', DISPLAY: ':fake' });
    assert.deepEqual(h.calls.find((c) => c.method === 'agent.start')?.params.args,
      kind === 'pi' ? ['--session', 'conversation'] : ['resume', 'conversation']);
  }
  const h = harness(t);
  await h.ready;
  const ref = await h.kit.openSignInTab({ workspaceId: 'w1', kind: 'codex', cwd: '/repo', env: { CODEX_HOME: '/signin' } });
  assert.equal(ref.paneId, 'new1');
  assert.deepEqual(h.calls.find((c) => c.method === 'tab.create')?.params,
    { workspace_id: 'w1', cwd: '/repo', focus: false, env: { CODEX_HOME: '/signin' } });
  assert.ok(!h.calls.some((c) => c.method === 'pane.send_text' && /byokit-env-/.test(String(c.params.text))));
  assert.ok(!('env' in h.calls.find((c) => c.method === 'agent.start')!.params));
  h.state.failStart = true;
  await assert.rejects(h.kit.openSignInTab({ workspaceId: 'w1', kind: 'codex', cwd: '/repo',
    env: { SECRET: 'secret-canary' } }), (e: Error) => !e.message.includes('secret-canary'));
  await assert.rejects(h.kit.startAgent({ kind: 'pi', cwd: '/repo', place: { pane: 'old' }, env: { CODEX_HOME: '/other' } }),
    (e: { code?: string }) => e.code === 'env_mismatch');
});

// Extraction matrix: the caller owns resume arguments and stages discovery before a replacement starts.
test('move: seven-case start-then-close failure matrix and staged notifications', async (t) => {
  for (const scenario of ['success', 'env', 'start', 'interactive', 'conversation', 'close', 'rollback']) {
    const h = harness(t);
    await h.ready;
    h.state.paneEnv = scenario === 'env' ? 'wrong-value' : 'recorded';
    h.state.failStart = scenario === 'start';
    h.state.interactive = scenario !== 'interactive';
    h.state.publish = scenario !== 'conversation';
    if (['close', 'rollback'].includes(scenario)) h.state.failClose.add('old');
    if (scenario === 'rollback') h.state.failClose.add('new1');
    const notifications: string[] = [];
    const result = await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'caller-ref'],
      set: { CLAUDE_CONFIG_DIR: '/new/claude' }, unset: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'], timeoutMs: 100,
      onStaged(id) {
        notifications.push(`staged:${id}`);
        assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
      },
      onReplaced(id) {
        notifications.push(`replaced:${id}`);
        assert.ok(!h.panes.has('old'));
      },
    });
    assert.equal(result.ok, scenario === 'success', scenario);
    assert.deepEqual(notifications, scenario === 'success' ? ['staged:new1', 'replaced:new1'] : ['staged:new1']);
    if (result.ok) assert.deepEqual(result, { ok: true, paneId: 'new1' });
    else {
      assert.equal(result.code, scenario === 'env' ? 'env_mismatch' : ['close', 'rollback'].includes(scenario) ? 'close_failed' : 'start_failed');
      assert.equal(result.live, scenario === 'rollback' ? 'new1' : 'old');
      assert.ok(h.panes.has('old'));
      assert.equal(h.panes.has('new1'), scenario === 'rollback');
      assert.ok(!JSON.stringify(result).includes('secret-canary'));
    }
    if (scenario !== 'env') {
      const start = h.calls.find((c) => c.method === 'agent.start')!;
      assert.deepEqual(start.params.args, ['--resume', 'caller-ref']);
      assert.match(String(start.params.name), /^original-[0-9a-f]{6}$/);
      if (scenario === 'success') {
        assert.deepEqual(h.calls.find((c) => c.method === 'agent.rename')?.params,
          { target: 'new1', name: 'original' });
        assert.equal(h.agents.get('new1')?.name, 'original');
      }
    }
  }
});

test('move: env and staging failures report a surviving replacement; notification cannot roll back a completed move', async (t) => {
  for (const fail of ['env', 'stage']) {
    const h = harness(t); await h.ready;
    h.state.paneEnv = fail === 'env' ? 'wrong-value' : 'recorded';
    h.state.failClose.add('new1');
    const result = await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'caller-ref'],
      set: { CLAUDE_CONFIG_DIR: '/new/claude' }, onStaged() { if (fail === 'stage') throw new Error('secret-canary'); } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.live, 'new1');
    assert.ok(h.panes.has('old'));
    assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
  }
  const h = harness(t); await h.ready;
  assert.deepEqual(await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'caller-ref'],
    set: { CLAUDE_CONFIG_DIR: '/new/claude' }, onReplaced() { throw new Error('secret-canary'); } }),
  { ok: true, paneId: 'new1' });
});

test('move: retained credentials and unsafe env identifiers fail closed before agent start', async (t) => {
  for (const unsafe of [false, true]) {
    const h = harness(t); await h.ready;
    if (!unsafe) h.state.paneEnv = 'leaked-unset';
    const result = await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'caller-ref'],
      set: { CLAUDE_CONFIG_DIR: '/new/claude' }, unset: [unsafe ? 'KEY; echo secret-canary' : 'ANTHROPIC_API_KEY'] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'env_mismatch');
    assert.deepEqual([...h.panes.keys()], ['old']);
    assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
    // An unsafe name never reaches the shell; a retained credential is found by the shell itself.
    assert.equal(h.calls.some((c) => c.method === 'pane.send_text' && /byokit-env-/.test(String(c.params.text))), !unsafe);
    assert.ok(!JSON.stringify(h.calls).includes('secret-canary'));
  }
});

test('move and moveToAccount share the source lock', async (t) => {
  const h = harness(t); await h.ready;
  let release!: () => void;
  h.state.splitGate = new Promise<void>((r) => { release = r; });
  const pending = h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'caller-ref'],
    set: { CLAUDE_CONFIG_DIR: '/new/claude' } });
  const concurrent = await h.move();
  assert.equal(concurrent.ok, false);
  if (!concurrent.ok) assert.equal(concurrent.code, 'busy');
  release();
  assert.equal((await pending).ok, true);
});

// Public adopt transport boundary: close takes effect before the socket loses its ACK.
// Both public move APIs use the same recovery; no real pane or account lifecycle runs.
test('move close ACK fixture: verify the original before discarding a ready survivor', async (t) => {
  for (const api of ['move', 'moveToAccount'] as const) {
    for (const fault of ['lost', 'refused', 'rollback-lost', 'source-unreachable', 'all-unreachable',
      'source-unreachable-refused', 'no-survivors', 'source-replaced', 'replacement-replaced', 'replacement-exited']) {
      const h = harness(t); await h.ready;
      if (fault === 'refused' || fault === 'rollback-lost' || fault === 'replacement-replaced' || fault === 'source-unreachable-refused') h.state.failClose.add('old');
      h.state.beforeClose = (id) => {
        if (id === 'old' && fault === 'source-unreachable-refused') h.state.unreachable.add('old');
      };
      h.state.afterClose = (id) => {
        if (id === 'new1' && fault === 'rollback-lost') throw new Error('fixture cleanup ACK lost');
        if (id !== 'old') return;
        if (fault === 'source-unreachable' || fault === 'all-unreachable') h.state.unreachable.add('old');
        if (fault === 'all-unreachable') h.state.unreachable.add('new1');
        if (fault === 'no-survivors' || fault === 'replacement-exited') { h.agents.delete('new1'); h.panes.delete('new1'); }
        if (fault === 'source-replaced') {
          h.panes.set('old', {});
          h.agents.set('old', { ...structuredClone(h.agents.get('new1')), terminal_id: 'different-terminal', name: 'original' });
        }
        throw new Error('fixture source close applied but ACK lost');
      };
      // A refused source close can coincide with a different agent taking the new pane.
      if (fault === 'replacement-replaced') {
        // Exercise the supported transport, rather than patching any private move helper.
        h.state.failClose.delete('old');
        h.state.afterClose = (id) => {
          if (id !== 'old') return;
          h.panes.set('old', {});
          h.agents.set('old', { agent: 'claude', agent_status: 'idle', terminal_id: 'original-terminal', name: 'original',
            agent_session: { agent: 'claude', kind: 'id', value: 'conversation' } });
          Object.assign(h.agents.get('new1')!, { terminal_id: 'unrelated-terminal' });
          throw new Error('fixture close uncertain and replacement changed');
        };
      }
      let staged = 0, replaced = 0;
      const result = api === 'moveToAccount' ? await h.move() : await h.kit.move({
        paneId: 'old', kind: 'claude', args: ['--resume', 'conversation'], set: { CLAUDE_CONFIG_DIR: '/new/claude' },
        unset: ['ANTHROPIC_API_KEY'], timeoutMs: 250,
        onStaged() { staged++; }, onReplaced() { replaced++; },
      });
      assert.equal(result.ok, false, `${api}/${fault}`);
      if (result.ok) assert.fail('ambiguous close must report uncertainty');
      assert.equal(result.code, 'close_failed');
      const expectedLive = ['all-unreachable', 'no-survivors', 'replacement-exited'].includes(fault) ? undefined
        : ['refused', 'rollback-lost', 'replacement-replaced'].includes(fault) ? 'old' : 'new1';
      assert.equal(result.live, expectedLive, `${api}/${fault}`);
      if (result.live !== undefined) assert.ok(h.panes.has(result.live), 'never invent a live pane');
      assert.equal(replaced, 0, 'no success notification on uncertain outcome');
      assert.equal(staged, api === 'move' ? 1 : 0);
      const closes = h.calls.filter((c) => c.method === 'pane.close').map((c) => c.params.pane_id);
      assert.deepEqual(closes, ['refused', 'rollback-lost'].includes(fault) ? ['old', 'new1'] : ['old']);
      assert.equal(h.agents.size, fault === 'no-survivors' || fault === 'replacement-exited' ? 0
        : ['source-replaced', 'replacement-replaced', 'source-unreachable-refused'].includes(fault) ? 2 : 1);
      assert.ok(!JSON.stringify(result).includes('fixture source close'));
      console.log(`public adopt close-ACK fixture ${api}/${fault}: ${JSON.stringify(result)}`);
    }
  }
});

test('R3: wait bounds fail closed before staging or waiting', async (t) => {
  for (const waitMs of [0, -1, NaN, Infinity, 300001]) {
    const h = harness(t); await h.ready;
    h.agents.get('old')!.agent_status = 'working';
    const result = await h.kit.moveToAccount({ paneId: 'old' }, { provider: 'claude', folder: '/new/claude',
      whenBusy: { busy: 'wait', confirmed: { session: 'conversation', terminalId: 'original-terminal' }, waitMs } });
    if (result.ok) assert.fail('invalid bound cannot move');
    assert.equal(result.code, 'unsupported');
    assert.ok(!h.calls.some((c) => ['agent.wait', 'pane.split', 'pane.close'].includes(c.method)));
  }
});

// R3: published-protocol fixtures, not native working-step qualification.
const confirmed = { session: 'conversation', terminalId: 'original-terminal' };
test('R3: explicit wait, refusal and stale confirmation never interrupt the source', async (t) => {
  for (const api of ['move', 'moveToAccount'] as const) {
    for (const scenario of ['success', 'timeout', 'blocked', 'initial-blocked', 'stale-session', 'stale-terminal',
      'changed-session', 'changed-terminal', 'missing-seq', 'lost-seq', 'invalid-bound', 'interrupt', 'stale-seq', 'still-working', 'default']) {
      const h = harness(t); await h.ready;
      const source = h.agents.get('old')!;
      source.agent_status = scenario === 'initial-blocked' ? 'blocked' : 'working';
      if (scenario === 'missing-seq') delete source.state_change_seq;
      h.state.waitSource = () => {
        if (scenario === 'timeout') throw new Error('fixture wait timeout');
        source.agent_status = scenario === 'blocked' ? 'blocked' : scenario === 'still-working' ? 'working' : 'idle';
        source.state_change_seq = 2;
        if (scenario === 'lost-seq') delete source.state_change_seq;
        if (scenario === 'changed-session') source.agent_session.value = 'other';
        if (scenario === 'changed-terminal') source.terminal_id = 'other';
      };
      const whenBusy = scenario === 'default' ? undefined : ['interrupt', 'stale-seq'].includes(scenario)
        ? { busy: 'interrupt' as const, confirmed: { ...confirmed, seq: scenario === 'stale-seq' ? 0 : 1 } }
        : { busy: 'wait' as const, confirmed: { ...confirmed,
            ...(scenario === 'stale-session' ? { session: 'stale' } : {}),
            ...(scenario === 'stale-terminal' ? { terminalId: 'stale' } : {}) },
          waitMs: scenario === 'invalid-bound' ? 300001 : 100 };
      const result = api === 'move'
        ? await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'conversation'],
            set: { CLAUDE_CONFIG_DIR: '/new/claude' }, whenBusy, timeoutMs: 250 })
        : await h.kit.moveToAccount({ paneId: 'old' }, { provider: 'claude', folder: '/new/claude', whenBusy, timeoutMs: 250 });
      if (scenario === 'success') {
        assert.equal(result.ok, true);
        const wait = h.calls.find((c) => c.method === 'agent.wait' && c.params.target === 'old')!;
        assert.deepEqual(wait.params, { target: 'old', until: ['idle', 'done', 'blocked'], timeout_ms: 100 });
        assert.ok(!h.panes.has('old'));
      } else {
        assert.equal(result.ok, false, scenario);
        if (result.ok) assert.fail('must refuse');
        const expected = ['default', 'timeout', 'still-working'].includes(scenario) ? 'busy'
          : ['blocked', 'initial-blocked'].includes(scenario) ? 'blocked'
          : ['missing-seq', 'lost-seq', 'invalid-bound'].includes(scenario) ? 'unsupported'
          : scenario === 'interrupt' ? 'interrupt_unsupported' : 'changed';
        assert.equal(result.code, expected, scenario);
        assert.ok(h.panes.has('old'));
        assert.ok(!h.calls.some((c) => ['pane.split', 'pane.close', 'agent.start'].includes(c.method)));
      }
      assert.ok(!h.calls.some((c) => /send_keys|send_input|stop|delete/.test(c.method)));
    }
  }
});

test('R3: source quiescence is checked immediately before close, even on idle moves', async (t) => {
  for (const change of ['working', 'blocked', 'seq', 'terminal', 'session', 'unreachable']) {
    const h = harness(t); await h.ready;
    h.state.beforeSourceRead = () => {
      if (!h.agents.has('new1')) return;
      const source = h.agents.get('old')!;
      if (['working', 'blocked'].includes(change)) source.agent_status = change;
      if (change === 'seq') source.state_change_seq++;
      if (change === 'terminal') source.terminal_id = 'changed';
      if (change === 'session') source.agent_session.value = 'changed';
      if (change === 'unreachable') h.state.unreachable.add('old');
    };
    const result = await h.move();
    if (result.ok) assert.fail('changed source cannot close');
    assert.equal(result.code, 'changed');
    assert.equal(result.live, ['working', 'blocked', 'seq'].includes(change) ? 'old' : undefined);
    assert.deepEqual(h.calls.filter((c) => c.method === 'pane.close').map((c) => c.params.pane_id), ['new1']);
    assert.ok(h.panes.has('old'));
    assert.ok(!h.panes.has('new1'));
    assert.ok(!result.message.includes('Nothing was closed'));
  }
});

test('R3: changed rollback lost ACK reports only freshly verified survivors', async (t) => {
  for (const fault of ['lost', 'unknown', 'refused']) {
    const h = harness(t); await h.ready;
    h.state.beforeSourceRead = () => { if (h.agents.has('new1')) h.agents.get('old')!.agent_status = 'working'; };
    if (fault === 'refused') h.state.failClose.add('new1');
    h.state.afterClose = (id) => {
      if (id !== 'new1') return;
      if (fault === 'unknown') h.state.unreachable.add('old');
      throw new Error('fixture cleanup lost ACK');
    };
    const result = await h.move();
    if (result.ok) assert.fail('changed source cannot succeed');
    assert.equal(result.code, 'changed');
    assert.equal(result.live, fault === 'unknown' ? undefined : fault === 'refused' ? 'new1' : 'old');
    assert.ok(!result.message.includes('stays open') || result.live === 'old');
  }
});
