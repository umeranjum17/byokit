// Google's v1internal streaming service in the pinned Pi stream shape (fixtures/conformance/pi-streams.json, family
// `code-assist` and `codeAssistRefusals`). The access token is only ever a request header: never in an event, error or log.
import { ResponseError } from '../responses.ts';
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model } from '@earendil-works/pi-ai';

/** Cloud Code Assist hosts, keyed by Pi provider id. */
export const CODE_ASSIST_HOSTS: Record<string, string> = { 'google-gemini-cli': 'https://cloudcode-pa.googleapis.com' };
/** A 403 tier refusal: this account's plan does not include the requested Code Assist use. */
export class CodeAssistTierError extends Error { readonly code = 'not_included' as const; constructor() { super('This Google account’s plan does not include Code Assist for this request. Try another account.'); this.name = 'CodeAssistTierError'; } }
/** A 401 that a fresh access token did not clear: the sign-in is no longer valid. */
export class CodeAssistSignedOutError extends ResponseError { constructor() { super('Sign in with Google again.', 'signed_out'); this.name = 'CodeAssistSignedOutError'; } }
/** Internal: the access token was refused once (401); the caller refreshes once and retries. */
export class CodeAssistUnauthorizedError extends Error { constructor() { super('Google refused this access token once.'); this.name = 'CodeAssistUnauthorizedError'; } }

export type CodeAssistAsk = {
  access: string; project: string; model: Model<Api>; context: Context; base: string;
  fetch?: typeof fetch; signal?: AbortSignal; onText?: (delta: string) => void; onEvent?: (event: AssistantMessageEvent) => void;
};

const zeroUsage = (): AssistantMessage['usage'] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const usageOf = (meta: any): AssistantMessage['usage'] => ({ input: Number(meta?.promptTokenCount ?? 0),
  output: Number(meta?.candidatesTokenCount ?? 0), cacheRead: 0, cacheWrite: 0, totalTokens: Number(meta?.totalTokenCount ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
/** Each frame is the Code Assist envelope (`{ response: … }`); a bare candidate list is read too. */
const responseOf = (frame: any) => frame?.response ?? frame;
const textOf = (frame: any): string => {
  const parts = responseOf(frame)?.candidates?.[0]?.content?.parts;
  return Array.isArray(parts) ? parts.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('') : '';
};
const body = (ask: CodeAssistAsk) => JSON.stringify({ project: ask.project, model: ask.model.id, request: {
  contents: ask.context.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : m.content.map((c: any) => c.text ?? '').join('') }] })),
  ...(ask.context.systemPrompt ? { systemInstruction: { parts: [{ text: ask.context.systemPrompt }] } } : {}) } });

/** POST `{base}/v1internal:streamGenerateContent?alt=sse` with the stored project and access token, and read the SSE
 *  frames as they arrive into the pinned Pi stream: start, text_start/text_delta/text_end and a done with usage. A 403
 *  is the typed tier refusal; a 401 is the internal unauthorized error for the caller to refresh once. */
export async function codeAssistStream(ask: CodeAssistAsk): Promise<AssistantMessage> {
  const message: AssistantMessage = { role: 'assistant', content: [], api: ask.model.api, provider: ask.model.provider,
    model: ask.model.id, usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now() };
  const emit = (event: AssistantMessageEvent) => ask.onEvent?.(event);
  let res: Response;
  try {
    res = await (ask.fetch ?? fetch)(`${ask.base.replace(/\/+$/, '')}/v1internal:streamGenerateContent?alt=sse`,
      { method: 'POST', signal: ask.signal, headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${ask.access}` }, body: body(ask) });
  } catch { throw new ResponseError('Google could not answer on this connection. Try again.', 'network'); }
  if (res.status === 401) throw new CodeAssistUnauthorizedError();
  if (res.status === 403) throw new CodeAssistTierError();
  if (!res.ok) throw new ResponseError('Google could not answer this request. Try again.', null, 0, { status: res.status });
  emit({ type: 'start', partial: message });
  let said = '', buffer = '';
  const frame = (parsed: any) => {
    const delta = textOf(parsed);
    if (delta) {
      if (!said) emit({ type: 'text_start', contentIndex: 0, partial: message });
      said += delta;
      message.content = [{ type: 'text', text: said }];
      ask.onText?.(delta);
      emit({ type: 'text_delta', contentIndex: 0, delta, partial: message });
    }
    const meta = responseOf(parsed)?.usageMetadata;
    if (meta) message.usage = usageOf(meta);
  };
  const drain = (final: boolean) => {
    // Hold a trailing CR: a bare-CR line ending, or half of a chunk-split CRLF that the next chunk finishes.
    let tail = '';
    if (!final && buffer.endsWith('\r')) { tail = '\r'; buffer = buffer.slice(0, -1); }
    const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n');
    buffer = (final ? '' : blocks.pop()!) + tail;
    for (const block of blocks) {
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^\s/, '')).join('');
      if (!data || data === '[DONE]') continue;
      let parsed: any;
      try { parsed = JSON.parse(data); } catch { throw new ResponseError("Google's answer could not be read.", 'network'); }
      frame(parsed);
    }
  };
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader?.();
  if (reader) {
    const decoder = new TextDecoder();
    for (let c = await reader.read(); !c.done; c = await reader.read()) { buffer += decoder.decode(c.value, { stream: true }); drain(false); }
    buffer += decoder.decode();
  } else buffer = await res.text();
  drain(true);
  if (said) emit({ type: 'text_end', contentIndex: 0, content: said, partial: message });
  message.stopReason = 'stop';
  emit({ type: 'done', reason: 'stop', message });
  return message;
}
