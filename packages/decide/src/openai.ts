// OpenAI general models used for decisions, not a dedicated decision model. Probabilities are self-reported.
import type { ResponseCreateParams, ResponseTextConfig } from 'openai/resources/responses/responses';
import { UnsupportedAccountError } from './account-error.ts';
import type { ChatGPTPlanAccount, ChatGPTRespondAccount } from '@byokit/accounts/chatgpt-plan';
import type { Ask } from '@byokit/accounts';
import type { Backend } from './core.ts';
import { normalizeImages, validateImageReferences, UnsupportedImagesError } from './images.ts';
import { retryFetch, type RetryOptions } from './http.ts';
import { responsesAnswers, responsesInput, responsesInstructions, responsesSchema, isJsonRecord, readResponsesStream } from './responses-wire.ts';

export { UnsupportedAccountError } from './account-error.ts';
/** All SDK request options except the fields generated from typed questions. Extra instructions and text
 * options pass through; the backend owns model, input, and text.format. Account usage further restricts options. */
export type OpenAIRequestOptions = Omit<ResponseCreateParams, 'model' | 'input' | 'text'> & {
  text?: Omit<ResponseTextConfig, 'format'>;
};
export type OpenAIAccount = ChatGPTPlanAccount | ChatGPTRespondAccount;
export type OpenAIOptions = RetryOptions & {
  model: string;
  fetch?: typeof fetch;
  request?: OpenAIRequestOptions;
  /** Host declares the selected model supports vision; absent means text only. */
  supportsImages?: boolean;
} & ({ auth?: 'apiKey'; key: string; account?: never } | { auth: 'account'; account: OpenAIAccount; key?: never });

export const OPENAI_ROUTES = {
  apiKey: { billing: 'api', offer: false },
  account: { billing: 'subscription', offer: true, consentRequired: true },
} as const;

const BASE = 'https://api.openai.com/v1';
const unsupportedFields = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata',
  'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature',
  'top_logprobs', 'top_p', 'truncation', 'user'];
const codexFields = new Set(['instructions', 'text', 'reasoning', 'tools', 'tool_choice', 'parallel_tool_calls', 'store', 'stream']);

/** One consented ChatGPT plan or an explicitly supplied API key. Never falls back between billing routes. */
export function openai(o: OpenAIOptions): Backend {
  if (typeof o.model !== 'string' || !o.model.trim()) throw new Error('openai needs an explicit model');
  if (o.auth !== undefined && o.auth !== 'apiKey' && o.auth !== 'account') throw new Error('openai auth must be apiKey or account');
  const account = o.auth === 'account' ? o.account : undefined;
  const responder = account && 'respond' in account ? account : undefined;
  const shared = account && 'access' in account ? account : undefined;
  if (o.auth === 'account' && (!account || account.billing !== 'subscription' ||
      (typeof responder?.respond !== 'function' && typeof shared?.access !== 'function'))) {
    throw new UnsupportedAccountError('ChatGPT plan usage needs an account session from the @byokit/accounts peer (install it to use auth: "account").');
  }
  // A tagged handle only reaches its own provider; an untagged one predates tags and is still accepted.
  const tag = (account as { provider?: unknown } | undefined)?.provider;
  if (o.auth === 'account' && tag !== undefined && tag !== 'chatgpt') {
    throw new UnsupportedAccountError('ChatGPT plan usage needs a ChatGPT plan account.');
  }
  if (!account && (typeof o.key !== 'string' || !o.key.trim())) throw new Error('openai needs a key');
  const request = o.request ?? {};
  if (account && ((responder ? Object.keys(request).some((k) => !codexFields.has(k) && (request as Record<string, unknown>)[k] !== undefined)
      : unsupportedFields.some((k) => (request as Record<string, unknown>)[k] !== undefined)) ||
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
      const instructions = responsesInstructions(questions, request.instructions as string | undefined);
      const input = responsesInput(state, questions, images);
      const text = { ...request.text, format: { type: 'json_schema' as const, name: 'decisions', strict: true, schema: responsesSchema(questions) } };
      if (responder) {
        const result = await responder.respond({ model: o.model, instructions, input,
          text: { ...text, verbosity: text.verbosity ?? undefined }, signal, result: true,
          ...(request.reasoning && { reasoning: request.reasoning as Ask['reasoning'] }),
          ...(request.tools && { tools: request.tools as Ask['tools'] }),
          ...(request.tool_choice != null && { tool_choice: request.tool_choice as Ask['tool_choice'] }),
          ...(request.parallel_tool_calls != null && { parallelToolCalls: request.parallel_tool_calls }) });
        return responsesAnswers(questions, { status: 'completed', ...result }, result.text);
      }
      const token = shared ? await shared.access(signal) : o.key!;
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
      if (account) {
        const catalog = await send(`${BASE}/models`, { headers, signal });
        if (!catalog.ok) {
          if ([400, 401, 403].includes(catalog.status)) throw new UnsupportedAccountError(`ChatGPT plan model catalogue unavailable (http ${catalog.status}).`);
          throw new Error(`http ${catalog.status}`);
        }
        const models: unknown = await catalog.json();
        if (!isJsonRecord(models) || !Array.isArray(models.models) ||
            !models.models.some((m: unknown) => isJsonRecord(m) && m.slug === o.model && m.visibility === 'list')) {
          throw new UnsupportedAccountError('The chosen model is unavailable to this ChatGPT account.');
        }
      }
      const body = {
        ...request,
        model: o.model,
        instructions, input, text,
        ...(account && { store: false, stream: true }),
      };
      const res = await send(`${BASE}/responses`, { method: 'POST', signal, headers, body: JSON.stringify(body) });
      if (!res.ok) {
        if (account && [400, 401, 403, 404].includes(res.status)) {
          throw new UnsupportedAccountError(`ChatGPT plan request unsupported (http ${res.status}).`);
        }
        throw new Error(`http ${res.status}`);
      }
      const json: unknown = body.stream ? await readResponsesStream(res) : await res.json();
      if (account && isJsonRecord(json) && isJsonRecord(json.error) &&
          ['subscription_sharing_usage_unavailable', 'subscription_sharing_usage_limit_exceeded', 'model_not_found'].includes(json.error.code)) {
        throw new UnsupportedAccountError('ChatGPT plan usage is unavailable for this request.');
      }
      return responsesAnswers(questions, json);
    },
  };
}
