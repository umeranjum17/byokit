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

test('the `.` entry carries the frozen kit surface (6.2)', async () => {
  assert.equal(kit.HERDR_VERSION, '0.9.1');
  assert.equal(typeof kit.HERDR_PROTOCOL, 'number');
  assert.equal(typeof kit.HerdrKit, 'function');
  const k = new kit.HerdrKit({ mode: 'adopt', bin: '/usr/local/bin/herdr', socketPath: '/tmp/herdr.sock' });
  assert.deepEqual(k.state, { phase: 'stopped' });
  await assert.rejects(k.call('ping', {}), /not connected/);
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

test('the internal seams are in place; bodies land with their work packages', async () => {
  for (const fn of [socketTransport, runCli, openTerminal, createAgents, closePane, closeTab, closeWorkspace, sealNotice, openNotice, herdrLink, serve]) {
    assert.equal(typeof fn, 'function');
  }
  assert.equal(typeof Supervisor, 'function');
  assert.equal(typeof Blocked, 'function');
  const call = (async () => undefined) as Parameters<typeof createAgents>[0]['call'];
  const transport = socketTransport('/tmp/herdr.sock');
  assert.equal(typeof transport.call, 'function');
  transport.close();
  const supervisor = new Supervisor({ mode: 'adopt', bin: 'herdr', socketPath: '/tmp/herdr.sock' }, () => {});
  assert.equal(supervisor.env().HERDR_SOCKET_PATH, '/tmp/herdr.sock');
  // runCli/openTerminal are real since H4: they validate synchronously and resolve/reject async, so their
  // behavior lives in test/cli.test.ts and test/terminal.test.ts.
  assert.throws(() => runCli('herdr', {}, ['ok', 'bad\0arg']), /NUL/);
  assert.throws(() => openTerminal('herdr', {}, 'bad\0pane', { mode: 'observe', cols: 80, rows: 24 }), /NUL/);
  // closePane/Blocked are real since H5: their behavior lives in test/close.test.ts and
  // test/approvals.test.ts. sealNotice, herdrLink and serve are real since H7: their behavior lives
  // in test/link.test.ts and test/device.test.ts.
  await assert.rejects(closePane(call, 'w1:p1'), (e: { code?: string }) => e.code === 'pane-unavailable');
  assert.deepEqual(new Blocked({ call }).list(), []);
  const noticeSeed = new Uint8Array(32).fill(7);
  const { boxPublicKeyB64 } = await import('../src/notices.ts');
  const { boxKeyPairFromSeed } = await import('@byokit/seal');
  const sealed = sealNotice({ paneId: 'w1:p2', workspaceId: 'w1', tabId: 'w1:t1', revision: 1, prompt: 'Allow this? (y/n)', since: 0 }, boxKeyPairFromSeed(noticeSeed).publicKey);
  assert.equal(sealed.v, 1);
  assert.deepEqual(openNotice(sealed as Record<string, unknown>, noticeSeed)?.paneId, 'w1:p2');
  assert.equal(openNotice(sealed as Record<string, unknown>, new Uint8Array(32).fill(8)), null);
  void boxPublicKeyB64;
  const kitForLink = new kit.HerdrKit({ mode: 'adopt', bin: '/usr/local/bin/herdr', socketPath: '/tmp/herdr.sock' });
  const adapter = herdrLink(kitForLink, { scopeOf: () => ({ workspaces: 'all' }) });
  assert.equal(typeof adapter.handle, 'function');
  assert.equal(typeof adapter.stream, 'function');
  assert.equal(typeof adapter.allow, 'function');
  assert.equal(typeof herdrDevice, 'function');
  assert.equal(typeof serve, 'function');
});

test('words: the frozen table answers in plain sentences (6.9)', () => {
  assert.equal(words('agent.signIn', { agent: 'pi' }), 'Sign in inside pi: follow its own steps on the screen.');
  assert.equal(stateWords({ phase: 'ready' }), 'Connected to Herdr.');
  assert.equal(stateWords({ phase: 'needs-update' }), 'Herdr on this computer needs an update to work with this app.');
  assert.equal(stateWords({ phase: 'stopped' }), '', 'a stopped kit has nothing to say yet');
  assert.equal(agentWords('starting'), 'Starting…');
  assert.equal(agentWords('blocked'), 'Waiting for your answer.');
});

// H2 landed: HERDR_PROTOCOL is pinned from the v0.9.1 schema snapshot (test/generated.test.ts
// holds the full snapshot checks).
test('HERDR_PROTOCOL comes from the schema snapshot, not the placeholder', () => {
  assert.notEqual(HERDR_PROTOCOL, 0);
});
