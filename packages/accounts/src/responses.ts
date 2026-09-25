// One question to ChatGPT, answered as it streams, with fetch alone: what a phone or browser app asks the model with
// the sign-in it holds. Rules are the shared fixtures (sse.json, limit-responses.json). A fetch that can't stream (React
// Native's own) still works: the whole answer arrives at once. Expo's `fetch` from 'expo/fetch' streams.
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

/** Reads a streamed answer (fixtures/conformance/sse.json): `push` each piece as it arrives, `end` for the whole text.
 *  An error event throws a ResponseError. */
export function sseReader(onText?: (delta: string) => void) {
  let buffer = '', text = '', completed: string | undefined;
  let done = false;
  const event = (block: string) => {
    const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data || data === '[DONE]') return;
    let e: any;
    try { e = JSON.parse(data); } catch { return; }
    if (e.type === 'response.output_text.delta' && typeof e.delta === 'string') { text += e.delta; onText?.(e.delta); }
    if (e.type === 'response.completed') {
      done = true;
      if (Array.isArray(e.response?.output)) completed = e.response.output.flatMap((o: any) => o?.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text ?? '').join('');
    }
    const failed = e.type === 'error' ? e : e.type === 'response.failed' ? e.response?.error : undefined;
    if (failed) {
      const message = String(failed.message ?? 'Request failed');
      const c = classify(message);
      throw new ResponseError(message, limitKind(String(failed.code ?? failed.type ?? '')) ?? c?.kind ?? null, c?.until ?? 0);
    }
  };
  const drain = (final: boolean) => {
    const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
    buffer = final ? '' : blocks.pop()!;
    for (const b of blocks) event(b);
  };
  return {
    push(chunk: string) { buffer += chunk; drain(false); },
    end() {
      drain(true);
      if (!done) throw new ResponseError('ChatGPT stopped before completing its answer.', 'network');
      if (completed !== undefined && completed !== text) {
        if (completed.startsWith(text)) onText?.(completed.slice(text.length));
        return completed;
      }
      return text;
    },
  };
}

export type Ask = {
  /** What the model is told to be. */
  instructions: string;
  /** The person's words. */
  input: string;
  /** Default: the provider's strong model in the catalogue. */
  model?: string;
  /** Each piece of the answer as it streams. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
};

/** Ask ChatGPT with a signed-in token. `fetch`: pass one that streams (Expo's `expo/fetch`); any fetch works. */
export async function respond(o: Ask & { access: string; accountId: string; model: string; base?: string; fetch?: typeof fetch }): Promise<string> {
  const res = await (o.fetch ?? fetch)(`${o.base ?? 'https://chatgpt.com/backend-api'}/codex/responses`, {
    method: 'POST', signal: o.signal,
    headers: {
      'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${o.access}`,
      'chatgpt-account-id': o.accountId, 'OpenAI-Beta': 'responses=experimental', originator: 'byokit',
    },
    body: JSON.stringify({
      model: o.model, store: false, stream: true, instructions: o.instructions,
      input: [{ role: 'user', content: [{ type: 'input_text', text: o.input }] }],
      text: { verbosity: 'low' }, reasoning: { effort: 'none' },
    }),
  });
  if (!res.ok) {
    const e = limitResponse(res.status, await res.text().catch(() => ''));
    throw new ResponseError(e.message, e.kind, e.until ?? 0);
  }
  const reader = sseReader(o.onText);
  const body = (res as any).body;
  if (body?.getReader && typeof TextDecoder !== 'undefined') {
    const r = body.getReader();
    const decoder = new TextDecoder();
    for (let c = await r.read(); !c.done; c = await r.read()) reader.push(typeof c.value === 'string' ? c.value : decoder.decode(c.value, { stream: true }));
  } else {
    reader.push(await res.text()); // a fetch that can't stream: the whole answer at once
  }
  return reader.end();
}
