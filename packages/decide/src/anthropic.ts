// Anthropic general models used for decisions, not a dedicated decision model. Probabilities are self-reported.
// Structured answers cross as one forced `decisions` tool whose input schema is the shared Responses
// question schema; the parsed tool input reuses the shared Responses answer parser. API key only:
// there is no plan sign-in here and no fallback between billing routes.
import type { Backend, Question, Raw } from './core.ts';
import { normalizeImages, validateImageReferences, UnsupportedImagesError } from './images.ts';
import { parseUsage, retryFetch, type RetryOptions } from './http.ts';
import { isJsonRecord, parsedAnswers, responsesInstructions, responsesSchema } from './responses-wire.ts';

export type AnthropicOptions = RetryOptions & {
  model: string;
  /** The host's Anthropic API key. The kit never reads an environment variable for it. */
  key: string;
  fetch?: typeof fetch;
  /** Cap on the reply tokens (default 1024). The Messages API requires one. */
  maxTokens?: number;
  /** Extra host instructions appended to the decision prompt. */
  instructions?: string;
  /** Host declares the selected model supports vision; absent means text only. */
  supportsImages?: boolean;
};

export const ANTHROPIC_ROUTES = {
  apiKey: { billing: 'api', offer: false },
} as const;

const BASE = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

/** One explicitly supplied Anthropic API key. API-billed; never a plan sign-in. */
export function anthropic(o: AnthropicOptions): Backend {
  if (typeof o.model !== 'string' || !o.model.trim()) throw new Error('anthropic needs an explicit model');
  if (typeof o.key !== 'string' || !o.key.trim()) throw new Error('anthropic needs a key');
  if (o.maxTokens !== undefined && (!Number.isSafeInteger(o.maxTokens) || o.maxTokens <= 0)) {
    throw new Error('anthropic maxTokens must be a positive integer');
  }
  const send = retryFetch('anthropic', o.fetch ?? globalThis.fetch, o);
  return {
    name: 'anthropic', leaves: true, supportsImages: o.supportsImages === true,
    async ask(state, questions, signal, inputImages = []) {
      const images = normalizeImages(inputImages);
      validateImageReferences(questions, images);
      if (images.length && !o.supportsImages) throw new UnsupportedImagesError(o.model);
      const body = {
        model: o.model,
        max_tokens: o.maxTokens ?? 1024,
        system: responsesInstructions(questions, o.instructions),
        messages: [{ role: 'user' as const, content: [
          { type: 'text', text: JSON.stringify({ state, questions }) },
          ...images.flatMap((image) => [
            { type: 'text', text: `Image: ${image.id}` },
            { type: 'image', source: { type: 'base64', media_type: image.mime,
              data: image.dataUrl.slice(`data:${image.mime};base64,`.length) } },
          ]),
        ] }],
        tools: [{ name: 'decisions', description: 'Return every decision answer.', input_schema: responsesSchema(questions) }],
        tool_choice: { type: 'tool' as const, name: 'decisions' },
      };
      const res = await send(`${BASE}/messages`, { method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': o.key, 'anthropic-version': VERSION },
        body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const json: unknown = await res.json();
      return anthropicAnswers(questions, json);
    },
  };
}

/** A forced `decisions` tool input answers through the shared parsed-answer mapping; a refusal, a reply
 * without that tool use and malformed input abstain while keeping usage and the raw response. */
function anthropicAnswers(questions: Record<string, Question>, json: unknown): Record<string, Raw> {
  const usage = parseUsage(isJsonRecord(json) ? json.usage : undefined);
  const blocks = isJsonRecord(json) && Array.isArray(json.content) ? json.content : [];
  const refused = isJsonRecord(json) && (json.stop_reason === 'refusal' ||
    blocks.some((b) => isJsonRecord(b) && b.type === 'refusal'));
  const input = refused ? undefined : blocks.find((b): b is Record<string, any> =>
    isJsonRecord(b) && b.type === 'tool_use' && b.name === 'decisions' && isJsonRecord(b.input))?.input;
  return parsedAnswers(questions, input, usage, json);
}
