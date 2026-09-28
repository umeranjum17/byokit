// The fail-closed tool bridge (5.9, O5): unknown runs, permit binding, allowOnce, parked asks, garbage frames.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Bridge, MAX_APPROVAL_TIMEOUT_MS, writePlugin } from '../src/bridge.ts';
import { words } from '../src/words.ts';
import type { Approval, RunRef, ToolHost } from '../src/types.ts';

const tools = [{ name: 'note', description: 'Save a note.', parameters: { type: 'object' } }];

function host(): ToolHost {
  return {
    gate: async (_run: RunRef, _tool: string, input: Record<string, unknown>) => {
      if (input.mode === 'ask') return { ask: { summary: 'save a note' } };
      if (input.mode === 'deny') return { allow: false, reason: 'no notes today' };
      return { allow: true };
    },
    call: async (_run: RunRef, _tool: string, input: Record<string, unknown>) => `note: ${input.text ?? ''}`,
  };
}

function askBridge(sockPath: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = connect(sockPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('bridge reply timed out'));
    }, 10_000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, end)));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('connect', () => {
      socket.write((typeof message === 'string' ? message : JSON.stringify(message)) + '\n');
    });
  });
}

async function withBridge(
  o: { permitted?: (tool: string) => boolean; approvalTimeoutMs?: number } & { host?: ToolHost } = {},
  fn: (bridge: Bridge, sockPath: string, seen: { asked: Approval[]; gone: string[] }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-o5-bridge-'));
  const sockPath = join(dir, 'bridge.sock');
  const seen = { asked: [] as Approval[], gone: [] as string[] };
  const bridge = new Bridge({
    path: sockPath,
    host: o.host ?? host(),
    permitted: o.permitted ?? (() => true),
    approvalTimeoutMs: o.approvalTimeoutMs ?? 5_000,
    onAsk: (a) => seen.asked.push(a),
    onAskGone: (id) => seen.gone.push(id),
  });
  await bridge.start();
  try {
    await fn(bridge, sockPath, seen);
  } finally {
    bridge.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('writePlugin is deterministic and carries the tool names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'byokit-o5-plugin-'));
  writePlugin(dir, { id: 'byokit', tools, paramPrefix: '__byokit' });
  const manifest = readFileSync(join(dir, 'openclaw.plugin.json'), 'utf8');
  const table = readFileSync(join(dir, 'tools.json'), 'utf8');
  assert.deepEqual(JSON.parse(manifest), {
    id: 'byokit',
    name: 'BYOKit bridge',
    activation: { onStartup: true },
    contracts: { tools: ['note'] },
    configSchema: { type: 'object', additionalProperties: false },
  });
  assert.match(table, /"__byokit_run"/);
  assert.match(table, /"__byokit_permit"/);
  writePlugin(dir, { id: 'byokit', tools, paramPrefix: '__byokit' });
  assert.equal(readFileSync(join(dir, 'openclaw.plugin.json'), 'utf8'), manifest);
  assert.equal(readFileSync(join(dir, 'tools.json'), 'utf8'), table);
  writePlugin(dir, { id: 'crewhouse', tools, paramPrefix: '__crewhouse' });
  assert.match(readFileSync(join(dir, 'tools.json'), 'utf8'), /"__crewhouse_permit"/);
  rmSync(dir, { recursive: true, force: true });
});

test('an unknown run fails closed and a call without a gate fails', async () =>
  withBridge({}, async (bridge, sockPath) => {
    assert.deepEqual(await askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: {} }), {
      allow: false,
      reason: 'unknown run',
    });
    bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
    assert.deepEqual(
      await askBridge(sockPath, { kind: 'call', key: 'agent:m1:x', tool: 'note', input: {} }),
      { ok: false, reason: 'this call was not allowed' },
    );
  }));

test('a permit works once and is bound to the exact input', async () =>
  withBridge({}, async (bridge, sockPath) => {
    bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
    const gate = await askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { text: 'hi' } });
    assert.equal(gate.allow, true);
    assert.equal(typeof gate.permit, 'string');
    const call = { kind: 'call', key: 'agent:m1:x', permit: gate.permit, tool: 'note', input: { text: 'hi' } };
    assert.deepEqual(await askBridge(sockPath, call), { ok: true, text: 'note: hi' });
    assert.deepEqual(await askBridge(sockPath, call), { ok: false, reason: 'this call was not allowed' });
    const gate2 = await askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { text: 'hi' } });
    assert.deepEqual(
      await askBridge(sockPath, {
        kind: 'call',
        key: 'agent:m1:x',
        permit: gate2.permit,
        tool: 'note',
        input: { text: 'other' },
      }),
      { ok: false, reason: 'this call was not allowed' },
    );
  }));

test('a tool the app did not permit needs no permit and leaves no ticket behind', async () =>
  withBridge({ permitted: () => false }, async (bridge, sockPath) => {
    bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
    const gate = await askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { text: 'hi' } });
    assert.deepEqual(gate, { allow: true });
    const call = { kind: 'call', key: 'agent:m1:x', tool: 'note', input: { text: 'hi' } };
    assert.deepEqual(await askBridge(sockPath, call), { ok: true, text: 'note: hi' });
    assert.deepEqual(await askBridge(sockPath, call), { ok: false, reason: 'this call was not allowed' });
  }));

test('allowOnce admits exactly one matching unregistered call', async () =>
  withBridge({}, async (bridge, sockPath) => {
    bridge.allowOnce({ keyPrefix: 'agent:m9:', tool: 'note' }, 1_000);
    assert.deepEqual(
      await askBridge(sockPath, { kind: 'gate', key: 'agent:m9:x', tool: 'other', input: {} }),
      { allow: false, reason: 'unknown run' },
    );
    const gate = await askBridge(sockPath, { kind: 'gate', key: 'agent:m9:x', tool: 'note', input: {} });
    assert.equal(gate.allow, true);
    assert.deepEqual(
      await askBridge(sockPath, { kind: 'call', key: 'agent:m9:x', permit: gate.permit, tool: 'note', input: {} }),
      { ok: true, text: 'note: ' },
    );
    assert.deepEqual(await askBridge(sockPath, { kind: 'gate', key: 'agent:m9:x', tool: 'note', input: {} }), {
      allow: false,
      reason: 'unknown run',
    });
    bridge.allowOnce({ keyPrefix: 'agent:m9:', tool: 'note' }, 50);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await askBridge(sockPath, { kind: 'gate', key: 'agent:m9:x', tool: 'note', input: {} }), {
      allow: false,
      reason: 'unknown run',
    });
    bridge.allowOnce({ keyPrefix: 'agent:m9:', tool: 'note' }, 1_000);
    bridge.disallowOnce();
    assert.deepEqual(await askBridge(sockPath, { kind: 'gate', key: 'agent:m9:x', tool: 'note', input: {} }), {
      allow: false,
      reason: 'unknown run',
    });
  }));

test('an ask parks until decide allows, denies, or expires', async () =>
  withBridge({}, async (bridge, sockPath, seen) => {
    bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
    const pending = askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { mode: 'ask' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.asked.length, 1);
    assert.equal(seen.asked[0].source, 'gate');
    assert.equal(seen.asked[0].member, 'm1');
    assert.equal(seen.asked[0].tool, 'note');
    assert.ok(bridge.resolveAsk(seen.asked[0].id, { allow: true }));
    const allowed = await pending;
    assert.equal(allowed.allow, true);
    assert.equal(typeof allowed.permit, 'string');
    assert.deepEqual(seen.gone, [seen.asked[0].id]);

    const denied = askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { mode: 'ask' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.asked.length, 2);
    assert.ok(bridge.resolveAsk(seen.asked[1].id, { allow: false, reason: 'not now' }));
    assert.deepEqual(await denied, { allow: false, reason: 'not now' });
    assert.equal(bridge.resolveAsk('missing', { allow: true }), false);
  }));

test('a dead asker unparks its ask instead of leaving a permit for nobody', async () =>
  withBridge({}, async (bridge, sockPath, seen) => {
    bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
    const { connect: connectSocket } = await import('node:net');
    const socket = connectSocket(sockPath);
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write(JSON.stringify({ kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { mode: 'ask' } }) + '\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seen.asked.length, 1);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(seen.gone, [seen.asked[0].id]);
    assert.equal(bridge.resolveAsk(seen.asked[0].id, { allow: true }), false);
  }));

test('ask timeouts stay below the plugin gate timeout', async () => {
  assert.equal(MAX_APPROVAL_TIMEOUT_MS, 190_000);
});

test('an unanswered ask expires denied with the plain-words reason', async () =>
  withBridge({ approvalTimeoutMs: 60 }, async (bridge, sockPath, seen) => {
    bridge.register({ sessionKey: 'agent:m1:x', member: 'm1' });
    const expired = await askBridge(sockPath, { kind: 'gate', key: 'agent:m1:x', tool: 'note', input: { mode: 'ask' } });
    assert.deepEqual(expired, { allow: false, reason: words('approval.expired') });
    assert.equal(seen.asked.length, 1);
    assert.deepEqual(seen.gone, [seen.asked[0].id]);
  }));

test('a garbage frame denies without touching the host', async () =>
  withBridge({}, async (_bridge, sockPath) => {
    assert.deepEqual(await askBridge(sockPath, 'this is not json'), { allow: false, reason: 'not a gate request' });
    assert.deepEqual(await askBridge(sockPath, { kind: 'dance' }), { allow: false, reason: 'not a gate request' });
  }));
