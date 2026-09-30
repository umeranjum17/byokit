// Messages over fetch alone. Authentication is explicit and separate from the request, so a future auth route can
// supply different headers without changing messages, tools, events or results. No environment or credential reads.
import { IncompleteError, ResponseError, type ResponseResult } from './responses.ts';

export type AnthropicCacheControl = { type: 'ephemeral'; ttl?: '5m' | '1h' };
export type AnthropicText = { type: 'text'; text: string; cache_control?: AnthropicCacheControl; citations?: unknown[] };
export type AnthropicImage = { type: 'image'; source:
  | { type: 'base64'; media_type: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp'; data: string }
  | { type: 'url'; url: string }; cache_control?: AnthropicCacheControl };
export type AnthropicToolUse = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
export type AnthropicThinking = { type: 'thinking'; thinking: string; signature: string };
export type AnthropicContent = AnthropicText | AnthropicImage | AnthropicToolUse | AnthropicThinking
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_result'; tool_use_id: string; content?: string | AnthropicContent[]; is_error?: boolean; cache_control?: AnthropicCacheControl }
  | { type: string; [key: string]: unknown };
export type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContent[] };
export type AnthropicTool = { name: string; description?: string; input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }; cache_control?: AnthropicCacheControl; strict?: boolean; defer_loading?: boolean; input_examples?: Record<string, unknown>[]; allowed_callers?: string[]; [key: string]: unknown }
  | { type: string; name: string; [key: string]: unknown };
export type AnthropicToolChoice = { type: 'auto' | 'any' | 'none'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean };
export type AnthropicUsage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; [key: string]: unknown };
export type AnthropicResponse = { id: string; type: 'message'; role: 'assistant'; model: string; content: AnthropicContent[]; stop_reason: string | null; stop_sequence: string | null; usage: AnthropicUsage; [key: string]: unknown };

/** Native Messages options; no translation or silent selection of a billed provider/model. */
export type AnthropicRequest = {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string | AnthropicText[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: { type: 'enabled'; budget_tokens: number; display?: 'summarized' | 'omitted' | 'updates' }
    | { type: 'disabled' } | { type: 'adaptive'; display?: 'summarized' | 'omitted' | 'updates' };
  stop_sequences?: string[];
  metadata?: { user_id?: string };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  service_tier?: 'auto' | 'standard_only';
  output_config?: { effort?: 'low' | 'medium' | 'high' | 'max'; format?: { type: 'json_schema'; schema: Record<string, unknown> }; [key: string]: unknown };
  cache_control?: AnthropicCacheControl;
  /** Additional native options are passed through unchanged. */
  [key: string]: unknown;
};
export type AnthropicResult = ResponseResult & {
  status: 'completed' | 'incomplete';
  incompleteReason?: string;
  usage: AnthropicUsage;
  raw: AnthropicResponse;
};
/** The shared incomplete contract, with native usage/raw retained on the partial result. */
export class AnthropicIncompleteError extends IncompleteError {
  declare result: AnthropicResult;
  constructor(reason: string, result: AnthropicResult) {
    super(reason, result);
    this.message = 'Anthropic cut off its answer before it was complete.';
  }
}
export type AnthropicStreamEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_use_delta'; index: number; id: string; name: string; delta: string }
  | { type: 'tool_use'; index: number; tool: AnthropicToolUse }
  | { type: 'content_block'; index: number; block: AnthropicContent }
  | { type: 'message_start'; message: AnthropicResponse }
  | { type: 'message_delta'; delta: Partial<AnthropicResponse>; usage?: Partial<AnthropicUsage> }
  | { type: 'message_stop'; message: AnthropicResponse }
  | { type: 'incomplete'; reason: string; response: AnthropicResponse };
export type AnthropicAsk = AnthropicRequest & {
  onText?: (delta: string) => void;
  onEvent?: (event: AnthropicStreamEvent) => void;
  signal?: AbortSignal;
  /** Return metadata even without tools. */
  result?: boolean;
};
export type AnthropicOptions = {
  /** API key (billed per use), passed by the app. Never loaded from env/files. */
  key: string;
  fetch?: typeof fetch;
  /** An app-owned proxy or a stand-in in tests. */
  base?: string;
  /** Native beta headers, only when the app explicitly requests them. */
  betas?: readonly string[];
};

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const error = (status: number, value: unknown): ResponseError => {
  const e = record(value) && record(value.error) ? value.error : {};
  const kind = status === 429 || e.type === 'rate_limit_error' ? 'rate_limit'
    : status === 401 || status === 403 || e.type === 'authentication_error' ? 'signed_out'
      : status >= 500 || e.type === 'overloaded_error' ? 'overloaded' : null;
  return new ResponseError(typeof e.message === 'string' ? e.message : 'Anthropic could not answer. Try again.', kind);
};

/** Recorded Messages SSE, split at arbitrary UTF-8/chunk boundaries. Completion requires message_stop. */
export function anthropicSseReader(onText?: (delta: string) => void, onEvent?: (event: AnthropicStreamEvent) => void) {
  let buffer = '', message: AnthropicResponse | undefined, stopped = false, finished: AnthropicResult | undefined;
  const blocks = new Map<number, { block: Record<string, any>; json: string; stopped: boolean; landed: boolean }>();
  const fail = () => new ResponseError('Anthropic stopped before completing its answer.', 'network');
  const notifyText = (delta: string) => { if (delta) { onText?.(delta); onEvent?.({ type: 'text_delta', delta }); } };
  const event = (block: string) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return;
    let e: any;
    try { e = JSON.parse(data); } catch { throw new ResponseError("Anthropic's answer could not be read.", null); }
    if (!record(e)) throw fail();
    if (e.type === 'error') throw error(0, e);
    if (stopped) return;
    if (e.type === 'message_start') {
      if (message || !record(e.message) || !Array.isArray(e.message.content) || !record(e.message.usage)) throw fail();
      message = { ...e.message, content: [...e.message.content], usage: { ...e.message.usage } } as AnthropicResponse;
      onEvent?.({ type: 'message_start', message: structuredCopy(message) });
      return;
    }
    if (e.type === 'ping') return;
    if (e.type === 'content_block_start') {
      if (!message || !Number.isSafeInteger(e.index) || e.index < 0 || blocks.has(e.index) || !record(e.content_block)) throw fail();
      const b = { ...e.content_block };
      blocks.set(e.index, { block: b, json: '', stopped: false, landed: false });
      message.content[e.index] = b as AnthropicContent;
      if (b.type === 'text' && typeof b.text === 'string') notifyText(b.text);
    } else if (e.type === 'content_block_delta') {
      const at = blocks.get(e.index);
      if (!at || at.stopped || !record(e.delta)) throw fail();
      const d = e.delta;
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        if (at.block.type !== 'text') throw fail();
        at.block.text += d.text;
        notifyText(d.text);
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        if (at.block.type !== 'tool_use' && at.block.type !== 'server_tool_use') throw fail();
        at.json += d.partial_json;
        onEvent?.({ type: 'tool_use_delta', index: e.index, id: at.block.id, name: at.block.name, delta: d.partial_json });
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') at.block.thinking = (at.block.thinking ?? '') + d.thinking;
      else if (d.type === 'signature_delta' && typeof d.signature === 'string') at.block.signature = (at.block.signature ?? '') + d.signature;
      else if (d.type === 'citations_delta' && record(d.citation)) at.block.citations = [...(at.block.citations ?? []), d.citation];
    } else if (e.type === 'content_block_stop') {
      const at = blocks.get(e.index);
      if (!at || at.stopped) throw fail();
      at.stopped = true;
      // Emit valid blocks as they land. An interrupted JSON block must wait for the stop reason: max_tokens
      // preserves that partial call without emitting an executable tool-use event.
      if (at.json) {
        try {
          const input: unknown = JSON.parse(at.json);
          if (record(input)) at.block.input = input;
          else return;
        } catch { return; }
      }
      onEvent?.({ type: 'content_block', index: e.index, block: structuredCopy(at.block) as AnthropicContent });
      if (at.block.type === 'tool_use') {
        if (typeof at.block.id !== 'string' || typeof at.block.name !== 'string' || !record(at.block.input)) throw fail();
        onEvent?.({ type: 'tool_use', index: e.index, tool: structuredCopy(at.block) as AnthropicToolUse });
      }
      at.landed = true;
    } else if (e.type === 'message_delta') {
      if (!message || !record(e.delta)) throw fail();
      Object.assign(message, e.delta);
      if (record(e.usage)) Object.assign(message.usage, e.usage); // cumulative, never summed
      onEvent?.({ type: 'message_delta', delta: e.delta, ...(record(e.usage) ? { usage: e.usage } : {}) });
    } else if (e.type === 'message_stop') {
      if (!message || !message.stop_reason || [...blocks.values()].some((b) => !b.stopped)) throw fail();
      stopped = true;
    }
  };
  const drain = (final: boolean) => {
    let tail = '';
    if (!final && buffer.endsWith('\r')) { tail = '\r'; buffer = buffer.slice(0, -1); }
    const parts = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
    buffer = (final ? '' : parts.pop()!) + tail;
    for (const part of parts) event(part);
  };
  const result = (): AnthropicResult => {
    if (finished) {
      if (finished.status === 'incomplete') throw new AnthropicIncompleteError(finished.incompleteReason!, finished);
      return finished;
    }
    drain(true);
    if (!stopped || !message) throw fail();
    const incomplete = message.stop_reason === 'max_tokens' || message.stop_reason === 'refusal';
    const output: ResponseResult['output'] = [];
    for (const [index, at] of [...blocks].sort(([a], [b]) => a - b)) {
      if (at.json) {
        try {
          const input: unknown = JSON.parse(at.json);
          if (!record(input)) throw new Error('not an object');
          at.block.input = input;
        } catch {
          if (!incomplete) throw new ResponseError("Anthropic's tool call could not be read.", null);
          at.block.partial_json = at.json;
          delete at.block.input;
        }
      }
      const b = at.block;
      if (!at.landed) onEvent?.({ type: 'content_block', index, block: b as AnthropicContent });
      if (b.type === 'tool_use' && record(b.input)) {
        output.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input) });
        if (!incomplete && !at.landed) onEvent?.({ type: 'tool_use', index, tool: b as AnthropicToolUse });
      } else if (b.type === 'thinking' || b.type === 'redacted_thinking') output.push({ ...b, type: 'reasoning' });
    }
    const text = message.content.filter((b) => b.type === 'text').map((b) => 'text' in b && typeof b.text === 'string' ? b.text : '').join('');
    if (text) output.unshift({ type: 'message', id: message.id, role: message.role, content: [{ type: 'output_text', text }] });
    finished = { text, output, status: incomplete ? 'incomplete' : 'completed', ...(incomplete ? { incompleteReason: message.stop_reason! } : {}), usage: message.usage, raw: message };
    if (incomplete) onEvent?.({ type: 'incomplete', reason: message.stop_reason!, response: message });
    onEvent?.({ type: 'message_stop', message });
    if (incomplete) throw new AnthropicIncompleteError(message.stop_reason!, finished);
    return finished;
  };
  return { push(chunk: string) { buffer += chunk; drain(false); }, result, end() { return result().text; } };
}

const structuredCopy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Explicit API-key backend. Use respond({ result: true }) for usage/raw. Incomplete answers always throw. */
export function anthropic(opts: AnthropicOptions) {
  if (!opts.key.trim()) throw new Error('Anthropic needs an API key (billed per use).');
  async function respond(o: AnthropicAsk & { result: true }): Promise<AnthropicResult>;
  async function respond(o: AnthropicAsk & { tools: AnthropicTool[] }): Promise<AnthropicResult>;
  async function respond(o: AnthropicAsk & { tools?: undefined; result?: false }): Promise<string>;
  async function respond(o: AnthropicAsk): Promise<string | AnthropicResult>;
  async function respond(o: AnthropicAsk): Promise<string | AnthropicResult> {
    const { onText, onEvent, signal, result, ...request } = o;
    if (!request.model || !Number.isSafeInteger(request.max_tokens) || request.max_tokens <= 0) throw new Error('Anthropic needs a model and a positive max_tokens.');
    const res = await (opts.fetch ?? fetch)(`${(opts.base ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'x-api-key': opts.key, 'anthropic-version': '2023-06-01',
        ...(opts.betas?.length ? { 'anthropic-beta': opts.betas.join(',') } : {}) },
      body: JSON.stringify({ ...request, stream: true }),
    });
    if (!res.ok) {
      let body: unknown;
      try { body = await res.json(); } catch {}
      throw error(res.status, body);
    }
    const reader = anthropicSseReader(onText, onEvent);
    const body = res.body;
    if (res.headers?.get('content-type')?.includes('application/json')) {
      let message: unknown;
      try { message = await res.json(); } catch { throw new ResponseError("Anthropic's answer could not be read.", null); }
      if (!record(message) || !Array.isArray(message.content)) throw new ResponseError("Anthropic's answer could not be read.", null);
      const emit = (event: unknown) => reader.push(`data: ${JSON.stringify(event)}\n\n`);
      emit({ type: 'message_start', message: { ...message, content: [] } });
      for (const [index, block] of message.content.entries()) {
        emit({ type: 'content_block_start', index, content_block: block });
        emit({ type: 'content_block_stop', index });
      }
      emit({ type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: message.stop_sequence }, usage: message.usage });
      emit({ type: 'message_stop' });
    } else if (body?.getReader && typeof TextDecoder !== 'undefined') {
      const r = body.getReader(), decoder = new TextDecoder();
      try {
        for (let c = await r.read(); !c.done; c = await r.read()) reader.push(decoder.decode(c.value, { stream: true }));
        reader.push(decoder.decode());
      } catch (e) {
        await r.cancel().catch(() => {});
        throw e;
      } finally { r.releaseLock(); }
    } else reader.push(await res.text());
    const answer = reader.result();
    return o.tools || result ? answer : answer.text;
  }
  return { respond };
}
