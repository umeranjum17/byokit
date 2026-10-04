import type { CallRecord } from './calls.ts';
import type { Provider, Reading, Room } from './types.ts';
import { roomOf } from './room.ts';
import { words } from './words.ts';

const plans: Record<Provider, string> = {
  codex: 'ChatGPT', claude: 'Claude', copilot: 'GitHub Copilot', grok: 'Grok',
  minimax: 'MiniMax', gemini: 'Gemini', kimi: 'Kimi', zai: 'GLM', opencode: 'AI',
};
/** Internal routing keys never serve as display names. */
export function planLabel(provider: Provider): string {
  return words('plan.name', { name: plans[provider] ?? 'AI' });
}
/** Recognized families only; an unknown id gets a quiet, plain fallback. */
export function modelLabel(id: string): string {
  const claude = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)(?:-\d{8})?$/.exec(id);
  if (claude) return `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`;
  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(sol|luna|astra))?$/.exec(id);
  if (gpt) return `GPT ${gpt[1]}${gpt[2] ? ` ${gpt[2][0]!.toUpperCase()}${gpt[2].slice(1)}` : ''}`;
  return words('model.unknown');
}
const canonical = (provider: string): string => provider === 'chatgpt' || provider === 'openai-codex' ? 'codex' : provider === 'anthropic' ? 'claude' : provider;
export interface ActivityCount {
  calls: number;
  /** Unknown if any recorded call has no measured total. */
  tokens?: number;
  knownTokens: number;
  unknownCalls: number;
}
export interface PlanView {
  label: string;
  room: Room;
  roomText: string;
  quotaText: string;
  today: ActivityCount;
  activity: ActivityCount & { from: number; to: number; text: string };
  people: (ActivityCount & { member: string })[];
  models: (ActivityCount & { label: string })[];
}
function counts(calls: readonly CallRecord[]): ActivityCount {
  const unknownCalls = calls.filter((call) => call.tokens.total === undefined || call.tokens.provenance === 'unknown').length;
  const knownTokens = calls.reduce((sum, call) => sum + (call.tokens.provenance === 'unknown' ? 0 : call.tokens.total ?? 0), 0);
  if (!Number.isSafeInteger(knownTokens) || knownTokens < 0) throw new Error('Recorded token counts are invalid.');
  return { calls: calls.length, knownTokens, unknownCalls, ...(unknownCalls ? {} : { tokens: knownTokens }) };
}
/** One snapshot for every activity section. Quota covers the whole plan; calls cover only what the app recorded. */
export function planView(input: {
  provider: Provider; account: string; calls: readonly CallRecord[]; nowMs: number;
  /** The host pairs a quota reading with the same account identity used in its ledger. */
  quota?: { account: string; reading: Reading };
}): PlanView {
  const { provider, account, nowMs, quota } = input;
  if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime()) || !account
    || quota && (quota.account !== account || quota.reading.provider !== provider)) throw new Error('Choose a matching plan reading.');
  const today = new Date(nowMs); today.setHours(0, 0, 0, 0);
  const from = new Date(today); from.setDate(from.getDate() - 29);
  const calls = input.calls.filter((call) => canonical(call.provider) === provider && call.account === account
    && call.time >= from.getTime() && call.time <= nowMs);
  const activity = counts(calls);
  const groups = (key: (call: CallRecord) => string) => {
    const grouped = new Map<string, CallRecord[]>();
    for (const call of calls) { const name = key(call); const rows = grouped.get(name) ?? []; rows.push(call); grouped.set(name, rows); }
    return [...grouped].map(([name, rows]) => ({ name, ...counts(rows) }));
  };
  const reading = quota?.reading ?? { provider, windows: [] };
  const room = roomOf(reading, nowMs);
  return {
    label: planLabel(provider), room,
    roomText: room.left === 'unknown' ? words('room.unknown') : words('room.left', { left: String(room.left) + '%' }),
    quotaText: words(reading.poll?.outcome === 'rate-limited' || reading.code === 'rate-limited' ? 'quota.waiting' : 'quota.scope'),
    today: counts(calls.filter((call) => call.time >= today.getTime())),
    activity: { ...activity, from: from.getTime(), to: nowMs,
      text: words(activity.calls === 1 ? 'activity.one' : activity.calls ? 'activity.recorded' : 'activity.empty', { n: String(activity.calls) }) },
    people: groups((call) => call.payer ?? '').map(({ name, ...count }) => ({ member: name, ...count })),
    models: groups((call) => modelLabel(call.model)).map(({ name, ...count }) => ({ label: name, ...count })),
  };
}
