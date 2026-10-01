// OpenAI general models used for decisions, not a dedicated decision model. Probabilities are self-reported.
import type { ResponseCreateParams, ResponseTextConfig } from 'openai/resources/responses/responses';
import { UnsupportedAccountError, type ChatGPTPlanAccount } from '@byokit/accounts/chatgpt-plan';
import type { Backend, Question, Raw } from './index.ts';
import { normalizeImages, validateImageReferences, UnsupportedImagesError } from './images.ts';
import { parseUsage, retryFetch, type RetryOptions } from './http.ts';
import { STATE_INSTRUCTIONS } from './prompt.ts';

export { UnsupportedAccountError } from '@byokit/accounts/chatgpt-plan';
/** All SDK request options except the fields generated from typed questions. Extra instructions and text
 * options pass through; the backend owns model, input, and text.format. Account usage further restricts options. */
export type OpenAIRequestOptions = Omit<ResponseCreateParams, 'model' | 'input' | 'text'> & {
  text?: Omit<ResponseTextConfig, 'format'>;
};
export type OpenAIOptions = RetryOptions & {
  model: string;
  fetch?: typeof fetch;
  request?: OpenAIRequestOptions;
  /** Host declares the selected model supports vision; absent means text only. */
  supportsImages?: boolean;
} & ({ auth?: 'apiKey'; key: string; account?: never } | { auth: 'account'; account: ChatGPTPlanAccount; key?: never });

export const OPENAI_ROUTES = {
  apiKey: { billing: 'api', offer: false },
  account: { billing: 'subscription', offer: true, consentRequired: true },
} as const;

const BASE = 'https://api.openai.com/v1';
const unsupportedFields = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user'];

/** One consented ChatGPT plan or an explicitly supplied API key. Never falls back between billing routes. */
export function openai(o: OpenAIOptions): Backend {
  if (typeof o.model !== 'string' || !o.model.trim()) throw new Error('openai needs an explicit model');
  if (o.auth !== undefined && o.auth !== 'apiKey' && o.auth !== 'account') throw new Error('openai auth must be apiKey or account');
  const account = o.auth === 'account' ? o.account : undefined;
  if (o.auth === 'account' && (!account || account.billing !== 'subscription' || typeof account.access !== 'function')) {
    throw new UnsupportedAccountError('ChatGPT plan usage needs an account session.');
  }
  if (!account && (typeof o.key !== 'string' || !o.key.trim())) throw new Error('openai needs a key');
  const request = o.request ?? {};
  if (account && (unsupportedFields.some((k) => (request as Record<string, unknown>)[k] !== undefined) ||
      request.stream === false || request.store === true)) {
    throw new UnsupportedAccountError('These request options are unsupported for ChatGPT plan usage.');
  }
  const send = retryFetch('openai', o.fetch ?? globalThis.fetch, o);
  return {
    name: 'openai', leaves: true, supportsImages: o.supportsImages === true,
    async ask(state, questions, signal, inputImages = []) {
      const images = normalizeImages(inputImages);
      validateImageReferences(questions, images);
      if (images.length && !o.supportsImages) throw new UnsupportedImagesError(o.model);
      const token = account ? await account.access(signal) : o.key!;
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      if (account) {
        const catalog = await send(`${BASE}/models`, { headers, signal });
        if (!catalog.ok) {
          if ([400, 401, 403].includes(catalog.status)) throw new UnsupportedAccountError(`ChatGPT plan model catalogue unavailable (http ${catalog.status}).`);
          throw new Error(`http ${catalog.status}`);
        }
        const models: unknown = await catalog.json();
        if (!isRecord(models) || !Array.isArray(models.models) ||
            !models.models.some((m: unknown) => isRecord(m) && m.slug === o.model && m.visibility === 'list')) {
          throw new UnsupportedAccountError('The chosen model is unavailable to this ChatGPT account.');
        }
      }
      const body = {
        ...request,
        model: o.model,
        instructions: STATE_INSTRUCTIONS +
          'Give every answer key a self-reported probability between 0 and 1, summing to 1 per question, and pick one key. ' +
          'Include a short rationale per question. These are your estimates, not calibrated confidence scores.' + (request.instructions ? `\n${request.instructions}` : ''),
        input: [{ role: 'user', content: images.length ? [
          { type: 'input_text', text: JSON.stringify({ state, questions, images: images.map(({ id, mime }) => ({ id, mime })) }) },
          ...images.flatMap((image) => [
            { type: 'input_text', text: `Image: ${image.id}` },
            { type: 'input_image', image_url: image.dataUrl, detail: 'auto' },
          ]),
        ] : JSON.stringify({ state, questions }) }],
        text: { ...request.text, format: { type: 'json_schema', name: 'decisions', strict: true, schema: schema(questions) } },
        ...(account && { store: false, stream: true }),
      };
      const res = await send(`${BASE}/responses`, { method: 'POST', signal, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        if (account && [400, 401, 403, 404].includes(res.status)) {
          throw new UnsupportedAccountError(`ChatGPT plan request unsupported (http ${res.status}).`);
        }
        throw new Error(`http ${res.status}`);
      }
      const json: unknown = body.stream ? await readStream(res) : await res.json();
      if (account && isRecord(json) && isRecord(json.error) &&
          ['subscription_sharing_usage_unavailable', 'subscription_sharing_usage_limit_exceeded', 'model_not_found'].includes(json.error.code)) {
        throw new UnsupportedAccountError('ChatGPT plan usage is unavailable for this request.');
      }
      return answers(questions, json);
    },
  };
}

function schema(questions: Record<string, Question>) {
  const properties = Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    const keys = q.kind === 'choice' ? Object.keys(q.options) : q.kind === 'yesno' ? ['true', 'false'] : q.levels.map((_, i) => String(i));
    return [name, { type: 'object', additionalProperties: false, required: ['probabilities', 'pick', 'rationale'],
      properties: {
        probabilities: { type: 'object', additionalProperties: false, required: keys,
          properties: Object.fromEntries(keys.map((k) => [k, { type: 'number', minimum: 0, maximum: 1 }])) },
        pick: { type: 'string', enum: keys },
        rationale: { type: 'string' },
      },
    }];
  }));
  return { type: 'object', additionalProperties: false, required: Object.keys(questions), properties };
}

const isRecord = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);

function answers(questions: Record<string, Question>, json: unknown): Record<string, Raw> {
  const usage = parseUsage(isRecord(json) ? json.usage : undefined);
  let parsed: unknown;
  if (isRecord(json) && json.status === 'completed' && Array.isArray(json.output) && !json.error) {
    const contents = json.output.filter((item: unknown) => isRecord(item) && item.type === 'message')
      .flatMap((item: any) => Array.isArray(item.content) ? item.content : []);
    if (!contents.some((c: unknown) => isRecord(c) && c.type === 'refusal')) {
      const text = contents.filter((c: unknown) => isRecord(c) && c.type === 'output_text' && typeof c.text === 'string')
        .map((c: any) => c.text).join('');
      try { parsed = JSON.parse(text); } catch { /* malformed text abstains, carrying the response */ }
    }
  }
  return Object.fromEntries(Object.keys(questions).map((k) => {
    const a = isRecord(parsed) && Object.hasOwn(parsed, k) ? parsed[k] : undefined;
    const valid = isRecord(a) && isRecord(a.probabilities) && typeof a.pick === 'string';
    return [k, { probabilities: valid ? a.probabilities : {}, ...(valid && { pick: a.pick }), ...(typeof a?.rationale === 'string' && { rationale: a.rationale }),
      confidenceSource: 'self-reported', ...(usage && { usage }), raw: json } satisfies Raw];
  }));
}

/** Keep the completed full response (including usage), never infer success from text deltas. Handles chunk
 * boundaries, CRLF, multiline data and the non-streaming fetch fallback used on phones. */
async function readStream(res: Response): Promise<unknown> {
  const events: unknown[] = [];
  let terminal: Record<string, any> | undefined;
  let last: Record<string, any> | undefined;
  let malformed = false;
  const event = (frame: string) => {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let e: unknown;
    try { e = JSON.parse(data); } catch { malformed = true; return; }
    events.push(e);
    if (!isRecord(e)) { malformed = true; return; }
    if (isRecord(e.response)) last = e.response;
    if (['response.completed', 'response.failed', 'response.incomplete'].includes(e.type)) {
      if (terminal || !isRecord(e.response)) malformed = true;
      else terminal = { ...e.response, status: e.type === 'response.completed' ? e.response.status : e.type.slice(9) };
    }
    if (e.type === 'error') malformed = true;
  };
  let pending = '';
  const push = (chunk: string) => {
    pending += chunk;
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      event(pending.slice(0, match.index));
      pending = pending.slice(match.index + match[0].length);
    }
  };
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        push(decoder.decode(part.value, { stream: true }));
      }
      push(decoder.decode());
    } finally { reader.releaseLock(); }
  } else push(await res.text());
  if (pending.trim()) event(pending);
  if (terminal && !malformed) return terminal;
  return { status: 'incomplete', ...(last?.usage && { usage: last.usage }), events };
}
