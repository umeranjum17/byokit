// H1 acceptance: every frozen name exists — the `.` entry (6.2), `./link` and `./device` (7.1/7.2), and the
// internal seams a later work package fills (docs/runtime-kits.md §11.3).
import { test, todo } from 'node:test';
import assert from 'node:assert/strict';
import * as kit from '../src/index.ts';
import { HERDR_PROTOCOL } from '../src/constants.ts';
import { socketTransport } from '../src/socket.ts';
import { Supervisor } from '../src/supervise.ts';
import { runCli } from '../src/cli.ts';
import { openTerminal } from '../src/terminal.ts';
import { createAgents } from '../src/agents.ts';
import { closePane, closeTab, closeWorkspace } from '../src/close.ts';
import { Blocked } from '../src/approvals.ts';
import { words, stateWords, agentWords } from '../src/words.ts';
import { sealNotice, openNotice } from '../src/notices.ts';
import { herdrLink, serve } from '../src/link.ts';
import { herdrDevice } from '../src/device.ts';
import type {
  AgentRef, AgentStatus, BlockedAgent, HerdrEvent, HerdrKitOptions, HerdrSnapshot, HerdrTransport,
  PromptReceipt, StartAgent, TerminalSession,
} from '../src/types.ts';

test('the `.` entry carries the frozen kit surface (6.2)', () => {
  assert.equal(kit.HERDR_VERSION, '0.9.1');
  assert.equal(typeof kit.HERDR_PROTOCOL, 'number');
  assert.equal(typeof kit.HerdrKit, 'function');
  const k = new kit.HerdrKit({ mode: 'adopt', bin: '/usr/local/bin/herdr', socketPath: '/tmp/herdr.sock' });
  assert.deepEqual(k.state, { phase: 'stopped' });
  assert.throws(() => k.start(), /H3/);
  assert.throws(() => k.call('ping', {}), /H3/);
});

test('public types keep their frozen shapes (6.2)', () => {
  const adopt: HerdrKitOptions = { mode: 'adopt', bin: 'herdr', socketPath: '/tmp/herdr.sock' };
  const own: HerdrKitOptions = { mode: 'own', bin: 'herdr', stateDir: '/tmp/state', path: ['/usr/bin'] };
  const status: AgentStatus = 'idle';
  const ref: AgentRef = { paneId: 'w1:p1' };
  const start: StartAgent = { kind: 'pi', cwd: '/tmp', place: { workspace: 'new' } };
  const receipt: PromptReceipt = { paneId: 'w1:p1', terminalId: 't1', revision: 1, status };
  const blocked: BlockedAgent = { paneId: 'w1:p1', workspaceId: 'w1', tabId: 'w1:t1', revision: 1, prompt: 'Allow this? (y/n)', since: 0 };
  const snapshot: HerdrSnapshot = { connected: true, workspaces: [] };
  const event: HerdrEvent = { type: 'pane.created' };
  const session: TerminalSession = {
    ready: Promise.resolve(), onFrame: () => () => {}, send: () => {}, close: () => {}, exited: Promise.resolve({ code: 0, stderrTail: '' }),
  };
  const transport: HerdrTransport = { call: async () => undefined, subscribe: () => () => {}, close: () => {} };
  void [adopt, own, status, ref, start, receipt, blocked, snapshot, event, session, transport];
});

test('the internal seams are in place; bodies land with their work packages', () => {
  for (const fn of [socketTransport, runCli, openTerminal, createAgents, closePane, closeTab, closeWorkspace, sealNotice, openNotice, herdrLink, serve]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(typeof Supervisor, 'function');
  assert.equal(typeof Blocked, 'function');
  const call = (async () => undefined) as Parameters<typeof createAgents>[0]['call'];
  assert.throws(() => socketTransport('/tmp/herdr.sock'), /H3/);
  assert.throws(() => new Supervisor({ mode: 'adopt', bin: 'herdr', socketPath: '/tmp/herdr.sock' }, () => {}), /H3/);
  // runCli/openTerminal are real since H4: they validate synchronously and resolve/reject async, so their
  // behavior lives in test/cli.test.ts and test/terminal.test.ts.
  assert.throws(() => runCli('herdr', {}, ['ok', 'bad\0arg']), /NUL/);
  assert.throws(() => openTerminal('herdr', {}, 'bad\0pane', { mode: 'observe', cols: 80, rows: 24 }), /NUL/);
  assert.throws(() => closePane(call, 'w1:p1'), /H5/);
  assert.throws(() => new Blocked({ call }).list(), /H5/);
  assert.throws(() => sealNotice({} as never, new Uint8Array(32)), /H7/);
  assert.throws(() => herdrLink(null as never, { scopeOf: () => ({ workspaces: 'all' }) }), /H7/);
  assert.throws(() => serve(null as never), /H7/);
  assert.equal(typeof herdrDevice, 'function');
});

test('words: the frozen table answers in plain sentences (6.9)', () => {
  assert.equal(words('agent.signIn', { agent: 'pi' }), 'Sign in inside pi: follow its own steps on the screen.');
  assert.equal(stateWords({ phase: 'ready' }), 'Connected to Herdr.');
  assert.equal(stateWords({ phase: 'needs-update' }), 'Herdr on this computer needs an update to work with this app.');
  assert.equal(stateWords({ phase: 'stopped' }), '', 'a stopped kit has nothing to say yet');
  assert.equal(agentWords('starting'), 'Starting…');
  assert.equal(agentWords('blocked'), 'Waiting for your answer.');
});

// H2 sets HERDR_PROTOCOL from the v0.9.1 schema snapshot; until then this is an expected failure, not a red run.
todo('HERDR_PROTOCOL comes from the schema snapshot, not the placeholder', () => {
  assert.notEqual(HERDR_PROTOCOL, 0);
});
