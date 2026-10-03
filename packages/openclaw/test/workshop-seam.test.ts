// Semantic accounting units only: these do not qualify the pinned engine anchors or scheduler.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workshopEdits } from '../scripts/workshop-patch.ts';
const helper = workshopEdits[1]!.replace.replace(workshopEdits[1]!.find, '');
function fixture(env: Record<string, string | undefined> = { BYOKIT_ENGINE_USAGE_LEDGER: '/owned', BYOKIT_ENGINE_BOOT: 'launch-uuid' }) {
  const global: Record<symbol, any> = {};
  const lines: { path: string; fact: any }[] = [];
  let fail = false, syncs = 0, closed = 0;
  const write = new Function('process', 'globalThis', 'Buffer', 'byokitOpen', 'byokitJoin', 'byokitWrite', 'byokitFsync', 'byokitClose',
    helper + '\nreturn byokitUsageFact;')({ env }, global, Buffer,
      (path: string, flag: string, mode: number) => { assert.equal(flag, 'a'); assert.equal(mode, 0o600); if (fail) throw new Error('PRIVATE_SECRET_CANARY'); return path; },
      (...parts: string[]) => parts.join('/'), (path: string, bytes: Buffer) => { lines.push({ path, fact: JSON.parse(bytes.toString()) }); return bytes.length; },
      () => { syncs++; }, () => { closed++; });
  return { write, lines, global, counters: () => global[Symbol.for('byokit.engine-usage.v1')], fail: (value: boolean) => { fail = value; },
    syncs: () => syncs, closed: () => closed };
}
const at = Date.parse('2026-10-02T12:00:00Z');
const fact = (phase: string, time = at) => ({ phase, at: time, startedAt: at, chargeId: 'review-id', agentId: 'm1', kind: 'workshop-review',
  provider: 'stub', model: 'test', origin: { sessionKey: 'agent:m1:workshop' } });
test('seam is inert without both kit-owned env values', () => {
  for (const env of [{}, { BYOKIT_ENGINE_USAGE_LEDGER: '/owned' }, { BYOKIT_ENGINE_BOOT: 'launch' }]) {
    const f = fixture(env); f.write(fact('started')); assert.deepEqual(f.lines, []); assert.equal(f.counters(), undefined);
  }
});
test('seam durable attempts carry accounting identity, month seq and pending state', () => {
  const f = fixture(); f.write(fact('started'));
  assert.deepEqual(f.counters().inFlight, { 'review-id': { startedAt: at } });
  f.write({ ...fact('ended'), outcome: 'nothing', usage: { total: 18 } });
  assert.equal(f.lines.length, 2); assert.equal(f.syncs(), 2); assert.equal(f.closed(), 2);
  assert.deepEqual(f.lines.map(l => [l.path, l.fact.bootId, l.fact.seq]), [
    ['/owned/engine-started-2026-10.jsonl', 'launch-uuid', 1], ['/owned/engine-started-2026-10.jsonl', 'launch-uuid', 2] ]);
  assert.deepEqual(f.counters().months, { '2026-10': { lastSeq: 2, failed: 0 } }); assert.deepEqual(f.counters().inFlight, {});
});
test('failed month writes never throw or erase holes; other months have independent counters', () => {
  const f = fixture(); f.fail(true);
  assert.doesNotThrow(() => f.write(fact('started'))); assert.doesNotThrow(() => f.write({ ...fact('ended'), outcome: 'failed' }));
  f.fail(false); f.write(fact('started')); f.write({ ...fact('ended'), outcome: 'nothing', usage: { total: 18 } });
  assert.deepEqual(f.lines.map(l => l.fact.seq), [3, 4]);
  assert.deepEqual(f.counters().months['2026-10'], { lastSeq: 4, failed: 2 });
  f.write(fact('started', Date.parse('2026-11-01T00:00:00Z')));
  assert.deepEqual(f.counters().months['2026-11'], { lastSeq: 1, failed: 0 });
  assert.equal(JSON.stringify(f.counters()).includes('PRIVATE_SECRET_CANARY'), false);
});
