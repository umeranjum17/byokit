import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineStartedOf, readAgentDayUsage } from '../src/day-usage.ts';
// @ts-expect-error Gateway plugin is intentionally shipped as dependency-free JavaScript.
import { readEngineStarted } from '../plugin/usage.js';
const startMs = Date.parse('2026-10-02T00:00:00Z'), endMs = startMs + 86_400_000 - 1;
const window = { startMs, endMs, mode: 'utc' as const };
const params = { agentId: 'm1', startMs, endMs };
const fact = (phase = 'ended', seq = 1) => ({ v: 1, phase, chargeId: 'review-1', agentId: 'm1', kind: 'workshop-review',
  bootId: 'boot-1', seq, at: startMs + 100, startedAt: startMs + 50, provider: 'stub', model: 'test',
  ...(phase === 'ended' ? { outcome: 'nothing', usage: { total: 18, input: 11, output: 7 } } : {}) });
const jsonl = (...rows: unknown[]) => rows.map(r => JSON.stringify(r) + '\n').join('');
function fixture(facts = jsonl(fact()), months: unknown = { '2026-10': { lastSeq: 1, failed: 0 } }, bootRows = jsonl({ bootId: 'boot-1', startedAt: startMs })) {
  const opened: string[] = [];
  const live = { bootId: 'boot-1', months, inFlight: {} };
  const read = (path: string) => { opened.push(path);
    if (path.endsWith('boots.jsonl')) return bootRows;
    if (path.endsWith('engine-started-2026-10.jsonl')) return facts;
    throw Object.assign(new Error('PRIVATE_SECRET_CANARY'), { code: 'EACCES' });
  };
  return { opened, raw: readEngineStarted('/owned/usage', live, params, read) };
}
test('bounded read, canonical phase dedup and content-free projection', () => {
  const f = { ...fact(), prompt: 'PRIVATE_SECRET_CANARY', usage: { total: 18, secret: 'PRIVATE_SECRET_CANARY' } };
  const { raw, opened } = fixture(jsonl(f, f));
  assert.deepEqual(opened, ['/owned/usage/boots.jsonl', '/owned/usage/engine-started-2026-10.jsonl']);
  assert.equal(raw.complete, true);
  assert.equal(JSON.stringify(raw).includes('PRIVATE_SECRET_CANARY'), false);
  const reading = engineStartedOf(raw, 'm1', window);
  assert.equal(reading.charges.length, 1);
  assert.equal(reading.charges[0].tokens?.total, 18);
  assert.equal(reading.charges[0].billing, 'unknown');
  assert.deepEqual(reading.charges[0].cost, { state: 'missing' });
});
test('cold transcript cache stays unavailable, never zero; timezone is forwarded to both terms', async () => {
  const requests: any[] = [];
  const client = { call: async (_m: string, p: unknown) => { requests.push(p); return {}; }, callDynamic: async (_m: string, p: unknown) => { requests.push(p); return fixture().raw; } };
  const reading = await readAgentDayUsage(client, 'm1', window);
  assert.equal(reading.complete, false); assert.equal(reading.knownTotalTokens, undefined);
  await assert.rejects(readAgentDayUsage(client, 'm1', { ...window, mode: 'gateway' } as any), /timezone/);
  await readAgentDayUsage(client, 'm1', { ...window, mode: 'time-zone', timeZone: 'America/New_York' });
  assert.equal(requests[2].mode, 'specific'); assert.equal(requests[2].timeZone, 'America/New_York');
});
test('read failures remain typed unavailable without leaking error contents', async () => {
  const fail = async () => { throw new Error('PRIVATE_SECRET_CANARY'); };
  const reading = await readAgentDayUsage({ call: fail, callDynamic: fail }, 'm1', window);
  assert.equal(reading.transcripts.state, 'unavailable'); assert.equal(reading.engineStarted.state, 'unavailable');
  assert.equal(reading.knownTotalTokens, undefined); assert.equal(reading.complete, false);
  assert.equal(JSON.stringify(reading).includes('PRIVATE_SECRET_CANARY'), false);
});
test('IANA DST calendar day labels and totals use the same zone; partial days stay unavailable', async () => {
  const zoneWindow = { startMs: Date.parse('2026-11-01T04:00:00Z'), endMs: Date.parse('2026-11-02T04:59:59.999Z'),
    mode: 'time-zone' as const, timeZone: 'America/New_York' };
  const totals = { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, totalCost: 0,
    inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, missingCostEntries: 1 };
  const client = { call: async (_method: string, params: any) => {
    assert.equal(params.startDate, '2026-11-01'); assert.equal(params.endDate, '2026-11-01');
    assert.equal(params.mode, 'specific'); assert.equal(params.timeZone, 'America/New_York');
    return { startDate: params.startDate, endDate: params.endDate, cacheStatus: { status: 'fresh', cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
      aggregates: { byAgent: [{ agentId: 'm1', totals }] } };
  }, callDynamic: async (_method: string, params: any) => ({ ...params, state: 'available', coverageSince: zoneWindow.startMs,
    complete: true, unreadableLines: 0, facts: [] }) };
  const reading = await readAgentDayUsage(client, 'm1', zoneWindow);
  assert.equal(reading.complete, true); assert.equal(reading.knownTotalTokens, 18);
  assert.deepEqual(reading.transcripts.window, { startDate: '2026-11-01', endDate: '2026-11-01', mode: 'time-zone', timeZone: 'America/New_York' });
  const partial = await readAgentDayUsage(client, 'm1', { ...zoneWindow, startMs: zoneWindow.startMs + 1 });
  assert.equal(partial.transcripts.state, 'unavailable'); assert.equal(partial.knownTotalTokens, undefined);
});
