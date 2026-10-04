import { planView, type ActivityCount } from '@byokit/usage/view';
import type { CallRecord } from '@byokit/usage';
import type { Provider, Reading } from '@byokit/usage';

export const providers: Provider[] = ['codex', 'claude', 'copilot', 'grok', 'minimax', 'gemini', 'kimi', 'zai', 'opencode'];
export const nowMs = 1790838000000;
export const fixtureCalls: CallRecord[] = providers.map((provider, i) => ({
  provider, account: 'umer-plan', payer: 'umer', model: provider === 'claude' ? 'claude-opus-5-5' : provider === 'codex' ? 'gpt-6-sol' : 'unlisted-model',
  runId: `sample-${i}`, time: nowMs - 60_000, billing: 'subscription', billingLabel: "Person's own plan", state: 'completed',
  tokens: { total: provider === 'codex' ? 4_600_000_000 : (i + 1) * 1200, provenance: 'partial' },
}));
export function demoView(provider: Provider) {
  const reading: Reading = provider === 'codex'
    ? { provider, windows: [], code: 'rate-limited', poll: { at: nowMs, outcome: 'rate-limited' } }
    : { provider, at: nowMs, windows: [{ provider, kind: 'weekly', usedPercent: 25, resetsAt: nowMs + 86_400_000 }] };
  return planView({ provider, account: 'umer-plan', calls: fixtureCalls, nowMs,
    quota: { account: 'umer-plan', reading } });
}
export const tokenText = (count: ActivityCount): string => count.tokens === undefined
  ? `Unknown (${count.knownTokens.toLocaleString('en-US')} measured; ${count.unknownCalls} unmeasured calls)`
  : `${count.tokens.toLocaleString('en-US')} tokens`;
/** The old independent selectors, reproduced from the same snapshot; never used by the fixed view. */
export const before = () => ({ label: 'OpenAI Codex', room: 'Rate limited 0% left', today: '0 tokens', activity: 'No activity in 30 days',
  people: `Pi ${(fixtureCalls.filter((call) => call.provider === 'codex').reduce((sum, call) => sum + (call.tokens.total ?? 0), 0) / 1_000_000_000).toFixed(1)}B` });
