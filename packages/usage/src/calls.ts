import { record as isRecord } from './windows.ts';
import { memoryTokenLedgerStore, TokenLedgerError, type TokenLedgerStore, type TokenEntry } from './ledger.ts';
import type { Window } from './types.ts';
import { safeWindows } from './store.ts';

export interface NormalizedTokens {
  /** Input includes cache reads and cache writes; cache counts are subsets. */
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheWrite?: number;
  total?: number;
  provenance: 'reported' | 'partial' | 'unknown';
}
export interface ModelPrice {
  billing: 'subscription' | 'api';
  currency: string;
  inputPerMillion: number;
  outputPerMillion: number;
  cachedInputPerMillion?: number;
  cacheWritePerMillion?: number;
}
export type PriceTable = Readonly<Record<string, Readonly<Record<string, ModelPrice>>>>;
export interface CallCost {
  amount: number;
  currency: string;
  billing: ModelPrice['billing'];
  label: "Person's own plan" | "Person's API bill";
  basis: 'app-prices';
  estimated: true;
}
export interface CallInput {
  provider: string;
  account: string;
  model: string;
  runId: string;
  time: number;
  billing: 'subscription' | 'api';
  /** Native provider usage/envelope, or normalized input/output/cachedInput/cacheWrite/total counts. */
  usage?: unknown;
  payer?: string;
  durationMs?: number;
  state?: 'completed' | 'cancelled' | 'failed';
  limits?: readonly Window[];
}
export interface CallRecord extends Omit<CallInput, 'usage' | 'limits'> {
  tokens: NormalizedTokens;
  state: 'completed' | 'cancelled' | 'failed';
  cost?: CallCost;
  limits?: Window[];
}
export interface CallQuery {
  calls: CallRecord[];
  tokens: NormalizedTokens;
  /** Separate subtotals by currency and billing; unpriced calls are counted explicitly. */
  costs: CallCost[];
  unpricedCalls: number;
}
export interface CallLedger {
  record(member: string, call: CallInput): CallRecord;
  query(member: string, from: number, to: number): CallQuery;
}
const object = (value: unknown): Record<string, unknown> => isRecord(value) ? value : {};
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const text = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 1024 && !/[\0\r\n]/.test(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && !Number.isNaN(new Date(value).getTime());
const sum = (...values: number[]): number | undefined => count(values.reduce((a, b) => a + b, 0));
function normalized(input?: number, output?: number, cachedInput?: number, cacheWrite?: number, total?: number): NormalizedTokens {
  if (input !== undefined && ((cachedInput ?? 0) + (cacheWrite ?? 0) > input)) return { provenance: 'unknown' };
  const derived = input !== undefined && output !== undefined ? sum(input, output) : undefined;
  // Inconsistent reported totals are not a reliable measurement.
  if (derived !== undefined && total !== undefined && derived !== total) return { provenance: 'unknown' };
  const measured = derived ?? total;
  return { ...(input === undefined ? {} : { input }), ...(output === undefined ? {} : { output }),
    ...(cachedInput === undefined ? {} : { cachedInput }), ...(cacheWrite === undefined ? {} : { cacheWrite }),
    ...(measured === undefined ? {} : { total: measured }),
    provenance: input !== undefined && output !== undefined && derived !== undefined ? 'reported' : [input, output, cachedInput, cacheWrite, measured].some((v) => v !== undefined) ? 'partial' : 'unknown' };
}
/** Pure normalization of reported counts, never estimates from text or shared decision invocations. */
export function normalizeTokens(provider: string, raw: unknown): NormalizedTokens {
  const envelope = object(raw);
  const usage = object(envelope.usage ?? envelope.usageMetadata ?? raw);
  if (usage.provenance === 'unknown' || usage.provenance === 'estimated') return { provenance: 'unknown' };
  if (['input', 'output', 'total'].some((key) => key in usage)) return normalized(count(usage.input), count(usage.output), count(usage.cachedInput), count(usage.cacheWrite), count(usage.total));
  if (provider === 'claude' || provider === 'anthropic') {
    if (!['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].some((key) => count(usage[key]) !== undefined)) return { provenance: 'unknown' };
    const uncached = count(usage.input_tokens);
    const cached = count(usage.cache_read_input_tokens) ?? (usage.cache_read_input_tokens === undefined ? 0 : undefined);
    const written = count(usage.cache_creation_input_tokens) ?? (usage.cache_creation_input_tokens === undefined ? 0 : undefined);
    const input = uncached !== undefined && cached !== undefined && written !== undefined ? sum(uncached, cached, written) : undefined;
    return normalized(input, count(usage.output_tokens), cached, written);
  }
  if (provider === 'gemini' || provider === 'google') {
    const output = count(usage.candidatesTokenCount); const thoughts = count(usage.thoughtsTokenCount) ?? (usage.thoughtsTokenCount === undefined ? 0 : undefined);
    const input = count(usage.promptTokenCount);
    return normalized(input, output !== undefined && thoughts !== undefined ? sum(output, thoughts) : undefined,
      count(usage.cachedContentTokenCount), undefined, count(usage.totalTokenCount));
  }
  const input = count(usage.input_tokens ?? usage.prompt_tokens); const output = count(usage.output_tokens ?? usage.completion_tokens);
  const details = object(usage.input_tokens_details ?? usage.prompt_tokens_details);
  return normalized(input, output, count(details.cached_tokens),
    count(details.cache_write_tokens), count(usage.total_tokens));
}
/** App-supplied price estimates only, including explicit billing attribution. */
export function priceCall(tokens: NormalizedTokens, price: ModelPrice | undefined, billing: ModelPrice['billing']): CallCost | undefined {
  if (!price || price.billing !== billing || tokens.input === undefined || tokens.output === undefined || tokens.provenance !== 'reported' || !text(price.currency)) return undefined;
  if ([tokens.input, tokens.output, tokens.cachedInput, tokens.cacheWrite, tokens.total].some((value) => value !== undefined && count(value) === undefined) || tokens.total !== undefined && tokens.input + tokens.output !== tokens.total) return undefined;
  const rates = [price.inputPerMillion, price.outputPerMillion, price.cachedInputPerMillion, price.cacheWritePerMillion];
  if (rates.some((rate) => rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0))) return undefined;
  if (typeof price.inputPerMillion !== 'number' || typeof price.outputPerMillion !== 'number') return undefined;
  if (tokens.cachedInput === undefined && price.cachedInputPerMillion !== undefined && price.cachedInputPerMillion !== price.inputPerMillion
    || tokens.cacheWrite === undefined && price.cacheWritePerMillion !== undefined && price.cacheWritePerMillion !== price.inputPerMillion) return undefined;
  const cached = tokens.cachedInput ?? 0; const written = tokens.cacheWrite ?? 0;
  const ordinary = tokens.input - cached - written;
  if (ordinary < 0) return undefined;
  const amount = (ordinary * price.inputPerMillion + cached * (price.cachedInputPerMillion ?? price.inputPerMillion)
    + written * (price.cacheWritePerMillion ?? price.inputPerMillion) + tokens.output * price.outputPerMillion) / 1_000_000;
  if (!Number.isFinite(amount)) return undefined;
  return { amount, currency: price.currency, billing, label: billing === 'subscription' ? "Person's own plan" : "Person's API bill", basis: 'app-prices', estimated: true };
}
function aggregate(calls: readonly CallRecord[]): NormalizedTokens {
  const field = (key: keyof Omit<NormalizedTokens, 'provenance'>): number | undefined => calls.every((call) => call.tokens[key] !== undefined) ? count(calls.reduce((total, call) => total + call.tokens[key]!, 0)) : undefined;
  return normalized(field('input'), field('output'), field('cachedInput'), field('cacheWrite'), field('total'));
}
/** Every recorded attempt is a call; the host records retries separately under its run id. */
export function callLedger(options: { store?: TokenLedgerStore; prices?: PriceTable } = {}): CallLedger {
  const store = options.store ?? memoryTokenLedgerStore();
  return {
    record(member, call) {
      if (!text(member) || !call || ![call.provider, call.account, call.model, call.runId].every(text) || !time(call.time)
        || !['subscription', 'api'].includes(call.billing) || call.payer !== undefined && !text(call.payer)
        || call.durationMs !== undefined && (typeof call.durationMs !== 'number' || !Number.isFinite(call.durationMs) || call.durationMs < 0)
        || call.state !== undefined && !['completed', 'cancelled', 'failed'].includes(call.state) || call.limits !== undefined && !Array.isArray(call.limits)) throw new TokenLedgerError('invalid');
      const tokens = normalizeTokens(call.provider, call.usage);
      const cost = priceCall(tokens, options.prices?.[call.provider]?.[call.model], call.billing);
      const limits = call.limits?.flatMap((window) => safeWindows(window.provider, [window]));
      const result: CallRecord = { provider: call.provider, account: call.account, model: call.model, runId: call.runId, time: call.time,
        billing: call.billing, payer: call.payer ?? member, state: call.state ?? 'completed', tokens,
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }), ...(cost ? { cost } : {}), ...(limits ? { limits } : {}) };
      try { store.record(member, { time: call.time, tokens: tokens.total ?? 0, call: copyCall(result) }); } catch { throw new TokenLedgerError('store'); }
      return result;
    },
    query(member, from, to) {
      if (!text(member) || !time(from) || !time(to) || to < from) throw new TokenLedgerError('invalid');
      let entries: readonly TokenEntry[];
      try { entries = store.query(member, from, to); } catch { throw new TokenLedgerError('store'); }
      if (!Array.isArray(entries)) throw new TokenLedgerError('invalid');
      const calls = entries.filter((entry) => entry.call && entry.time >= from && entry.time < to).map((entry) => copyCall(entry.call!)).sort((a, b) => a.time - b.time);
      const costs = new Map<string, CallCost>();
      for (const call of calls) {
        if (!call.cost) continue;
        const key = `${call.cost.currency}\0${call.cost.billing}`; const previous = costs.get(key);
        costs.set(key, { ...call.cost, amount: (previous?.amount ?? 0) + call.cost.amount });
      }
      return { calls, tokens: aggregate(calls), costs: [...costs.values()], unpricedCalls: calls.filter((call) => !call.cost).length };
    },
  };
}

function copyCall(call: CallRecord): CallRecord {
  return { ...call, tokens: { ...call.tokens }, ...(call.cost ? { cost: { ...call.cost } } : {}),
    ...(call.limits ? { limits: call.limits.map((window) => ({ ...window })) } : {}) };
}
