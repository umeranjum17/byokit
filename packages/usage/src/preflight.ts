import { priceCall, type CallCost, type PriceTable } from './calls.ts';
import { TokenLedgerError, type TokenQuery } from './ledger.ts';
import type { Room } from './types.ts';

export interface PreflightCall {
  provider: string;
  model: string;
  /** Subscription by default; API key (billed per use) attribution is explicit. */
  billing?: 'subscription' | 'api';
  /** Input tokens the app counted for this request, cache reads and writes included. */
  inputTokens: number;
  /** The request's output ceiling, such as Messages `max_tokens`. Absent means unbounded. */
  maxOutputTokens?: number;
}
export type PreflightUnknown = 'no-price' | 'billing-mismatch' | 'output-unbounded' | 'invalid-price';
export interface Preflight {
  billing: 'subscription' | 'api';
  billingLabel: "Person's own plan" | "Person's API bill";
  /** Input plus the output ceiling; absent when output is unbounded. */
  tokens: { input: number; maxOutput?: number; max?: number };
  /** A ceiling from the app's price row at the full output allowance, never a bundled or default rate. */
  cost: (CallCost & { ceiling: true }) | { amount: 'unknown'; reason: PreflightUnknown };
  /** The member's seven-day token allowance from `tokenLedger().query(...).week`. */
  allowance: { remaining: number; cap: number; from: number; to: number } | { remaining: 'uncapped' }
    | { remaining: 'unknown'; reason: 'not-supplied' | 'unrecorded-usage' };
  /** Plan room from `roomOf`; only for subscription calls, which never draw on an API bill. */
  plan?: Room;
  /** Whether the token ceiling exceeds the remaining allowance. */
  exceeds: boolean | 'unknown';
}
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const label = (billing: Preflight['billing']) => billing === 'subscription' ? "Person's own plan" as const : "Person's API bill" as const;

/** Reports what a call could cost and the allowance left. It never sends the call; the caller decides. */
export function preflight(call: PreflightCall, context: { prices?: PriceTable; allowance?: TokenQuery['week']; room?: Room } = {}): Preflight {
  if (!call || typeof call.provider !== 'string' || typeof call.model !== 'string' || !count(call.inputTokens)
    || call.maxOutputTokens !== undefined && !count(call.maxOutputTokens)
    || call.billing !== undefined && !['subscription', 'api'].includes(call.billing)) throw new TokenLedgerError('invalid');
  const billing = call.billing ?? 'subscription';
  const max = call.maxOutputTokens === undefined ? undefined : call.inputTokens + call.maxOutputTokens;
  const tokens = { input: call.inputTokens, ...(max === undefined ? {} : { maxOutput: call.maxOutputTokens, max }) };
  const price = context.prices?.[call.provider]?.[call.model];
  let cost: Preflight['cost'];
  if (!price) cost = { amount: 'unknown', reason: 'no-price' };
  else if (price.billing !== billing) cost = { amount: 'unknown', reason: 'billing-mismatch' };
  else if (max === undefined) cost = { amount: 'unknown', reason: 'output-unbounded' };
  else if (typeof price.inputPerMillion !== 'number' || !Number.isFinite(price.inputPerMillion) || price.inputPerMillion < 0
    || price.cachedInputPerMillion !== undefined && (typeof price.cachedInputPerMillion !== 'number' || !Number.isFinite(price.cachedInputPerMillion) || price.cachedInputPerMillion < 0)
    || price.cacheWritePerMillion !== undefined && (typeof price.cacheWritePerMillion !== 'number' || !Number.isFinite(price.cacheWritePerMillion) || price.cacheWritePerMillion < 0)) cost = { amount: 'unknown', reason: 'invalid-price' };
  else {
    // Cache reads and writes are unknown before the call, so all input is priced at the dearest input rate.
    const inputRate = Math.max(price.inputPerMillion, price.cachedInputPerMillion ?? 0, price.cacheWritePerMillion ?? 0);
    const priced = priceCall({ input: call.inputTokens, output: call.maxOutputTokens, total: max, provenance: 'reported' },
      { billing: price.billing, currency: price.currency, inputPerMillion: inputRate, outputPerMillion: price.outputPerMillion }, billing);
    cost = priced ? { ...priced, ceiling: true } : { amount: 'unknown', reason: 'invalid-price' };
  }
  const week = context.allowance;
  const allowance: Preflight['allowance'] = !week ? { remaining: 'unknown', reason: 'not-supplied' }
    : week.cap === undefined ? { remaining: 'uncapped' }
    : week.remaining === undefined ? { remaining: 'unknown', reason: 'unrecorded-usage' }
    : { remaining: week.remaining, cap: week.cap, from: week.from, to: week.to };
  const exceeds = allowance.remaining === 'uncapped' ? false
    : allowance.remaining === 'unknown' || max === undefined ? 'unknown' : max > allowance.remaining;
  return { billing, billingLabel: label(billing), tokens, cost, allowance,
    ...(billing === 'subscription' && context.room ? { plan: { ...context.room } } : {}), exceeds };
}
