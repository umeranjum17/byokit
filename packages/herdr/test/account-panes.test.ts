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
  const state = { version: undefined as string | undefined, failStart: false, failClose: new Set<string>(),
    paneEnv: 'recorded' as 'recorded' | 'wrong-value' | 'leaked-unset' | 'missing' | 'unreadable',
    waitReady: true, generation: 'conversation', splitGate: undefined as Promise<void> | undefined,
    interactive: true, publish: true,
    waitSource: undefined as (() => void) | undefined, beforeSourceRead: undefined as (() => void) | undefined,
    unreachable: new Set<string>(), beforeClose: undefined as ((id: string) => void) | undefined, afterClose: undefined as ((id: string) => void) | undefined };
  let next = 0;
  const transport: HerdrTransport = {
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'ping') return { protocol: HERDR_PROTOCOL, ...(state.version === undefined ? {} : { version: state.version }) };
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

test('older Herdr is refused first with the upgrade sentence; nothing is read or changed', async (t) => {
  for (const [have, refused] of [['0.9.0', true], ['0.8.9', true], ['0.9.1', false], ['0.10.0', false]] as const) {
    const h = harness(t);
    h.state.version = have;
    const result = await h.move();
    if (refused) {
      assert.deepEqual(result, { ok: false, code: 'unsupported', live: 'old',
        message: `Moving accounts needs Herdr 0.9.1 or newer. You have ${have}. Run herdr update.` });
      assert.deepEqual(h.calls.filter((c) => !['ping', 'session.snapshot'].includes(c.method)), []);
    } else assert.equal(result.ok, true);
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
  await assert.rejects(h.kit.startAgent({ kind: 'codex', cwd: '/repo', place: { pane: 'old' }, env: { CODEX_HOME: '/other' } }),
    (e: { code?: string }) => e.code === 'env_mismatch');
});

// R3: published-protocol fixtures, not native working-step qualification.
const confirmed = { session: 'conversation', terminalId: 'original-terminal' };