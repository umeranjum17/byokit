// Native approvals through one Approval surface (5.9, O5): exec, plugin and question round-trips,
// member attribution, and the kit wiring over the fake gateway.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Approvals } from '../src/approvals.ts';
import { OpenClawKit } from '../src/kit.ts';
import { fakeGateway } from '../src/testing/fake-gateway.ts';
import type { Approval } from '../src/types.ts';

const stubBridge = { resolveAsk: (_id: string, _d: unknown) => false };

async function withApprovals(
  fn: (approvals: Approvals, fake: ReturnType<typeof fakeGateway>) => Promise<void>,
): Promise<void> {
  const fake = fakeGateway();
  const approvals = new Approvals({ request: fake.transport.request, bridge: stubBridge });
  const off = fake.transport.onEvent((e) => approvals.handleEvent(e));
  try {
    return await fn(approvals, fake);
  } finally {
    off();
  }
}

test('an exec approval round-trips with member attribution', async () =>
  withApprovals(async (approvals, fake) => {
    const changes: [Approval, string][] = [];
    const off = approvals.on((a, change) => changes.push([a, change]));
    // Real engine shape: details nest under `request` (B1).
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'exec-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'rm -rf /tmp/x', ask: 'delete /tmp/x?', agentId: 'm1', sessionKey: 'agent:m1:run:1' },
    });
    const mine = approvals.list('m1');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].source, 'exec');
    assert.equal(mine[0].member, 'm1');
    assert.equal(mine[0].sessionKey, 'agent:m1:run:1');
    assert.equal(mine[0].summary, 'run rm -rf /tmp/x');
    assert.equal(approvals.list('m2').length, 0);
    assert.equal(approvals.list().length, 1);
    await approvals.decide('exec-1', { allow: true });
    assert.deepEqual(fake.calls.at(-1), {
      method: 'exec.approval.resolve',
      params: { id: 'exec-1', decision: 'allow-once' },
    });
    fake.emit('exec.approval.resolved', { id: 'exec-1', decision: 'allow-once' });
    assert.equal(approvals.list().length, 0);
    assert.deepEqual(changes.map(([, change]) => change), ['added', 'resolved']);
    off();
  }));

test('a denied exec approval resolves deny', async () =>
  withApprovals(async (approvals, fake) => {
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'exec-2',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'reboot', sessionKey: 'agent:m2:run:1' },
    });
    assert.equal(approvals.list('m2')[0].member, 'm2');
    assert.equal(approvals.list('m2')[0].summary, 'run reboot');
    await approvals.decide('exec-2', { allow: false });
    assert.deepEqual(fake.calls.at(-1), {
      method: 'exec.approval.resolve',
      params: { id: 'exec-2', decision: 'deny' },
    });
  }));

test('an exec policy mode never renders as the summary', async () =>
  withApprovals(async (approvals, fake) => {
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'mode-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'echo scout', ask: 'on-miss', agentId: 'm1' },
    });
    assert.equal(approvals.list('m1')[0].summary, 'run echo scout');
  }));

test('plugin and question approvals resolve through their own methods', async () =>
  withApprovals(async (approvals, fake) => {
    fake.emit('plugin.approval.requested', {
      approvalKind: 'plugin',
      id: 'plug-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { title: 'install helper', agentId: 'm1' },
    });
    assert.equal(approvals.list('m1')[0].source, 'plugin');
    await approvals.decide('plug-1', { allow: true });
    assert.deepEqual(fake.calls.at(-1), {
      method: 'plugin.approval.resolve',
      params: { id: 'plug-1', decision: 'allow-once' },
    });
    fake.emit('plugin.approval.resolved', { id: 'plug-1' });
    fake.emit('question.requested', {
      id: 'q-1',
      agentId: 'm1',
      questions: [{ questionId: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'red' }] }],
    });
    const pending = approvals.list('m1');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].source, 'question');
    await approvals.decide('q-1', { allow: true, answer: ['red'] });
    assert.deepEqual(fake.calls.at(-1), {
      method: 'question.resolve',
      params: { id: 'q-1', answers: { answers: { color: ['red'] } } },
    });
    fake.emit('question.resolved', { id: 'q-1' });
    fake.emit('question.requested', {
      id: 'q-2',
      agentId: 'm1',
      questions: [{ questionId: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'red' }] }],
    });
    await approvals.decide('q-2', { allow: false });
    assert.deepEqual(fake.calls.at(-1), {
      method: 'question.resolve',
      params: { id: 'q-2', cancel: true },
    });
  }));

test('deciding an unknown approval rejects', async () =>
  withApprovals(async (approvals) => {
    await assert.rejects(approvals.decide('missing', { allow: true }), /unknown approval/);
  }));

test('an unattributable approval never matches a member, not even unknown', async () =>
  withApprovals(async (approvals, fake) => {
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'no-agent',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'uptime' },
    });
    assert.equal(approvals.list().length, 1);
    assert.equal(approvals.list('unknown').length, 0);
    assert.equal(approvals.list('m1').length, 0);
  }));

test('a listener registered before start fires and survives a restart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o5-restart-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  const seen: string[] = [];
  kit.onApproval((a, change) => seen.push(`${change}:${a.id}`));
  try {
    await kit.start();
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'restart-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'uptime', agentId: 'm1' },
    });
    assert.deepEqual(seen, ['added:restart-1']);
    // A reconnect drops natives and replays the engine lists (N9): the engine still holds restart-1.
    fake.handle('exec.approval.list', () => ({
      approvals: [{ id: 'restart-1', request: { command: 'uptime', agentId: 'm1' } }],
    }));
    await kit.stop();
    await kit.start();
    assert.deepEqual(kit.approvals('m1').map((a) => a.id), ['restart-1']);
    assert.deepEqual(seen, ['added:restart-1', 'resolved:restart-1', 'added:restart-1']);
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'restart-2',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'uptime', agentId: 'm1' },
    });
    assert.deepEqual(seen, ['added:restart-1', 'resolved:restart-1', 'added:restart-1', 'added:restart-2']);
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a reconnect drops stale natives and replays the engine lists', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o5-resync-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({ stateDir, transport: fake.factory, spawnEngine: false });
  const seen: string[] = [];
  kit.onApproval((a, change) => seen.push(`${change}:${a.id}`));
  try {
    await kit.start();
    fake.emit('exec.approval.requested', {
      approvalKind: 'exec',
      id: 'stale-1',
      createdAtMs: 1,
      expiresAtMs: 2,
      request: { command: 'uptime', agentId: 'm1' },
    });
    assert.equal(kit.approvals('m1').length, 1);
    fake.handle('exec.approval.list', () => ({
      approvals: [{ id: 'live-1', request: { command: 'ls', agentId: 'm1' } }],
    }));
    await kit.stop();
    await kit.start();
    assert.equal(kit.approvals('m1').map((a) => a.id).join(','), 'live-1');
    assert.ok(seen.includes('resolved:stale-1'));
    assert.ok(seen.includes('added:live-1'));
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('the kit surfaces native approvals and one-shot permits', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'byokit-o5-kit-'));
  const fake = fakeGateway();
  const kit = new OpenClawKit({
    stateDir,
    transport: fake.factory,
    spawnEngine: false,
    tools: [{ name: 'note', description: 'Save a note.', parameters: { type: 'object' } }],
    host: {
      gate: async () => ({ allow: true }),
      call: async () => 'ok',
    },
  });
  try {
    await kit.start();
    assert.equal(kit.approvals().length, 0);
    fake.emit('exec.approval.requested', { id: 'kit-exec-1', agentId: 'm1', command: 'uptime' });
    assert.equal(kit.approvals('m1').length, 1);
    assert.equal(kit.approvals('m2').length, 0);
    await kit.decide('kit-exec-1', { allow: true });
    assert.deepEqual(fake.calls.at(-1), {
      method: 'exec.approval.resolve',
      params: { id: 'kit-exec-1', decision: 'allow-once' },
    });
    kit.allowOnce({ keyPrefix: 'agent:m1:', tool: 'note' }, 1_000);
    kit.disallowOnce();
  } finally {
    await kit.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
