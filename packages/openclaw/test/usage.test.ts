import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentUsageOf, readAgentUsage, type LedgerUsageTotals } from '../src/usage.ts';
import type { OpenClawKit } from '../src/kit.ts';
import type { openclawDevice } from '../src/device.ts';

const window = { startDate: '2026-10-01', endDate: '2026-10-02' };
const totals: LedgerUsageTotals = { input: 110, output: 70, cacheRead: 0, cacheWrite: 0, totalTokens: 180,
  totalCost: 0, inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 10,
  missingCostByModel: { 'stub/test': 10 } };
const payload = (member = 'm1', values: unknown = totals) => ({ ...window, updatedAt: 100,
  cacheStatus: { status: 'fresh', cachedFiles: 1, pendingFiles: 0, staleFiles: 0, refreshedAt: 90 },
  totals: { totalTokens: 99999 }, aggregates: { byAgent: [{ agentId: member, totals: values }] }, extension: { retained: true } });

// Compile-time checks: callers retain their generic full pass-through, with no cast or consumer adapter.
function clients(host: OpenClawKit, device: ReturnType<typeof openclawDevice>) {
  void readAgentUsage(host, 'm1', window);
  void readAgentUsage(device, 'm1', window);
}
void clients;

test('explicit agent/window query, complete raw response, no kit accumulation or budget policy', async () => {
  const raw = payload();
  const options = { timeoutMs: 5 };
  const reading = await readAgentUsage({ call: async (method, params, o) => {
    assert.equal(method, 'sessions.usage');
    assert.deepEqual(params, { agentId: 'm1', ...window, mode: 'utc', groupBy: 'instance', limit: 1 });
    assert.equal(o, options);
    return raw;
  } }, 'm1', window, options);
  assert.equal(reading.state, 'available');
  assert.equal(reading.raw, raw);
  assert.equal(reading.coverage, 'retained-transcripts-only');
  assert.deepEqual(reading.totals, totals); // neither global totals nor foreground run usage is added
  assert.equal(reading.totals?.missingCostEntries, 10); // zero cost is NOT zero billing
  assert.equal(reading.updatedAt, 100);
  assert.equal(reading.cache?.refreshedAt, 90);
  const trips = (tokens: number, share: number) => tokens > 1000 * share; // caller-owned policy
  assert.equal(trips(reading.totals!.totalTokens, 0.17), true);
  assert.equal(trips(reading.totals!.totalTokens, 0.19), false);
  // A reset/retention reduction is an observation, not a new charge, counter rollover or fabricated zero.
  const reset = agentUsageOf(payload('m1', { ...totals, totalTokens: 18 }), 'm1', window, 200);
  assert.equal(reset.totals?.totalTokens, 18);
  assert.equal(reset.receivedAt, 200);
  assert.equal(reset.updatedAt, 100); // receiving cached data does not make it newly assembled
  await assert.rejects(readAgentUsage({ call: async () => { throw new Error('method unavailable'); } }, 'm1', window), /method unavailable/);
});

test('unknown, incomplete, wrong agent/window and malformed counters never become zero', () => {
  for (const raw of [undefined, {}, { ...payload(), cacheStatus: undefined },
    ...['refreshing', 'partial', 'stale', 'unknown'].map(status => ({ ...payload(), cacheStatus: { ...payload().cacheStatus, status } })),
    { ...payload(), cacheStatus: { ...payload().cacheStatus, pendingFiles: 1 } },
    { ...payload(), cacheStatus: { ...payload().cacheStatus, staleFiles: 1 } },
    { ...payload(), aggregates: { byAgent: [] } }, payload('m2'),
    { ...payload(), startDate: '2026-09-30' }, { ...payload(), endDate: '2026-10-03' },
    payload('m1', { ...totals, output: undefined }), payload('m1', { ...totals, totalTokens: NaN }),
    payload('m1', { ...totals, missingCostByModel: { bad: -1 } }),
    { ...payload(), aggregates: { byAgent: [...payload().aggregates.byAgent, ...payload('m2').aggregates.byAgent] } },
  ]) {
    const reading = agentUsageOf(raw, 'm1', window);
    assert.equal(reading.state, 'unavailable');
    assert.equal(reading.totals, undefined);
    assert.equal(reading.raw, raw);
  }
  assert.throws(() => agentUsageOf(payload(), 'M1', window), /Invalid member/);
  assert.throws(() => agentUsageOf(payload(), 'm1', { ...window, startDate: '2026-02-30' }), /calendar date/);
  assert.throws(() => agentUsageOf(payload(), 'm1', { startDate: window.endDate, endDate: window.startDate }), /must not follow/);
});
