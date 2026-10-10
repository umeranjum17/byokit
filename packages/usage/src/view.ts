import type { CallRecord } from './calls.ts';
import type { Freshness, Kind, Provider, Reading, Room, Scope } from './types.ts';
import { roomOf } from './room.ts';
import { words, type WordKey } from './words.ts';

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
const windowLabels: Record<Kind, WordKey> = {
  session: 'windows.session', weekly: 'windows.week', monthly: 'windows.month', rolling: 'windows.rolling', custom: 'windows.limit',
};
/** One normalized window with its display line, reset line and unchanged millisecond reset. */
export interface WindowLine {
  provider: Provider;
  kind: Kind;
  scope?: Scope;
  limit?: string;
  usedPercent?: number;
  limited?: boolean;
  resetsAt?: number;
  text: string;
  resetText: string;
}
export interface WindowsView {
  /** Every window, tightest first; an unknown window keeps its place after the measured ones. */
  windows: WindowLine[];
  at?: number;
  ageMs?: number;
  ageText?: string;
  freshness: Freshness;
  stale: boolean;
}
function agoText(agoMs: number): string {
  const minutes = Math.floor(agoMs / 60_000);
  if (minutes < 1) return words('windows.agoMoment');
  if (minutes < 60) return words(minutes === 1 ? 'windows.agoMinute' : 'windows.agoMinutes', { n: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return words(hours === 1 ? 'windows.agoHour' : 'windows.agoHours', { n: String(hours) });
  const days = Math.floor(hours / 24);
  return words(days === 1 ? 'windows.agoDay' : 'windows.agoDays', { n: String(days) });
}
function resetText(resetsAt: number | undefined, nowMs: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt) || !Number.isFinite(nowMs)) return words('windows.resetUnknown');
  const minutes = Math.max(0, Math.ceil((resetsAt - nowMs) / 60_000));
  if (minutes < 60) return words('windows.reset', { time: `${minutes}m` });
  const hours = Math.floor(minutes / 60); const rest = minutes % 60;
  if (hours < 24) return words('windows.reset', { time: rest ? `${hours}h ${rest}m` : `${hours}h` });
  const days = Math.floor(hours / 24); const rem = hours % 24;
  return words('windows.reset', { time: rem ? `${days}d ${rem}h` : `${days}d` });
}
function lineText(kind: Kind, usedPercent: number | undefined): string {
  const label = words(windowLabels[kind]);
  if (usedPercent === undefined || !Number.isFinite(usedPercent)) return words('windows.unknown', { label });
  const left = Math.round(Math.max(0, Math.min(100, 100 - usedPercent)));
  return words('windows.left', { label, left: `${left}%` });
}
const measured = (window: Reading['windows'][number]): number => typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : Number.NEGATIVE_INFINITY;
/** Both usage windows, tightest first, each with its millisecond reset and an age taken only from Reading.at. */
export function windowsView(reading: Reading, nowMs: number): WindowsView {
  const at = reading.at;
  const validNow = Number.isFinite(nowMs);
  const ageMs = at !== undefined && Number.isFinite(at) && validNow && nowMs >= at ? nowMs - at : undefined;
  const freshness: Freshness = at === undefined || !Number.isFinite(at) || !validNow ? 'unknown' : nowMs < at ? 'future' : ageMs! > 86_400_000 ? 'stale' : 'fresh';
  const ageText = freshness === 'future' ? undefined : freshness === 'unknown' ? words('windows.ageUnknown') : words('windows.age', { ago: agoText(ageMs!) });
  const windows = reading.windows.map((window, ordinal) => ({ window, ordinal }))
    .sort((a, b) => measured(b.window) - measured(a.window) || a.ordinal - b.ordinal)
    .map(({ window }): WindowLine => ({
      provider: window.provider, kind: window.kind,
      ...(window.scope ? { scope: window.scope } : {}), ...(window.limit ? { limit: window.limit } : {}),
      ...(window.usedPercent !== undefined ? { usedPercent: window.usedPercent } : {}),
      ...(window.limited ? { limited: true } : {}), ...(window.resetsAt !== undefined ? { resetsAt: window.resetsAt } : {}),
      text: lineText(window.kind, window.usedPercent), resetText: resetText(window.resetsAt, nowMs),
    }));
  return { windows, ...(at !== undefined ? { at } : {}), ...(ageMs !== undefined ? { ageMs } : {}),
    ...(ageText !== undefined ? { ageText } : {}), freshness, stale: freshness === 'stale' };
}
