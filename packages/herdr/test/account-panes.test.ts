// WP11 fake ports: shell-effective env, resume ordering and rollback, never a real Herdr.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { HerdrKit } from '../src/kit.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import type { HerdrSubscribeStop, HerdrTransport } from '../src/types.ts';

type Raw = Record<string, any>;
function harness(t: TestContext) {
  const calls: { method: string; params: Raw }[] = [];
  const agents = new Map<string, Raw>([['old', { agent: 'claude', agent_status: 'idle',
    cwd: '/repo', agent_session: { source: 'herdr', agent: 'claude', kind: 'id', value: 'conversation' } }]]);
  const panes = new Map<string, Raw>([['old', {}]]);
  const state = { failStart: false, failClose: new Set<string>(), answer: undefined as string | undefined,
    echoReads: 0, promptEcho: false, waitReady: true, generation: 'conversation', marker: '',
    splitGate: undefined as Promise<void> | undefined, readFails: false, interactive: true, publish: true, variable: '', unsetPresent: false };
  let next = 0;
  const transport: HerdrTransport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'ping') return { protocol: HERDR_PROTOCOL };
      if (method === 'session.snapshot') return { snapshot: { workspaces: [], tabs: [], panes: [], agents: [] } };
      if (method === 'agent.get') {
        const agent = agents.get(String(params.target));
        if (!agent) throw new Error('missing agent');
        return { agent };
      }
      if (method === 'pane.split' || method === 'tab.create') {
        await state.splitGate;
        const id = `new${++next}`;
        panes.set(id, { env: params.env });
        return { pane: { pane_id: id }, root_pane: { pane_id: id } };
      }
      if (method === 'pane.send_text') {
        const text = String(params.text);
        if (text.startsWith('unset ')) return {};
        state.marker = /^echo (\w+)=/.exec(text)![1]!;
        state.variable = /="(?:\$([A-Z_]+)|\$\{([A-Z_]+)\+x\})"/.exec(text)?.slice(1).find(Boolean) ?? '';
        if (text.includes('+x}')) state.variable += '+x';
        return {};
      }
      if (method === 'pane.read') {
        if (state.readFails) throw new Error('secret-canary');
        const env = panes.get(String(params.pane_id))?.env as Raw;
        if (state.echoReads-- > 0) return { read: { text: `${state.promptEcho ? '$ ' : ''}echo ${state.marker}=$CLAUDE_CONFIG_DIR` } };
        return { read: { text: `${state.marker}=${state.answer ?? (state.variable.endsWith('+x') ? (state.unsetPresent ? 'x' : '') : env[state.variable])}\n` } };
      }
      if (method === 'agent.start') {
        if (state.failStart) throw new Error('secret-canary');
        const kind = params.kind;
        agents.set(String(params.pane_id), { agent: kind, agent_status: state.waitReady ? 'idle' : 'working',
          interactive_ready: state.interactive, agent_session: state.publish ? { source: 'herdr', agent: kind, kind: kind === 'pi' ? 'path' : 'id', value: state.generation } : undefined });
        return {};
      }
      if (method === 'pane.close') {
        if (state.failClose.has(String(params.pane_id))) throw new Error('secret-canary');
        panes.delete(String(params.pane_id));
        agents.delete(String(params.pane_id));
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
    assert.match(String(h.calls.find((c) => c.method === 'pane.send_text')?.params.text), /echo BYOKIT_ACCOUNT_[a-f0-9]+="\$CLAUDE_CONFIG_DIR"\n/);
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

test('WP11: env mismatch is exact, refuses prefix folders and unreadable panes before starting', async (t) => {
  for (const answer of ['/new/claude-backup', '/wrong', 'unreadable']) {
    const h = harness(t); h.state.answer = answer; h.state.readFails = answer === 'unreadable';
    const result = await h.move();
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'env_mismatch');
    assert.deepEqual([...h.panes.keys()], ['old']);
    assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
  }
});

test('WP11: typed and prompt-prefixed echoes are ignored until the shell answers', async (t) => {
  for (const promptEcho of [false, true]) {
    const h = harness(t); h.state.echoReads = 1; h.state.promptEcho = promptEcho;
    assert.equal((await h.move()).ok, true);
    assert.equal(h.calls.filter((c) => c.method === 'pane.read').length, 2);
  }
  const h = harness(t); h.state.echoReads = 100;
  const result = await h.move();
  if (result.ok) assert.fail('echo-only cannot verify the folder');
  assert.equal(result.code, 'env_mismatch');
  assert.ok(h.agents.has('old'));
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
  assert.ok(!h.calls.some((c) => c.method === 'pane.send_text'));
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
    h.state.answer = scenario === 'env' ? '/wrong' : undefined;
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
      const commands = h.calls.filter((c) => c.method === 'pane.send_text').map((c) => String(c.params.text));
      assert.equal(commands[0], 'unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN\n');
      assert.ok(commands.some((s) => s.includes('${ANTHROPIC_API_KEY+x}')));
      assert.ok(commands.some((s) => s.includes('${CLAUDE_CODE_OAUTH_TOKEN+x}')));
    }
  }
});

test('move: env and staging failures report a surviving replacement; notification cannot roll back a completed move', async (t) => {
  for (const fail of ['env', 'stage']) {
    const h = harness(t); await h.ready;
    h.state.answer = fail === 'env' ? '/wrong' : undefined;
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
    h.state.unsetPresent = !unsafe;
    const result = await h.kit.move({ paneId: 'old', kind: 'claude', args: ['--resume', 'caller-ref'],
      set: { CLAUDE_CONFIG_DIR: '/new/claude' }, unset: [unsafe ? 'KEY; echo secret-canary' : 'ANTHROPIC_API_KEY'] });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, 'env_mismatch');
    assert.deepEqual([...h.panes.keys()], ['old']);
    assert.ok(!h.calls.some((c) => c.method === 'agent.start'));
    assert.ok(!h.calls.some((c) => c.method === 'pane.send_text' && String(c.params.text).includes('secret-canary')));
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
