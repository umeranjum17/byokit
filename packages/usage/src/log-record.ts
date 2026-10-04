import { createHash } from 'node:crypto';
import { normalizeTokens, type NormalizedTokens } from './calls.ts';
import { record } from './windows.ts';

export type HarnessLogFormat = 'pi' | 'omp' | 'claude' | 'codex';
/** Only recorded metadata and normalized counts, never transcript content or paths. */
export interface HarnessLogEntry {
  /** Digest of the format's evidenced event identity; not an account or run identity. */
  id: string;
  format: HarnessLogFormat;
  time: number;
  provider?: string;
  model?: string;
  usage: NormalizedTokens;
}
export interface LogContext { provider?: string; model?: string; total?: number }
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\x00-\x1f\x7f]/.test(v);
const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const time = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
};
/** Strict subset qualified by the consumer's synthetic fixtures. No inferred attribution. */
export function logRecord(line: Buffer, format: HarnessLogFormat, context: LogContext): HarnessLogEntry | 'malformed' | undefined {
  let raw: unknown;
  try { raw = JSON.parse(line.toString('utf8')); } catch { return 'malformed'; }
  if (!record(raw)) return 'malformed';
  let stamp: number | undefined;
  let identity: unknown[];
  let provider: string | undefined;
  let model: string | undefined;
  let usage: NormalizedTokens;
  if (format === 'codex') {
    if (!record(raw.payload)) return undefined;
    const payload = raw.payload;
    if (raw.type === 'session_meta') { context.provider = text(payload.model_provider) ? payload.model_provider : undefined; return undefined; }
    if (raw.type === 'turn_context') { context.model = text(payload.model) ? payload.model : undefined; return undefined; }
    if (raw.type !== 'event_msg' || payload.type !== 'token_count') return undefined;
    if (!record(payload.info) || !record(payload.info.total_token_usage) || !record(payload.info.last_token_usage)) return 'malformed';
    const total = payload.info.total_token_usage.total_tokens;
    stamp = time(raw.timestamp);
    if (!count(total) || total === 0 || stamp === undefined) return 'malformed';
    if (total <= (context.total ?? 0)) return undefined;
    const last = payload.info.last_token_usage;
    usage = normalizeTokens('openai', { ...last, input_tokens_details: { cached_tokens: last.cached_input_tokens, cache_write_tokens: last.cache_write_input_tokens } });
    if (usage.provenance === 'unknown') return 'malformed';
    context.total = total;
    identity = [raw.timestamp, total];
    provider = context.provider; model = context.model;
  } else {
    if (!record(raw.message) || raw.message.role !== 'assistant' || !record(raw.message.usage)) return undefined;
    const message = raw.message;
    model = text(message.model) ? message.model : undefined;
    if (format === 'claude') {
      if (model === '<synthetic>') return undefined;
      stamp = time(raw.timestamp);
      if (!text(message.id) || !text(raw.requestId)) return 'malformed';
      identity = [message.id, raw.requestId]; provider = 'anthropic';
      usage = normalizeTokens('anthropic', message.usage);
    } else {
      stamp = time(message.timestamp ?? raw.timestamp);
      if (!text(raw.id) || time(raw.timestamp) === undefined) return 'malformed';
      identity = [raw.id, raw.timestamp];
      provider = text(message.provider) ? message.provider : undefined;
      usage = normalizeTokens(provider ?? '', message.usage, 'openclaw');
    }
    if (stamp === undefined || usage.provenance === 'unknown') return 'malformed';
  }
  return { id: createHash('sha256').update(JSON.stringify([format, ...identity])).digest('hex'), format, time: stamp,
    ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), usage };
}
