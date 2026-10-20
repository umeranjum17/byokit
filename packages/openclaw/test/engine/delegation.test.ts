// Consumer journey against the pinned real Gateway and the HTTP scripted provider, never a fake kit/Gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenClawKit, type DelegatedEvent, type RunRef } from '@byokit/openclaw';
import { startModelStub, useModelStub } from '@byokit/openclaw/testing';
import { scratchDir, sharedEngineDir } from '../../../test-support.ts';

const until = async (check: () => boolean, why: string) => {
  const end = Date.now() + 60_000;
  while (!check()) { if (Date.now() > end) throw new Error(why); await delay(20); }
};
// Escape the nested marker in the parent's JSON so only the target parses that script.
const script = (tool: string, input: object) => `[tool ${tool} ${JSON.stringify(input).replaceAll('[tool ', '\\u005btool ')}]`;

test('native send/spawn receipts admit only exact child runs; approvals, events, persistence and cancellation', { timeout: 300_000 }, async () => {
  const stub = await startModelStub();
  // Keep the bridge's Unix path short even under a task-owned disk-backed TMPDIR.
  const stateDir = scratchDir('d');
  const events: DelegatedEvent[] = [], gated: { run: RunRef; tool: string }[] = [], calls: RunRef[] = [];
  let cancelled = false;
  const options = { stateDir, engineDir: sharedEngineDir(), tools: ['report', 'blocked_report'].map(name => ({ name,
    description: 'Record an owned team result', parameters: { type: 'object', properties: { text: { type: 'string' } } } })),
    config: { tools: { allow: ['report', 'blocked_report', 'sessions_send', 'sessions_spawn'],
      agentToAgent: { enabled: true, allow: ['m1', 'scout'] }, sessions: { visibility: 'all' },
      subagents: { tools: { allow: ['report', 'blocked_report'] } } },
      agents: { defaults: { subagents: { allowAgents: ['scout'] } } }, session: { agentToAgent: { maxPingPongTurns: 0 } } },
    host: {
      gate: async (run: RunRef, tool: string) => { gated.push({ run, tool });
        return tool === 'report' ? { ask: { summary: 'Let Scout record this result?' } } : { allow: true as const }; },
      call: async (run: RunRef, _tool: string, input: Record<string, unknown>, signal: AbortSignal) => {
        calls.push(run);
        if (input.text === 'cancel') return new Promise<string>(resolve => {
          const abort = () => { cancelled = true; resolve('cancelled'); };
          if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
        });
        return 'Umer result recorded';
      },
    } };
  const kit = new OpenClawKit(options);
  kit.onEvent('byokit.delegated', e => { events.push(e); console.log('delegated', e.type, e.run.agentId, e.event?.stream ?? '', e.event?.data?.phase ?? ''); });
  try {
    await kit.start(); await useModelStub(kit, stub);
    await kit.ensureMember('m1'); const scout = await kit.ensureMember('scout');
    writeFileSync(join(scout.workspace, 'IDENTITY.md'), 'Your id is scout.');
    const root = 'agent:m1:teams:send';
    const end = await kit.run({ member: 'm1', sessionKey: root, tools: ['report'], delegates: { scout: ['report', 'blocked_report'] },
      message: script('sessions_send', { sessionKey: 'agent:scout:main', timeoutSeconds: 0,
        message: '[tool report {"text":"deny"}] [tool report {"text":"approve"}] [tool blocked_report {}]' }) });
    console.log('parent send', JSON.stringify(end));
    assert.ok(end.ok, JSON.stringify(end));
    await until(() => kit.approvals().length === 1, 'child never reached approval');
    const denied = kit.approvals()[0]!;
    assert.equal(denied.member, 'scout'); assert.equal(denied.sessionKey, 'agent:scout:main');
    await kit.decide(denied.id, { allow: false, reason: 'Umer refused this action' });
    await until(() => kit.approvals().length === 1, 'child did not continue after refusal');
    assert.notEqual(kit.approvals()[0]!.id, denied.id);
    await kit.decide(kit.approvals()[0]!.id, { allow: true });
    await until(() => events.some(e => e.type === 'ended'), 'child terminal event missing');
    assert.equal(calls.length, 1); assert.equal(calls[0]!.member, 'scout'); assert.equal(calls[0]!.agentId, 'scout');
    assert.equal(calls[0]!.parent?.sessionKey, root); assert.ok(calls[0]!.runId);
    assert.equal(gated.filter(g => g.tool === 'blocked_report').length, 0, 'child broadened parent tool subset');
    assert.ok(events.some(e => e.type === 'event' && e.event?.stream === 'tool'));
    const before = calls.length, gatesBefore = gated.length;
    await kit.call('agent', { agentId: 'scout', sessionKey: 'agent:scout:unknown', message: '[tool report {}]', idempotencyKey: 'unknown-native-child' });
    assert.equal(calls.length, before); assert.equal(gated.length, gatesBefore, 'unknown child reached the host gate');
    const spawnRoot = 'agent:m1:teams:spawn';
    const spawned = await kit.run({ member: 'm1', sessionKey: spawnRoot, tools: ['report'], delegates: { scout: ['report'] },
      message: script('sessions_spawn', { agentId: 'scout', task: '[tool report {"text":"cancel"}]', mode: 'run' }) });
    console.log('parent spawn', JSON.stringify(spawned)); assert.ok(spawned.ok, JSON.stringify(spawned));
    await until(() => kit.approvals().length === 1, 'spawn never reached approval');
    const child = kit.delegatedRuns().find(r => r.root.sessionKey === spawnRoot)!;
    assert.ok(child && child.parent.runId && child.runId !== child.parent.runId);
    assert.equal(new OpenClawKit(options).delegatedRuns().find(r => r.runId === child.runId)?.sessionKey, child.sessionKey,
      'fresh kit did not rehydrate the exact admitted receipt');
    await kit.decide(kit.approvals()[0]!.id, { allow: true });
    await until(() => calls.length === before + 1, 'spawn app call missing');
    await kit.abort(spawnRoot);
    await until(() => cancelled, 'cancel did not reach active child app tool');
    assert.equal(kit.approvals().length, 0); assert.equal(kit.delegatedRuns().length, 0);
    assert.ok(events.some(e => e.run.runId === child.runId && e.reason === 'cancelled'));
    const parkedRoot = 'agent:m1:teams:parked';
    await kit.run({ member: 'm1', sessionKey: parkedRoot, delegates: { scout: ['report'] },
      message: script('sessions_spawn', { agentId: 'scout', task: '[tool report {"text":"never"}]', mode: 'run' }) });
    await until(() => kit.approvals().length === 1, 'second spawn never parked');
    const callCount = calls.length, parkedId = kit.approvals()[0]!.id;
    await kit.abort(parkedRoot);
    assert.equal(kit.approvals().length, 0);
    await assert.rejects(kit.decide(parkedId, { allow: true }), /unknown approval/);
    assert.equal(calls.length, callCount, 'revoked approval ran a tool');
    // Same-agent spawn: Chief hands work to a subagent of its own agent. The app's allowAgents list names only scout,
    // yet the tracked spawn into m1 itself goes through as the engine's own-agent spawn and is admitted exactly.
    const selfRoot = 'agent:m1:teams:self';
    const selfEnd = await kit.run({ member: 'm1', sessionKey: selfRoot, tools: ['report'], delegates: { m1: ['report'] },
      message: script('sessions_spawn', { agentId: 'm1', task: '[tool report {"text":"self"}]', mode: 'run' }) });
    console.log('parent self spawn', JSON.stringify(selfEnd)); assert.ok(selfEnd.ok, JSON.stringify(selfEnd));
    await until(() => kit.approvals().length === 1, 'same-agent spawn never reached approval');
    const self = kit.delegatedRuns().find(r => r.root.sessionKey === selfRoot)!;
    assert.ok(self && self.agentId === 'm1' && self.member === 'm1' && self.sessionKey.startsWith('agent:m1:subagent:'), JSON.stringify(self));
    assert.equal(kit.approvals()[0]!.sessionKey, self.sessionKey);
    await kit.decide(kit.approvals()[0]!.id, { allow: true });
    await until(() => events.some(e => e.type === 'ended' && e.run.runId === self.runId), 'same-agent child never ended');
    assert.deepEqual([calls.at(-1)!.sessionKey, calls.at(-1)!.parent?.sessionKey], [self.sessionKey, selfRoot]);
    assert.equal(events.find(e => e.type === 'ended' && e.run.runId === self.runId)!.reason, 'terminal');
    // The engine's answer for a run it does not know, which reconcile reads as `lost` (the kit's restart sweep).
    const forgotten = await kit.call('agent.wait', { runId: 'never-a-run', timeoutMs: 1 }) as Record<string, unknown>;
    assert.deepEqual([forgotten.status, forgotten.timeoutPhase, forgotten.providerStarted], ['timeout', 'queue', false]);
    await kit.stop(); await kit.start();
    assert.equal(kit.delegatedRuns().length, 0, 'revoked child revived after engine restart');
    console.log('PASS native send/spawn: exact actors, same-agent spawn, parent settlement, deny/allow, narrowed tools, unknown refusal, durable receipt/revocation, cancellation/restart');
  } finally { await kit.stop(); await stub.close(); }
});
