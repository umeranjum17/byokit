// One question to ChatGPT, answered as it streams, with fetch alone: what a phone or browser app asks the model with
// the sign-in it holds. Rules are the shared fixtures (sse.json, limit-responses.json). A fetch that can't stream (React
// Native's own) still works: the whole answer arrives at once. Expo's `fetch` from 'expo/fetch' streams.
//
// The pass-through is complete but typed: a message array (multi-turn, with `input_image` and `function_call_output`
// turns), `tools` and `tool_choice` (function tools and built-ins, including `image_generation`), `reasoning.effort`,
// and `text.verbosity` with the `text.format` schema. Without `tools` the answer is the plain text, as before; with
// `tools` the result carries the output items (`function_call` and the rest) next to the text.
import { classify, type Kind } from './limits.ts';

const limitKind = (code: string): Kind | null => code === 'usage_not_included' ? 'not_included'
  : /^(usage_limit_reached|rate_limit_exceeded)$/.test(code) ? 'rate_limit' : null;

/** A failed answer: the words to show, and the kind an app acts on (null for one that isn't about the account). */
export class ResponseError extends Error {
  kind: Kind | null;
  /** When the provider said to come back (epoch ms), or 0. */
  until: number;
  constructor(message: string, kind: Kind | null, until = 0) { super(message); this.kind = kind; this.until = until; }
}

/** An answer the provider cut off. Partial output is available, but never returned as a successful answer. */
export class IncompleteError extends ResponseError {
  reason: string;
  result: ResponseResult;
  constructor(reason: string, result: ResponseResult) {
    super('ChatGPT cut off its answer before it was complete.', null);
    this.name = 'IncompleteError';
    this.reason = reason;
    this.result = result;
  }
}

/** A ChatGPT HTTP error as the kind, when to come back, and the message (fixtures/conformance/limit-responses.json). */
export function limitResponse(status: number, body: string, now = Date.now()): { kind: Kind | null; until: number | null; message: string } {
  let err: any = {};
  try { err = JSON.parse(body)?.error ?? {}; } catch {}
  const code = String(err.code || err.type || '');
  if (limitKind(code) || status === 429) {
    const resets = typeof err.resets_at === 'number' ? err.resets_at * 1000 : null;
    const message = 'You have hit your ChatGPT usage limit' + (err.plan_type ? ` (${String(err.plan_type).toLowerCase()} plan)` : '') + '.' +
      (resets ? ` Try again in ~${Math.max(0, Math.round((resets - now) / 60_000))} min.` : '');
    return { kind: limitKind(code) ?? 'rate_limit', until: resets, message };
  }
  const kind: Kind | null = status === 401 || status === 403 ? 'signed_out' : [500, 502, 503, 504].includes(status) ? 'overloaded' : null;
  return { kind, until: null, message: (typeof err.message === 'string' && err.message) || body || 'Request failed' };
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null;
const itemKey = (item: Record<string, any>, fallback: string | number): string =>
  typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `${String(item.type)}:${String(fallback)}`;

/** One piece of a message the model is given: words, a picture, or anything else the endpoint accepts. */
export type ResponseInputContent =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url?: string; file_id?: string; detail?: 'auto' | 'low' | 'high' }
  | { type: string; [k: string]: unknown };

/** What the model is told, in turn: a message (one turn of the conversation), a call it made, or a tool's answer. */
export type ResponseInputItem =
  | { type?: 'message'; role: 'user' | 'assistant' | 'system' | 'developer'; content: string | ResponseInputContent[] }
  | { type: 'function_call'; call_id?: string; id?: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: string; [k: string]: unknown };

/** A tool the model may call: one of the app's functions, or a built-in such as image generation. */
export type ResponseTool =
  | { type: 'function'; name: string; description?: string; parameters?: Record<string, unknown> | null; strict?: boolean }
  | { type: 'image_generation'; model?: string; size?: string; quality?: string; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Which tool the model must use: any, a named function, none, or whatever it wants. */
export type ResponseToolChoice =
  | 'auto' | 'required' | 'none'
  | { type: 'function'; name: string }
  | { type: string; [k: string]: unknown };

/** How hard the model thinks. Default: none, as before. */
export type ResponseReasoning = { effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'; [k: string]: unknown };

/** The shape of the answer: how wordy, and optionally a schema it must follow. */
export type ResponseTextFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean }
  | { type: string; [k: string]: unknown };
export type ResponseText = { verbosity?: 'low' | 'medium' | 'high'; format?: ResponseTextFormat; [k: string]: unknown };

/** One item of the model's answer: a message, a function call, or anything else the endpoint returns. */
export type ResponseOutputMessage = { type: 'message'; id?: string; role?: string; content?: { type: 'output_text' | 'refusal'; text: string; annotations?: unknown[] }[]; [k: string]: unknown };
export type ResponseFunctionCall = { type: 'function_call'; id?: string; call_id?: string; name: string; arguments: string; [k: string]: unknown };
export type ResponseOutputItem =
  | ResponseOutputMessage
  | ResponseFunctionCall
  | { type: 'reasoning'; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

/** Whether an output item is a function call, so an app can answer it with a `function_call_output` turn. */
export const isFunctionCall = (item: ResponseOutputItem): item is ResponseFunctionCall =>
  isRecord(item) && item.type === 'function_call' && typeof item.name === 'string' && typeof item.arguments === 'string';

/** The model's answer: the text (`onText` saw it piece by piece) and every output item. */
export type ResponseResult = { text: string; output: ResponseOutputItem[] };

/** What streams besides the words: each text piece, each tool call as it builds and lands, and each output item. */
export type ResponseStreamEvent =
  | { type: 'incomplete'; reason: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'function_call_delta'; name?: string; callId?: string; delta: string }
  | { type: 'function_call'; name: string; arguments: string; callId?: string }
  | { type: 'output_item'; item: ResponseOutputItem };

/** Reads a streamed answer (fixtures/conformance/sse.json): `push` each piece as it arrives, `end` for the whole text,
 *  `result` for the text with every output item. `onEvent` sees each tool call and output item as it lands.
 *  Events split on any blank line (LF, CRLF or bare CR). A data line that is not JSON throws a ResponseError;
 *  a stream ending with nothing to show throws too. The text is the streamed deltas; the completed envelope
 *  only fills in when no deltas arrived. An error event throws a ResponseError. An incomplete answer
 *  emits an incomplete event and throws IncompleteError with its reason and partial result. */
export function sseReader(onText?: (delta: string) => void, onEvent?: (event: ResponseStreamEvent) => void) {
  let buffer = '', text = '', completed: string | undefined;
  let done = false, finished: ResponseResult | undefined;
  let incomplete: string | undefined;
  const output: ResponseOutputItem[] = [];
  const emitted = new Set<string>();
  const calls = new Map<string, { name?: string; callId?: string; args: string }>();
  const callKey = (e: Record<string, any>): string =>
    typeof e.item_id === 'string' ? e.item_id : `index:${String(e.output_index ?? 0)}`;
  const land = (item: unknown, fallback: string | number) => {
    if (!isRecord(item) || typeof item.type !== 'string') return;
    const key = itemKey(item, fallback);
    if (emitted.has(key)) return;
    emitted.add(key);
    output.push(item as ResponseOutputItem);
    onEvent?.({ type: 'output_item', item: item as ResponseOutputItem });
    if (item.type === 'function_call' && typeof item.name === 'string' && typeof item.arguments === 'string')
      onEvent?.({ type: 'function_call', name: item.name, arguments: item.arguments, callId: typeof item.call_id === 'string' ? item.call_id : undefined });
  };
  const event = (block: string) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let e: any;
    try { e = JSON.parse(data); } catch { throw new ResponseError("ChatGPT's answer could not be read.", null); }
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') {
      text += e.delta;
      onText?.(e.delta);
      onEvent?.({ type: 'text_delta', delta: e.delta });
    }
    if (e.type === 'response.output_item.added' && isRecord(e.item)) {
      const key = typeof e.item.call_id === 'string' ? e.item.call_id : callKey(e);
      const at = calls.get(key) ?? { args: '' };
      if (typeof e.item.name === 'string') at.name = e.item.name;
      if (typeof e.item.call_id === 'string') at.callId = e.item.call_id;
      calls.set(key, at);
    }
    if (e.type === 'response.function_call_arguments.delta' && typeof e.delta === 'string') {
      const at = calls.get(callKey(e)) ?? { args: '' };
      at.args += e.delta;
      calls.set(callKey(e), at);
      onEvent?.({ type: 'function_call_delta', name: at.name, callId: at.callId, delta: e.delta });
    }
    if (e.type === 'response.output_item.done' && isRecord(e.item)) {
      if (e.item.type === 'function_call' && typeof e.item.arguments !== 'string') {
        const at = calls.get(callKey(e));
        if (at && at.args) e.item = { ...e.item, arguments: at.args };
      }
      land(e.item, e.output_index ?? 0);
    }
    if (e.type === 'response.completed' || e.type === 'response.incomplete' || e.response?.status === 'incomplete') {
      done = true;
      if (Array.isArray(e.response?.output)) {
        for (const [i, item] of e.response.output.entries()) land(item, i);
        completed = e.response.output.flatMap((o: any) => o?.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text ?? '').join('');
      }
    }
    if ((e.type === 'response.incomplete' || e.response?.status === 'incomplete') && incomplete === undefined) {
      const reason: string = typeof e.response?.incomplete_details?.reason === 'string' ? e.response.incomplete_details.reason : 'unknown';
      incomplete = reason;
      onEvent?.({ type: 'incomplete', reason });
    }
    const failed = e.type === 'error' ? e : e.type === 'response.failed' ? e.response?.error : undefined;
    if (failed) {
      const message = String(failed.message ?? 'Request failed');
      const c = classify(message);
      throw new ResponseError(message, limitKind(String(failed.code ?? failed.type ?? '')) ?? c?.kind ?? null, c?.until ?? 0);
    }
  };
  const drain = (final: boolean) => {
    // A trailing CR may be a bare-CR line ending or half of a chunk-split CRLF: hold it until more arrives.
    let tail = '';
    if (!final && buffer.endsWith('\r')) { tail = '\r'; buffer = buffer.slice(0, -1); }
    const blocks = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n\n');
    buffer = (final ? '' : blocks.pop()!) + tail;
    for (const b of blocks) event(b);
  };
  const finish = (): ResponseResult => {
    if (!finished) {
      drain(true);
      if (!done) throw new ResponseError('ChatGPT stopped before completing its answer.', 'network');
      const whole = text !== '' ? text : (completed ?? '');
      if (incomplete === undefined && whole === '' && output.length === 0) throw new ResponseError('ChatGPT stopped before completing its answer.', 'network');
      if (text === '' && whole !== '') onText?.(whole);
      finished = { text: whole, output };
    }
    if (incomplete !== undefined) throw new IncompleteError(incomplete, finished);
    return finished;
  };
  return {
    push(chunk: string) { buffer += chunk; drain(false); },
    end() { return finish().text; },
    result() { return finish(); },
  };
}

export type Ask = {
  /** What the model is told to be. */
  instructions: string;
  /** The person's words, or the turns so far: messages (with `input_image` where the person attached one) and, after a
   *  tool call, the `function_call` with its `function_call_output`. */
  input: string | ResponseInputItem[];
  /** Default: the provider's strong model in the catalogue. */
  model?: string;
  /** The tools the model may call. Passed, the result carries the output items next to the text. */
  tools?: ResponseTool[];
  /** Whether ChatGPT may call tools in parallel. Omitted: the provider's default. */
  parallelToolCalls?: boolean;
  /** Which tool the model must use. Default: whatever it wants. */
  tool_choice?: ResponseToolChoice;
  /** How hard the model thinks. Default: none. */
  reasoning?: ResponseReasoning;
  /** How wordy the answer is, and the schema it must follow. Default: low verbosity, free text. */
  text?: ResponseText;
  /** Each piece of the answer as it streams. */
  onText?: (delta: string) => void;
  /** Each text piece, tool call, output item, and incomplete answer notification. */
  onEvent?: (event: ResponseStreamEvent) => void;
  signal?: AbortSignal;
  /** The app's own originator header value. Default: 'byokit'. */
  originator?: string;
};

type Access = { access: string; accountId: string; model: string; base?: string; fetch?: typeof fetch };

/** Ask ChatGPT with a signed-in token. `fetch`: pass one that streams (Expo's `expo/fetch`); any fetch works.
 *  Without `tools` the answer is the plain text, as before; with `tools` it is the text with every output item.
 *  Incomplete answers always throw IncompleteError and notify onEvent, including with tools. */
export async function respond(o: Ask & Access & { tools?: undefined }): Promise<string>;
export async function respond(o: Ask & Access & { tools: ResponseTool[] }): Promise<ResponseResult>;
export async function respond(o: Ask & Access): Promise<string | ResponseResult> {
  const input: ResponseInputItem[] = typeof o.input === 'string'
    ? [{ role: 'user', content: [{ type: 'input_text', text: o.input }] }]
    : o.input;
  const { verbosity = 'low', format, ...textRest } = o.text ?? {};
  const { effort = 'none', ...reasoningRest } = o.reasoning ?? {};
  const res = await (o.fetch ?? fetch)(`${o.base ?? 'https://chatgpt.com/backend-api'}/codex/responses`, {
    method: 'POST', signal: o.signal,
    headers: {
      'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${o.access}`,
      'chatgpt-account-id': o.accountId, 'OpenAI-Beta': 'responses=experimental', originator: o.originator ?? 'byokit',
    },
    body: JSON.stringify({
      model: o.model, store: false, stream: true, instructions: o.instructions, input,
      ...(o.tools ? { tools: o.tools } : {}),
      ...(o.parallelToolCalls !== undefined ? { parallel_tool_calls: o.parallelToolCalls } : {}),
      ...(o.tool_choice !== undefined ? { tool_choice: o.tool_choice } : {}),
      text: { verbosity, ...(format ? { format } : {}), ...textRest },
      reasoning: { effort, ...reasoningRest },
    }),
  });
  if (!res.ok) {
    const e = limitResponse(res.status, await res.text().catch(() => ''));
    throw new ResponseError(e.message, e.kind, e.until ?? 0);
  }
  const reader = sseReader(o.onText, o.onEvent);
  const body = (res as any).body;
  if (res.headers?.get('content-type')?.includes('application/json')) {
    let response: unknown;
    try { response = JSON.parse(await res.text()); } catch { throw new ResponseError("ChatGPT's answer could not be read.", null); }
    const type = isRecord(response) ? `response.${String(response.status)}` : '';
    reader.push(`data: ${JSON.stringify({ type, response })}\n\n`);
  } else if (body?.getReader && typeof TextDecoder !== 'undefined') {
    const r = body.getReader();
    const decoder = new TextDecoder();
    for (let c = await r.read(); !c.done; c = await r.read()) reader.push(typeof c.value === 'string' ? c.value : decoder.decode(c.value, { stream: true }));
  } else {
    reader.push(await res.text()); // a fetch that can't stream: the whole answer at once
  }
  return o.tools ? reader.result() : reader.end();
}
