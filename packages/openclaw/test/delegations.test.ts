// Delegated runs (5.8 native admission, 5.8.3 helpers) on the Delegations journal alone, its engine answers scripted:
// a child the engine forgot ends `lost` and leaves the journal, a live or unreadable one stays; a full journal settles
// such children before it refuses a new dispatch; an admitted helper child gets its helper's persona, nothing else does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDir } from '../../test-support.ts';
import { Delegations } from '../src/delegations.ts';
import { HelperError } from '../src/helpers.ts';
import type { DelegatedEvent } from '../src/types.ts';

const ROOT = { member: 'm1', sessionKey: 'agent:m1:lead' };
const FORGOTTEN = { status: 'timeout', timeoutPhase: 'queue', providerStarted: false };
const LIVE = { status: 'timeout', timeoutPhase: 'gateway_draining' };

function journal(wait: (runId: string) => object, seed?: object) {
  const dir = scratchDir('delegations');
  const file = join(dir, 'delegated-runs.json');
  const events: DelegatedEvent[] = [], revoked: string[] = [];
  if (seed) writeFileSync(file, JSON.stringify(seed));
  const d = new Delegations({ file, tools: new Set(['note']), memberOf: (agent) => ['m1', 'scout'].includes(agent) ? agent : undefined,
    helper: (member, helper) => {
      if (member !== 'm1' || helper !== 'writer') throw new HelperError('unknown_helper', `unknown helper: ${helper}`);
      return { agentId: 'm1', account: 'openai', persona: 'You are the writer.' };
    },
    rest: async () => {}, emit: (e) => events.push(e), revoke: (_key, runId) => revoked.push(runId),
    request: async (method, params) => {
      assert.equal(method, 'agent.wait');
      return wait(String((params as { runId: string }).runId));
    } });
  d.register(ROOT, 'root', ['note'], { scout: ['note'] }, ROOT.sessionKey, { writer: ['note'] });
  const send = async (child: string, sessionKey: string) => {
    const ids = { key: ROOT.sessionKey, runId: 'root', callId: `call-${child}` };
    const tracked = await d.prepare({ ...ids, tool: 'sessions_send', input: { sessionKey, timeoutSeconds: 0 } });
    d.receipt({ ...ids, result: { details: { status: 'accepted', runId: child, sessionKey } } });
    return tracked;
  };
  return { d, events, revoked, send, close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('reconcile ends a child the engine forgot as lost, a finished one as it ended, and keeps live and unreadable ones', async () => {
  const answers: Record<string, object> = { done: { status: 'ok' }, failed: { status: 'error' }, forgotten: FORGOTTEN, live: LIVE };
  const j = journal((runId) => { if (runId === 'unreadable') throw new Error('gateway closed'); return answers[runId]!; });
  try {
    for (const child of ['done', 'failed', 'forgotten', 'live', 'unreadable']) assert.equal(await j.send(child, 'agent:scout:main'), true);
    await j.d.reconcile();
    assert.deepEqual(j.d.list().map((r) => r.runId).sort(), ['live', 'unreadable']);
    assert.deepEqual(j.events.filter((e) => e.type === 'ended').map((e) => [e.run.runId, e.reason]),
      [['done', 'terminal'], ['failed', 'error'], ['forgotten', 'lost']]);
    assert.deepEqual(j.revoked, ['done', 'failed', 'forgotten']);
  } finally { j.close(); }
});

test('a full journal settles forgotten children before it refuses a new dispatch', async () => {
  let live = true;
  const ref = (n: number) => ({ sessionKey: 'agent:scout:main', member: 'scout', runId: `old-${n}`, agentId: 'scout',
    parent: { sessionKey: ROOT.sessionKey, runId: 'gone' }, root: { sessionKey: ROOT.sessionKey, runId: 'gone' }, tools: ['note'] });
  const children = Array.from({ length: 1024 }, (_, n) => [`old-${n}`, { ref: ref(n), tools: ['note'], delegates: { scout: ['note'] }, sourceKey: ROOT.sessionKey }]);
  const j = journal(() => live ? LIVE : FORGOTTEN, { version: 1, children, pending: [] });
  const d = j.d;
  try {
    const input = { sessionKey: 'agent:scout:main', timeoutSeconds: 0 };
    // Every old child still running on the engine: the journal is truly full.
    await assert.rejects(d.prepare({ key: ROOT.sessionKey, runId: 'root', callId: 'c1', tool: 'sessions_send', input }), /journal is full/);
    assert.equal(d.list().length, 1024);
    // The engine forgot them (a restart while their ends were lost): they end `lost` and the dispatch is tracked.
    live = false;
    assert.equal(await d.prepare({ key: ROOT.sessionKey, runId: 'root', callId: 'c2', tool: 'sessions_send', input }), true);
    assert.equal(d.list().length, 0);
    assert.equal(j.events.filter((e) => e.type === 'ended' && e.reason === 'lost').length, 1024);
  } finally { j.close(); }
});

test('only an admitted helper child gets its helper persona', async () => {
  const j = journal(() => LIVE);
  try {
    assert.equal(await j.send('writer-child', 'agent:m1:h-writer:main'), true);
    assert.equal(await j.send('scout-child', 'agent:scout:main'), true);
    assert.equal(await j.d.persona('agent:m1:h-writer:main', 'writer-child'), 'You are the writer.');
    // Not the admitted run on that key, the parent's own run, a non-helper child, or no run id at all.
    assert.equal(await j.d.persona('agent:m1:h-writer:main', 'other-run'), undefined);
    assert.equal(await j.d.persona(ROOT.sessionKey, 'root'), undefined);
    assert.equal(await j.d.persona('agent:scout:main', 'scout-child'), undefined);
    assert.equal(await j.d.persona('agent:m1:h-writer:main'), undefined);
  } finally { j.close(); }
});
