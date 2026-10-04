import { callLedger, tokenLedger, memoryTokenLedgerStore, claudeWindows, roomOf } from '@byokit/usage';

/** Offline consumer: host-reported usage, app prices, and no native or Node globals. */
export function runFixture() {
  const time = 1_788_600_000_000;
  const store = memoryTokenLedgerStore();
  const calls = callLedger({ store, prices: { openai: { model: {
    billing: 'api', currency: 'USD', inputPerMillion: 2, outputPerMillion: 4,
  } } } });
  const tokens = tokenLedger({ store, cap: 100 });
  const base = { provider: 'openai', account: 'host-account', model: 'model', time, runId: 'run', lane: 'host-lane', route: 'host-route' };
  calls.record('member', { ...base, runId: 'api-run', billing: 'api', usage: { input_tokens: 12, output_tokens: 8 } });
  calls.record('member', { ...base, billing: 'subscription', usage: { input_tokens: 3, output_tokens: 2 } });
  const known = tokens.query('member', time, time + 1);
  calls.record('member', { ...base });
  const unknown = tokens.query('member', time, time + 1);
  const history = calls.query('member', time, time + 1);
  const windows = claudeWindows({ five_hour: { utilization: 25 } });
  return { known, unknown, history, runs: calls.runs('member', time, time + 1),
    run: calls.queryRun('member', 'run', time, time + 1), room: roomOf({ provider: 'claude', at: time, windows }, time),
    blocked: roomOf({ provider: 'codex', windows: [], limited: true }, time) };
}
